import { describe, expect, it } from "vitest";
import { generateSecretKey, finalizeEvent } from "nostr-tools/pure";
import { parseRequiredPowBits, publishEvent, type RelayPool } from "../src/sed/relay.js";

describe("parseRequiredPowBits", () => {
  it("reads the number out of common wordings", () => {
    expect(parseRequiredPowBits("pow: 28 bits needed")).toBe(28);
    expect(parseRequiredPowBits("pow: min difficulty 24")).toBe(24);
    expect(parseRequiredPowBits("blocked: pow: required difficulty is 30")).toBe(30);
  });

  it("takes the larger number when a message holds both what the event had and what is required", () => {
    expect(parseRequiredPowBits("pow: difficulty 25>=30")).toBe(30);
    expect(parseRequiredPowBits("pow: you gave 12 bits but 24 are required")).toBe(24);
  });

  it("is case insensitive about the word pow", () => {
    expect(parseRequiredPowBits("POW: 20 bits")).toBe(20);
  });

  it("returns undefined when the message is not about proof of work", () => {
    expect(parseRequiredPowBits("blocked: not on the allow list")).toBeUndefined();
    expect(parseRequiredPowBits("rate-limited: slow down, 30 per minute")).toBeUndefined();
    expect(parseRequiredPowBits("")).toBeUndefined();
  });

  it("returns undefined when pow is mentioned without a usable number", () => {
    expect(parseRequiredPowBits("pow: not enough work")).toBeUndefined();
    expect(parseRequiredPowBits("pow: 0 bits")).toBeUndefined();
    expect(parseRequiredPowBits("pow: 99999 bits")).toBeUndefined();
  });

  it("does not match words that merely contain pow", () => {
    expect(parseRequiredPowBits("powerless 12")).toBeUndefined();
  });
});

describe("publishEvent and proof of work", () => {
  const event = finalizeEvent({ kind: 30078, created_at: 1, tags: [], content: "" }, generateSecretKey());

  const poolReplying = (replies: Array<string | Error>): RelayPool => ({
    publish: () => replies.map((r) => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r))),
    querySync: async () => [],
  });

  it("adds requiredPowBits to a rejection that asks for work", async () => {
    const pool = poolReplying([new Error("pow: 28 bits needed"), "ok"]);
    const outcomes = await publishEvent(pool, ["wss://a", "wss://b"], event);
    expect(outcomes[0]).toEqual({ relay: "wss://a", ok: false, reason: "pow: 28 bits needed", requiredPowBits: 28 });
    expect(outcomes[1]).toEqual({ relay: "wss://b", ok: true, reason: "ok" });
  });

  it("leaves requiredPowBits off for other rejections", async () => {
    const outcomes = await publishEvent(poolReplying([new Error("blocked: no")]), ["wss://a"], event);
    expect(outcomes[0]).toEqual({ relay: "wss://a", ok: false, reason: "blocked: no" });
    expect("requiredPowBits" in outcomes[0]!).toBe(false);
  });
});