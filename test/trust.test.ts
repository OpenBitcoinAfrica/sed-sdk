import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "../src/sed/common.js";
import { buildCapabilitySignal } from "../src/sed/signal.js";
import type { Revocation } from "../src/sed/revocation.js";
import { resolveTrustedSignal } from "../src/sed/trust.js";

const opkSecret = generateSecretKey();
const OPK = getPublicKey(opkSecret);
const IPK = getPublicKey(generateSecretKey());
const NOW = 1782691200;

function mockFetch(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

function signal(overrides: Partial<Parameters<typeof buildCapabilitySignal>[0]> = {}): NostrEvent {
  const unsigned = buildCapabilitySignal({
    nip05: "api@service.com",
    regions: ["NG"],
    currencies: ["NGN"],
    rails: ["bank_transfer"],
    capacityTier: "tier_3",
    expiration: NOW + 24 * 60 * 60,
    endpoint: { url: "https://api.service.com", port: 443 },
    createdAt: NOW,
    ...overrides,
  });
  return finalizeEvent(unsigned, opkSecret);
}

const nostrJson = { names: { _: IPK, api: OPK } };

describe("resolveTrustedSignal: the happy path", () => {
  it("resolves the signal and the identity when every check passes", async () => {
    const fetchImpl = mockFetch(nostrJson);
    const r = await resolveTrustedSignal(signal(), [], NOW, { fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.signal.domain).toBe("service.com");
      expect(r.value.identity.ipk).toBe(IPK);
    }
  });

  it("defaults now to the current time when not given", async () => {
    const fetchImpl = mockFetch(nostrJson);
    const future = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const r = await resolveTrustedSignal(signal({ createdAt: Math.floor(Date.now() / 1000), expiration: future }), [], undefined, { fetchImpl });
    expect(r.ok).toBe(true);
  });
});

describe("resolveTrustedSignal: stops at the first failing step", () => {
  it("stops at the signature, before ever parsing or fetching anything", async () => {
    const fetchImpl = mockFetch(nostrJson);
    const tampered = { ...signal(), content: "something else" };
    const r = await resolveTrustedSignal(tampered, [], NOW, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/"id"|"sig"/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops at parsing a signal of the wrong kind", async () => {
    const fetchImpl = mockFetch(nostrJson);
    const wrongKind = finalizeEvent({ kind: 1, created_at: NOW, tags: [], content: "" }, opkSecret);
    const r = await resolveTrustedSignal(wrongKind, [], NOW, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/expected kind/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops at expiry, before ever checking identity", async () => {
    const fetchImpl = mockFetch(nostrJson);
    const r = await resolveTrustedSignal(signal(), [], NOW + 2 * 24 * 60 * 60, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/expired/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops at identity when the domain does not back this key", async () => {
    const someoneElse = getPublicKey(generateSecretKey());
    const fetchImpl = mockFetch({ names: { _: IPK, api: someoneElse } });
    const r = await resolveTrustedSignal(signal(), [], NOW, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/does not match the key that signed this event/);
  });

  it("stops at revocation when the IPK has revoked this OPK", async () => {
    const fetchImpl = mockFetch(nostrJson);
    const revocations: Revocation[] = [{ signer: IPK, revokedOpk: OPK, revokedAt: NOW, reason: null, eventId: "x" }];
    const r = await resolveTrustedSignal(signal(), revocations, NOW, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/revoked/);
  });

  it("does not trust a revocation signed by anyone other than the IPK", async () => {
    const fetchImpl = mockFetch(nostrJson);
    const impostor = getPublicKey(generateSecretKey());
    const revocations: Revocation[] = [{ signer: impostor, revokedOpk: OPK, revokedAt: NOW, reason: null, eventId: "x" }];
    const r = await resolveTrustedSignal(signal(), revocations, NOW, { fetchImpl });
    expect(r.ok).toBe(true);
  });
});