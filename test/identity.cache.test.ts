import { describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createNostrJsonCache, resolveServiceIdentity } from "../src/sed/identity.js";

const OPK = getPublicKey(generateSecretKey());
const OPK2 = getPublicKey(generateSecretKey());
const IPK = getPublicKey(generateSecretKey());
const OTHER_IPK = getPublicKey(generateSecretKey());

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const calls = (f: typeof fetch) => (f as ReturnType<typeof vi.fn>).mock.calls.length;

describe("createNostrJsonCache", () => {
  it("returns what was stored until the ttl passes, then forgets it", () => {
    let clock = 1000;
    const cache = createNostrJsonCache({ ttlMs: 500, now: () => clock });
    cache.set("a.com", { names: {} });
    expect(cache.get("a.com")).toEqual({ names: {} });
    clock += 499;
    expect(cache.get("a.com")).toBeDefined();
    clock += 1;
    expect(cache.get("a.com")).toBeUndefined();
  });

  it("returns undefined for a domain it has never seen", () => {
    expect(createNostrJsonCache({ ttlMs: 1000 }).get("nope.com")).toBeUndefined();
  });

  it("drops the entry stored longest ago when it holds too many", () => {
    const cache = createNostrJsonCache({ ttlMs: 10_000, maxEntries: 2 });
    cache.set("a.com", 1);
    cache.set("b.com", 2);
    cache.set("c.com", 3);
    expect(cache.get("a.com")).toBeUndefined();
    expect(cache.get("b.com")).toBe(2);
    expect(cache.get("c.com")).toBe(3);
  });

  it("restarts the clock when a domain is stored again", () => {
    let clock = 0;
    const cache = createNostrJsonCache({ ttlMs: 100, now: () => clock });
    cache.set("a.com", 1);
    clock = 90;
    cache.set("a.com", 2);
    clock = 150;
    expect(cache.get("a.com")).toBe(2);
  });

  it("rejects a ttl or size that makes no sense", () => {
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createNostrJsonCache({ ttlMs })).toThrow(/ttlMs/);
    }
    for (const maxEntries of [0, -1, 1.5]) {
      expect(() => createNostrJsonCache({ ttlMs: 1000, maxEntries })).toThrow(/maxEntries/);
    }
  });
});

describe("resolveServiceIdentity with a cache", () => {
  const file = { names: { _: IPK, api: OPK } };

  it("fetches once and reuses the answer while the entry is fresh", async () => {
    const fetchImpl = mockFetch(200, file);
    const cache = createNostrJsonCache({ ttlMs: 60_000 });
    const first = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl, cache });
    const second = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl, cache });
    expect(first.ok && second.ok).toBe(true);
    expect(calls(fetchImpl)).toBe(1);
  });

  it("fetches again after the entry expires", async () => {
    let clock = 0;
    const fetchImpl = mockFetch(200, file);
    const cache = createNostrJsonCache({ ttlMs: 1000, now: () => clock });
    await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl, cache });
    clock = 1000;
    await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl, cache });
    expect(calls(fetchImpl)).toBe(2);
  });

  it("without a cache, every call still fetches", async () => {
    const fetchImpl = mockFetch(200, file);
    await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(calls(fetchImpl)).toBe(2);
  });

  it("keeps each domain separate", async () => {
    const fetchImpl = mockFetch(200, file);
    const cache = createNostrJsonCache({ ttlMs: 60_000 });
    await resolveServiceIdentity("one.com", "api", OPK, { fetchImpl, cache });
    await resolveServiceIdentity("two.com", "api", OPK, { fetchImpl, cache });
    expect(calls(fetchImpl)).toBe(2);
  });

  it("does not cache a failed fetch", async () => {
    const cache = createNostrJsonCache({ ttlMs: 60_000 });
    const down = mockFetch(500, {});
    expect((await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl: down, cache })).ok).toBe(false);
    const up = mockFetch(200, file);
    expect((await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl: up, cache })).ok).toBe(true);
    expect(calls(up)).toBe(1);
  });

  it("does not cache a body that is not a names object", async () => {
    const cache = createNostrJsonCache({ ttlMs: 60_000 });
    await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl: mockFetch(200, { nope: 1 }), cache });
    expect(cache.get("service.com")).toBeUndefined();
  });

  it("still enforces expectedIpk on a cached file", async () => {
    const fetchImpl = mockFetch(200, file);
    const cache = createNostrJsonCache({ ttlMs: 60_000 });
    await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl, cache });
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl, cache, expectedIpk: OTHER_IPK });
    expect(r.ok).toBe(false);
  });

  it("goes live when the cached file does not list the key, so a rotation shows up at once", async () => {
    const cache = createNostrJsonCache({ ttlMs: 60_000 });
    const before = mockFetch(200, file);
    await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl: before, cache });
    const after = mockFetch(200, { names: { _: IPK, api: OPK2 } });
    const r = await resolveServiceIdentity("service.com", "api", OPK2, { fetchImpl: after, cache });
    expect(r.ok).toBe(true);
    expect(calls(after)).toBe(1);
  });

  it("replaces the cached file with the fresh one after a live fetch", async () => {
    const cache = createNostrJsonCache({ ttlMs: 60_000 });
    await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl: mockFetch(200, file), cache });
    const rotated = mockFetch(200, { names: { _: IPK, api: OPK2 } });
    await resolveServiceIdentity("service.com", "api", OPK2, { fetchImpl: rotated, cache });
    const again = await resolveServiceIdentity("service.com", "api", OPK2, { fetchImpl: rotated, cache });
    expect(again.ok).toBe(true);
    expect(calls(rotated)).toBe(1);
  });

  it("keeps vouching for a removed key until the entry expires, which is the cost of caching", async () => {
    let clock = 0;
    const cache = createNostrJsonCache({ ttlMs: 1000, now: () => clock });
    await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl: mockFetch(200, file), cache });
    const removed = mockFetch(200, { names: { _: IPK } });
    expect((await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl: removed, cache })).ok).toBe(true);
    clock = 1000;
    expect((await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl: removed, cache })).ok).toBe(false);
  });
});