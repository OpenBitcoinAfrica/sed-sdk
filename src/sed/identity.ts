import { type CapabilitySignal } from "./signal.js";
import { type Result, HEX64, fail, ok } from "./common.js";

export interface ServiceIdentity {
  opkName: string;
  domain: string;
  opk: string;
  ipk: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * SeD-01 section 1.2: confirms that an operational key is authorized to sign
 * for a service, and reads out the service's real identity key alongside it.
 *
 * Fetches `https://<domain>/.well-known/nostr.json`, checks that `opk`
 * matches whatever is listed under `opkName` in that file's `names` map,
 * and returns the `_` entry from the same file as the service's IPK.
 *
 * This only checks what the domain currently says. It does not know or care
 * whether that domain said something different yesterday: SeD-01 treats key
 * rotation as routine, so there is nothing to compare against here. A
 * caller that wants to notice when a service's identity key changes between
 * two calls has to keep that history itself; this function is stateless.
 */
export async function resolveServiceIdentity(
  domain: string,
  opkName: string,
  opk: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Result<ServiceIdentity>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!HEX64.test(opk)) return fail('"opk" must be 64 lowercase hex characters');

  let url: URL;
  try {
    url = new URL(`https://${domain}/.well-known/nostr.json`);
  } catch {
    return fail(`"${domain}" is not a usable domain`);
  }

  let body: unknown;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
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

  if (fileOpk !== opk.toLowerCase()) {
    return fail(`the "${opkName}" entry in nostr.json at ${domain} does not match the key that signed this event`);
  }
  if (ipk === fileOpk) {
    return fail(`"_" and "${opkName}" must not be the same key in nostr.json at ${domain}`);
  }

  return ok({ opkName, domain, opk: fileOpk, ipk });
}

/** Convenience wrapper that pulls the domain, name and OPK straight off an already-parsed capability signal. */
export function resolveSignalIdentity(
  signal: Pick<CapabilitySignal, "domain" | "name" | "opk">,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<Result<ServiceIdentity>> {
  return resolveServiceIdentity(signal.domain, signal.name, signal.opk, options);
}