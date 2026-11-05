import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getEventHash } from "nostr-tools/pure";
import type { NostrEvent } from "../src/sed/common.js";
import { createRelayPool, fetchEvents, publishEvent, type RelayPool } from "../src/sed/relay.js";

const sk = generateSecretKey();
const fakeEvent = (createdAt: number): NostrEvent => finalizeEvent({ kind: 30078, created_at: createdAt, tags: [], content: "" }, sk);

function fakePool(overrides: Partial<RelayPool>): RelayPool {
  return {
    publish: () => [],
    querySync: async () => [],
    ...overrides,
  };
}

describe("publishEvent", () => {
  it("reports every relay's own outcome, in the order the relays were given", async () => {
    const pool = fakePool({
      publish: (relays) => relays.map((relay, i) => (i % 2 === 0 ? Promise.resolve(`ok from ${relay}`) : Promise.reject(new Error(`rejected by ${relay}`)))),
    });
    const r = await publishEvent(pool, ["relay-a", "relay-b", "relay-c"], fakeEvent(1));
    expect(r).toEqual([
      { relay: "relay-a", ok: true, reason: "ok from relay-a" },
      { relay: "relay-b", ok: false, reason: "rejected by relay-b" },
      { relay: "relay-c", ok: true, reason: "ok from relay-c" },
    ]);
  });

  it("stringifies a rejection that is not an Error", async () => {
    const pool = fakePool({ publish: () => [Promise.reject("duplicate url")] });
    const r = await publishEvent(pool, ["relay-a"], fakeEvent(1));
    expect(r).toEqual([{ relay: "relay-a", ok: false, reason: "duplicate url" }]);
  });

  it("never throws, even when every relay rejects", async () => {
    const pool = fakePool({ publish: (relays) => relays.map(() => Promise.reject(new Error("down"))) });
    await expect(publishEvent(pool, ["relay-a", "relay-b"], fakeEvent(1))).resolves.toHaveLength(2);
  });
});

describe("fetchEvents", () => {
  it("returns whatever the pool found, newest first", async () => {
    const pool = fakePool({ querySync: async () => [fakeEvent(100), fakeEvent(300), fakeEvent(200)] });
    const events = await fetchEvents(pool, ["relay-a"], { kinds: [30078] });
    expect(events.map((e) => e.created_at)).toEqual([300, 200, 100]);
  });

  it("does not mutate the array the pool handed back", async () => {
    const original = [fakeEvent(100), fakeEvent(300)];
    const pool = fakePool({ querySync: async () => original });
    await fetchEvents(pool, ["relay-a"], { kinds: [30078] });
    expect(original.map((e) => e.created_at)).toEqual([100, 300]);
  });

  it("returns an empty array when nothing matches", async () => {
    const pool = fakePool({ querySync: async () => [] });
    expect(await fetchEvents(pool, ["relay-a"], { kinds: [30078] })).toEqual([]);
  });
});

describe("createRelayPool", () => {
  it("defaults maxWaitForConnection and accepts an override", () => {
    expect(createRelayPool().maxWaitForConnection).toBe(3000);
    expect(createRelayPool({ maxWaitForConnection: 500 }).maxWaitForConnection).toBe(500);
  });

  it("checks events with this SDK's own verifier, not nostr-tools' cached one", () => {
    const pool = createRelayPool();
    const event = fakeEvent(1);
    expect(pool.verifyEvent(event, "wss://relay.example")).toBe(true);

    const tampered = { ...event, content: "something else" };
    expect(pool.verifyEvent(tampered, "wss://relay.example")).toBe(false);
  });

  it("is not fooled by a cached verified flag copied onto a forged event", () => {
    const pool = createRelayPool();
    const event = fakeEvent(1);
    const forgedContent = "something else";
    const forged = { ...event, content: forgedContent, id: getEventHash({ ...event, content: forgedContent }) };
    expect(pool.verifyEvent(forged, "wss://relay.example")).toBe(false);
  });
});