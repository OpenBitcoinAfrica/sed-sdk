import { type NostrEvent, type Result, fail, nowSeconds, ok } from "./common.js";
import { type CapabilitySignal, isSignalLive, parseCapabilitySignal } from "./signal.js";
import { type ResolveOptions, type ServiceIdentity, resolveSignalIdentity } from "./identity.js";
import { type Revocation, isOpkRevoked } from "./revocation.js";
import { verifyEventSignature } from "./verify.js";

export interface TrustedSignal {
  signal: CapabilitySignal;
  identity: ServiceIdentity;
}

export async function resolveTrustedSignal(
  event: NostrEvent,
  revocations: Revocation[],
  now: number = nowSeconds(),
  options?: ResolveOptions,
): Promise<Result<TrustedSignal>> {
  const signed = verifyEventSignature(event);
  if (!signed.ok) return signed;

  const parsed = parseCapabilitySignal(signed.value);
  if (!parsed.ok) return parsed;

  if (!isSignalLive(parsed.value, now)) {
    return fail(`signal expired at ${parsed.value.expiration}, now is ${now}`);
  }

  const identity = await resolveSignalIdentity(parsed.value, options);
  if (!identity.ok) return identity;

  if (isOpkRevoked(parsed.value.opk, identity.value.ipk, revocations)) {
    return fail(`operational key ${parsed.value.opk} was revoked by ${identity.value.ipk}`);
  }

  return ok({ signal: parsed.value, identity: identity.value });
}