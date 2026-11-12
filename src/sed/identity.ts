import { type CapabilitySignal } from "./signal.js";
import { type Result, HEX64, fail, ok } from "./common.js";

export interface ServiceIdentity {
  opkName: string;
  domain: string;
  opk: string;
  ipk: string;
}

export interface ResolveOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  expectedIpk?: string;
  cache?: NostrJsonCache;
}

export interface NostrJsonCache {
  get(domain: string): unknown;
  set(domain: string, body: unknown): void;
}

const DEFAULT_CACHE_MAX_ENTRIES = 1000;

export function createNostrJsonCache(options: {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
}): NostrJsonCache {
  const { ttlMs } = options;
  const maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be a positive number");
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive whole number");

  const entries = new Map<string, { body: unknown; expiresAt: number }>();
  return {
    get(domain) {
      const entry = entries.get(domain);
      if (entry === undefined) return undefined;
      if (now() >= entry.expiresAt) {
        entries.delete(domain);
        return undefined;
      }
      return entry.body;
    },
    set(domain, body) {
      entries.delete(domain);
      entries.set(domain, { body, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

const DEFAULT_TIMEOUT_MS = 5000;

function normalizeHex64(value: string): string | null {
  const lower = value.toLowerCase();
  return HEX64.test(lower) ? lower : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveServiceIdentity(
  domain: string,
  opkName: string,
  opk: string,
  options: ResolveOptions = {},
): Promise<Result<ServiceIdentity>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!HEX64.test(opk)) return fail('"opk" must be 64 lowercase hex characters');

  const expectedIpk = options.expectedIpk?.toLowerCase();
  if (expectedIpk !== undefined && !HEX64.test(expectedIpk)) {
    return fail('"expectedIpk" must be 64 hex characters');
  }

  const parsed = parseDomain(domain);
  if (!parsed.ok) return parsed;
  const url = parsed.value;
  domain = url.hostname;

  const check = (body: unknown): Result<ServiceIdentity> => {
    if (!isPlainObject(body) || !isPlainObject(body["names"])) {
      return fail(`nostr.json at ${domain} has no "names" object`);
    }

    const names = body["names"];

    const rawOpk = names[opkName];
    if (typeof rawOpk !== "string") {
      return fail(`nostr.json at ${domain} has no "${opkName}" entry under "names"`);
    }

    const fileOpk = normalizeHex64(rawOpk);
    if (fileOpk === null) {
      return fail(`"${opkName}" in nostr.json at ${domain} must be 64 hex characters`);
    }

    if (fileOpk !== opk) {
      return fail(`the "${opkName}" entry in nostr.json at ${domain} does not match the key that signed this event`);
    }

    const rawIpk = names["_"];
    if (typeof rawIpk !== "string") {
      return fail(`nostr.json at ${domain} has no "_" entry under "names"`);
    }

    const ipk = normalizeHex64(rawIpk);
    if (ipk === null) {
      return fail(`"_" in nostr.json at ${domain} must be 64 hex characters`);
    }
    if (expectedIpk !== undefined && ipk !== expectedIpk) {
      return fail(`the "_" entry in nostr.json at ${domain} is not the identity key that was expected for this service`);
    }

    if (ipk === fileOpk) {
      return fail(`"_" and "${opkName}" must not be the same key in nostr.json at ${domain}`);
    }

    return ok({ opkName, domain, opk: fileOpk, ipk });
  };

  const cached = options.cache?.get(domain);
  if (cached !== undefined) {
    const fromCache = check(cached);
    if (fromCache.ok) return fromCache;
  }

  let body: unknown;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    if (response.redirected || (response.url && response.url !== url.href)) {
      return fail(`${domain} redirected the request, and redirects are not followed`);
    }
    if (!response.ok) {
      return fail(`could not reach ${domain}: HTTP ${response.status}`);
    }
    body = await response.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return fail(`could not reach ${domain}: ${reason}`);
  }

  if (options.cache && isPlainObject(body) && isPlainObject(body["names"])) {
    options.cache.set(domain, body);
  }
  return check(body);
}

function parseDomain(domain: string): Result<URL> {
  const bad = () => fail(`"${domain}" is not a usable domain`);
  if (typeof domain !== "string" || domain === "" || domain.endsWith(".")) return bad();

  let url: URL;
  try {
    url = new URL(`https://${domain}/.well-known/nostr.json`);
  } catch {
    return bad();
  }

  if (url.hostname !== domain.toLowerCase()) return bad();
  if (url.port !== "" || url.username !== "" || url.password !== "") return bad();
  if (!url.hostname.includes(".")) return bad();
  if (/^[0-9.]+$/.test(url.hostname) || url.hostname.includes(":")) return bad();
  return ok(url);
}

export function resolveSignalIdentity(
  signal: Pick<CapabilitySignal, "domain" | "name" | "opk">,
  options?: ResolveOptions,
): Promise<Result<ServiceIdentity>> {
  return resolveServiceIdentity(signal.domain, signal.name, signal.opk, options);
}