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
}

const DEFAULT_TIMEOUT_MS = 5000;

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

  if (typeof body !== "object" || body === null || !("names" in body)) {
    return fail(`nostr.json at ${domain} has no "names" object`);
  }
  const names = (body as { names: unknown }).names;
  if (typeof names !== "object" || names === null) {
    return fail(`nostr.json at ${domain} has no "names" object`);
  }

  const rawOpk = (names as Record<string, unknown>)[opkName];
  if (typeof rawOpk !== "string") {
    return fail(`nostr.json at ${domain} has no "${opkName}" entry under "names"`);
  }
  const fileOpk = rawOpk.toLowerCase();
  if (!HEX64.test(fileOpk)) {
    return fail(`"${opkName}" in nostr.json at ${domain} must be 64 hex characters`);
  }

  const rawIpk = (names as Record<string, unknown>)["_"];
  if (typeof rawIpk !== "string") {
    return fail(`nostr.json at ${domain} has no "_" entry under "names"`);
  }
  const ipk = rawIpk.toLowerCase();
  if (!HEX64.test(ipk)) {
    return fail(`"_" in nostr.json at ${domain} must be 64 hex characters`);
  }
  if (expectedIpk !== undefined && ipk !== expectedIpk) {
    return fail(`the "_" entry in nostr.json at ${domain} is not the identity key that was expected for this service`);
  }

  if (fileOpk !== opk.toLowerCase()) {
    return fail(`the "${opkName}" entry in nostr.json at ${domain} does not match the key that signed this event`);
  }
  if (ipk === fileOpk) {
    return fail(`"_" and "${opkName}" must not be the same key in nostr.json at ${domain}`);
  }

  return ok({ opkName, domain, opk: fileOpk, ipk });
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