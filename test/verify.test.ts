import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifiedSymbol } from "nostr-tools/pure";
import type { NostrEvent } from "../src/sed/common.js";
import { isEventSignatureValid, verifyEventSignature } from "../src/sed/verify.js";

const sk = generateSecretKey();
const T = 1782691200;

const sign = (tags: string[][] = [], content = "", kind = 30078): NostrEvent =>
  finalizeEvent({ kind, created_at: T, tags, content }, sk);

const flipLastHexChar = (hex: string): string => hex.slice(0, -1) + (hex.endsWith("0") ? "1" : "0");

// Our own NostrEvent type does not declare nostr-tools' internal cache symbol,
// so reading it back for this one test needs a loose cast.
const cachedVerifiedFlag = (event: unknown): boolean | undefined =>
  (event as Record<symbol, boolean | undefined>)[verifiedSymbol];

describe("verifyEventSignature: accepts a genuine event", () => {
  it("passes through a genuinely signed event", () => {
    const event = sign([["protocol", "sed"]], "hello");
    const r = verifyEventSignature(event);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(event);
  });

  it("works for a different signer and content too", () => {
    const other = generateSecretKey();
    const event = finalizeEvent({ kind: 30079, created_at: T, tags: [["protocol", "sed"]], content: "note" }, other);
    expect(verifyEventSignature(event)).toMatchObject({ ok: true });
  });
});

describe("verifyEventSignature: rejects a tampered event id or content", () => {
  it("rejects a tampered tag", () => {
    const event = sign([["protocol", "sed"]], "hello");
    const tampered = { ...event, tags: [["protocol", "evil"]] };
    expect(verifyEventSignature(tampered).ok).toBe(false);
  });

  it("rejects tampered content", () => {
    const event = sign([], "hello");
    const tampered = { ...event, content: "goodbye" };
    expect(verifyEventSignature(tampered).ok).toBe(false);
  });

  it("rejects a tampered created_at or kind", () => {
    const event = sign([], "hello");
    expect(verifyEventSignature({ ...event, created_at: event.created_at + 1 }).ok).toBe(false);
    expect(verifyEventSignature({ ...event, kind: 1 }).ok).toBe(false);
  });

  it("names the hash it expected, so a caller can see what changed", () => {
    const event = sign([], "hello");
    const tampered = { ...event, content: "goodbye" };
    const r = verifyEventSignature(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain(getEventHash(tampered));
  });
});

describe("verifyEventSignature: rejects a forged signature", () => {
  it("rejects an id recomputed to match tampered content, paired with the old signature", () => {
    const event = sign([], "hello");
    const forgedContent = "goodbye";
    const forgedId = getEventHash({ ...event, content: forgedContent });
    const forged = { ...event, content: forgedContent, id: forgedId };
    const r = verifyEventSignature(forged);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/"sig"/);
  });

  it("rejects an event claiming a pubkey it was not signed by", () => {
    const event = sign([], "hello");
    const impostor = getPublicKey(generateSecretKey());
    const relabeled = { ...event, pubkey: impostor };
    // changing pubkey changes the hash too, since pubkey is part of what gets signed
    const rehashed = { ...relabeled, id: getEventHash(relabeled) };
    expect(verifyEventSignature(rehashed).ok).toBe(false);
  });

  it("does not trust a cached verified flag copied over from the genuine event", () => {
    const event = sign([], "hello");
    expect(cachedVerifiedFlag(event)).toBe(true);
    const forgedContent = "goodbye";
    const forged = { ...event, content: forgedContent, id: getEventHash({ ...event, content: forgedContent }) };
    // the spread above carries the cached flag along for the ride
    expect(cachedVerifiedFlag(forged)).toBe(true);
    expect(verifyEventSignature(forged).ok).toBe(false);
  });
});

describe("verifyEventSignature: rejects malformed fields before touching cryptography", () => {
  it("rejects a malformed or uppercase id", () => {
    const event = sign([], "hello");
    expect(verifyEventSignature({ ...event, id: "short" }).ok).toBe(false);
    expect(verifyEventSignature({ ...event, id: event.id.toUpperCase() }).ok).toBe(false);
  });

  it("rejects a malformed pubkey", () => {
    const event = sign([], "hello");
    expect(verifyEventSignature({ ...event, pubkey: "nope" }).ok).toBe(false);
  });

  it("rejects a malformed or truncated sig", () => {
    const event = sign([], "hello");
    expect(verifyEventSignature({ ...event, sig: "nope" }).ok).toBe(false);
    expect(verifyEventSignature({ ...event, sig: event.sig.slice(0, -2) }).ok).toBe(false);
  });
});

describe("isEventSignatureValid", () => {
  it("mirrors verifyEventSignature as a plain boolean", () => {
    const event = sign([], "hello");
    expect(isEventSignatureValid(event)).toBe(true);
    expect(isEventSignatureValid({ ...event, sig: flipLastHexChar(event.sig) })).toBe(false);
  });
});