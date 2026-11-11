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
  /** Previously trusted service IPK. When provided, resolution fails if the
   * domain's current `_` entry differs. The caller must retain this value
   * across calls; this function does not keep identity history. */
  expectedIpk?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The single case policy for keys in this module: hex keys are accepted in
 * any case and normalized to lowercase. Returns the lowercase key, or null
 * if the value is not 64 hex characters.
 */
export function normalizeHex64(value: string): string | null {
  const lower = value.toLowerCase();
  return HEX64.test(lower) ? lower : null;
}

/** True for a JSON object; false for null, arrays and primitives. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * SeD-01 section 1.2: confirms that an operational key is authorized to sign
 * for a service, and reads out the service's real identity key alongside it.
 *
 * Fetches `https://<domain>/.well-known/nostr.json`, checks that `opk`
 * matches whatever is listed under `opkName` in that file's `names` map,
 * and returns the `_` entry from the same file as the service's IPK.
 *
 * Keys are compared case-insensitively and returned in lowercase, whether
 * they come from the caller or from the file.
 * 
 * SeD-01 treats the IPK in `_` as the service's permanent identity; OPKs may
 * rotate, but a changed IPK is a red flag. This function is stateless and can
 * only compare the current value against a previously trusted IPK when the
 * caller supplies it as `expectedIpk`. Callers must retain that trusted value
 * (or otherwise keep identity history) across calls to detect a change.
 */
export async function resolveServiceIdentity(
  domain: string,
  opkName: string,
  opk: string,
  options: ResolveOptions = {},
): Promise<Result<ServiceIdentity>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const inputOpk = normalizeHex64(opk);
  if (inputOpk === null) return fail('"opk" must be 64 hex characters');

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

  if (fileOpk !== inputOpk) {
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
