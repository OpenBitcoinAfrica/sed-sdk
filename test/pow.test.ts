import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { buildCapabilitySignal, parseCapabilitySignal } from "../src/sed/signal.js";
import { verifyEventSignature } from "../src/sed/verify.js";
import {
  MAX_POW_DIFFICULTY,
  addProofOfWork,
  getEventDifficulty,
  meetsDifficulty,
} from "../src/sed/pow.js";

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const T = Math.floor(Date.now() / 1000);

const template = () =>
  buildCapabilitySignal({
    nip05: "api@service.com",
    regions: ["NG"],
    currencies: ["NGN"],
    rails: ["bank_transfer"],
    capacityTier: "tier_2",
    expiration: T + 7 * 24 * 60 * 60,
    endpoint: { url: "https://api.service.com", port: 443 },
    createdAt: T,
  });

describe("addProofOfWork", () => {
  it("returns a template whose signed event meets the difficulty", () => {
    const mined = addProofOfWork(template(), pk, 12);
    const event = finalizeEvent(mined, sk);
    expect(meetsDifficulty(event, 12)).toBe(true);
    expect(getEventDifficulty(event)).toBeGreaterThanOrEqual(12);
  });

  it("keeps the id valid after signing, so the signature check still passes", () => {
    const event = finalizeEvent(addProofOfWork(template(), pk, 8), sk);
    expect(verifyEventSignature(event).ok).toBe(true);
  });

  it("adds exactly one nonce tag carrying the target", () => {
    const mined = addProofOfWork(template(), pk, 8);
    const nonces = mined.tags.filter((t) => t[0] === "nonce");
    expect(nonces).toHaveLength(1);
    expect(nonces[0]?.[2]).toBe("8");
  });

  it("replaces a nonce tag already on the template", () => {
    const first = addProofOfWork(template(), pk, 8);
    const second = addProofOfWork(first, pk, 10);
    expect(second.tags.filter((t) => t[0] === "nonce")).toHaveLength(1);
  });

  it("sets created_at to the current time while mining", () => {
    const old = { ...template(), created_at: T - 5000 };
    const mined = addProofOfWork(old, pk, 8);
    expect(mined.created_at).toBeGreaterThanOrEqual(T);
  });

  it("does not change the template it was given", () => {
    const original = template();
    const before = JSON.stringify(original);
    addProofOfWork(original, pk, 8);
    expect(JSON.stringify(original)).toBe(before);
  });

  it("produces an event that still parses as a capability signal", () => {
    const event = finalizeEvent(addProofOfWork(template(), pk, 8), sk);
    expect(parseCapabilitySignal(event).ok).toBe(true);
  });

  it("loses the work when a different key signs", () => {
    const mined = addProofOfWork(template(), pk, 16);
    const otherEvent = finalizeEvent(mined, generateSecretKey());
    // Overwhelmingly likely to miss 16 bits by chance; the real point is that
    // the difficulty was earned for pk, not for the other key.
    expect(meetsDifficulty(otherEvent, 16)).toBe(false);
  });

  it("rejects a bad pubkey", () => {
    expect(() => addProofOfWork(template(), "abc", 8)).toThrow(/pubkey/);
    expect(() => addProofOfWork(template(), pk.toUpperCase(), 8)).toThrow(/pubkey/);
  });

  it("rejects difficulties that are zero, fractional, negative or too large", () => {
    for (const bad of [0, -1, 1.5, MAX_POW_DIFFICULTY + 1, Number.NaN]) {
      expect(() => addProofOfWork(template(), pk, bad)).toThrow(/difficulty/);
    }
  });
});

describe("getEventDifficulty", () => {
  it("ignores a boastful nonce tag and a forged id", () => {
    const event = finalizeEvent({ ...template(), tags: [...template().tags, ["nonce", "1", "40"]] }, sk);
    const forged = { ...event, id: "0".repeat(64) };
    expect(getEventDifficulty(forged)).toBe(getEventDifficulty(event));
    expect(meetsDifficulty(forged, 40)).toBe(false);
  });

  it("is zero or small for an ordinary event", () => {
    const event = finalizeEvent(template(), sk);
    expect(getEventDifficulty(event)).toBeLessThan(MAX_POW_DIFFICULTY);
  });
});