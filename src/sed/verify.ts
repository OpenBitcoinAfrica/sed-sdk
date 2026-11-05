import { getEventHash } from "nostr-tools/pure";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { type NostrEvent, type Result, HEX64, fail, ok } from "./common.js";

const HEX128 = /^[0-9a-f]{128}$/;

/**
 * SeD-06 phase 1: checks that an event's `id` really is the hash of its own
 * `kind`, `created_at`, `tags` and `content`, and that `sig` really is a
 * schnorr signature over that id made with `pubkey`.
 *
 * A successful `parse*` only means an event is well formed. This is the
 * check that makes it trustworthy: nothing in the event has been altered
 * since whoever holds the pubkey's private key signed it.
 *
 * This deliberately does not call nostr-tools' own `verifyEvent`. That
 * function caches its answer on a symbol property it sets on the event
 * object, and that property survives an object spread such as
 * `{ ...event, content: "something else" }`. A forged event built that way
 * from a genuinely signed one would carry the cached "verified" flag with
 * it, and `verifyEvent` would trust the cache instead of checking the
 * forgery. Recomputing the hash and the schnorr check here, independently
 * of that cache, closes that gap.
 */
export function verifyEventSignature(event: NostrEvent): Result<NostrEvent> {
  const errors: string[] = [];
  if (!HEX64.test(event.id)) errors.push('"id" must be 64 lowercase hex characters');
  if (!HEX64.test(event.pubkey)) errors.push('"pubkey" must be 64 lowercase hex characters');
  if (!HEX128.test(event.sig)) errors.push('"sig" must be 128 lowercase hex characters');
  if (errors.length) return fail(...errors);

  let expectedId: string;
  try {
    expectedId = getEventHash(event);
  } catch {
    return fail('event cannot be hashed: "kind", "created_at", "tags" or "content" has the wrong shape');
  }
  if (expectedId !== event.id) {
    return fail(`"id" does not match the hash of this event's own kind, created_at, tags and content (expected ${expectedId})`);
  }

  let signatureOk: boolean;
  try {
    signatureOk = schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return fail('"sig" is not a valid signature over this event by "pubkey"');
  }

  return ok(event);
}

/** Convenience wrapper over {@link verifyEventSignature} for callers that only need a yes or no. */
export function isEventSignatureValid(event: NostrEvent): boolean {
  return verifyEventSignature(event).ok;
}