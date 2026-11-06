import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Attestation } from "../src/sed/attestation.js";
import { evaluateTrust } from "../src/sed/reputation.js";

const anchor1 = getPublicKey(generateSecretKey());
const anchor2 = getPublicKey(generateSecretKey());
const peerB = getPublicKey(generateSecretKey());
const peerC = getPublicKey(generateSecretKey());
const target = getPublicKey(generateSecretKey());
const outsider1 = getPublicKey(generateSecretKey());
const outsider2 = getPublicKey(generateSecretKey());

const NOW = 2_000_000_000;
let nextId = 0;

function attestation(overrides: Partial<Attestation> & Pick<Attestation, "attester" | "subject">): Attestation {
  nextId += 1;
  return {
    type: "liquidity",
    eventId: `event-${nextId}`,
    createdAt: NOW,
    relationshipStart: null,
    lastActive: null,
    verifiedRails: [],
    highestVolumeTier: null,
    slaCompliance: null,
    disputeMaliciousActor: false,
    isSelfAttestation: overrides.attester === overrides.subject,
    ...overrides,
  };
}

describe("evaluateTrust, graph distance", () => {
  it("is 1 (direct) when an anchor attests to the target directly", () => {
    const r = evaluateTrust(target, [attestation({ attester: anchor1, subject: target })], [anchor1], { type: "liquidity" }, { now: NOW });
    expect(r.distance).toBe(1);
    expect(r.reliability).toBe("direct");
    expect(r.supportingAttestations).toHaveLength(1);
  });

  it("is 2 (indirect) when an anchor attests to a peer, and the peer attests to the target", () => {
    const attestations = [attestation({ attester: anchor1, subject: peerB }), attestation({ attester: peerB, subject: target })];
    const r = evaluateTrust(target, attestations, [anchor1], { type: "liquidity" }, { now: NOW });
    expect(r.distance).toBe(2);
    expect(r.reliability).toBe("indirect");
  });

  it("is 0 (direct) when the candidate is itself one of the caller's anchors", () => {
    const r = evaluateTrust(anchor1, [], [anchor1], { type: "liquidity" }, { now: NOW });
    expect(r.distance).toBe(0);
    expect(r.reliability).toBe("direct");
  });

  it("stays unverified beyond the default 2-hop horizon, but becomes deep when maxDistance is raised", () => {
    const attestations = [
      attestation({ attester: anchor1, subject: peerB }),
      attestation({ attester: peerB, subject: peerC }),
      attestation({ attester: peerC, subject: target }),
    ];
    const withDefault = evaluateTrust(target, attestations, [anchor1], { type: "liquidity" }, { now: NOW });
    expect(withDefault.distance).toBeNull();
    expect(withDefault.reliability).toBe("unverified");
    // The attestation targeting it still shows up as evidence, even though
    // it wasn't reachable within the search horizon.
    expect(withDefault.supportingAttestations).toHaveLength(1);
    expect(withDefault.isolatedCluster).toBe(true);

    const withDeeperSearch = evaluateTrust(target, attestations, [anchor1], { type: "liquidity" }, { now: NOW, maxDistance: 3 });
    expect(withDeeperSearch.distance).toBe(3);
    expect(withDeeperSearch.reliability).toBe("deep");
    expect(withDeeperSearch.isolatedCluster).toBe(false);
  });

  it("a disconnected cluster of positive attestations does not make the target trusted by itself", () => {
    // outsider2 vouches for outsider1, outsider1 vouches for the target,
    // but neither outsider has any path back to a real anchor.
    const attestations = [attestation({ attester: outsider2, subject: outsider1 }), attestation({ attester: outsider1, subject: target })];
    const r = evaluateTrust(target, attestations, [anchor1], { type: "liquidity" }, { now: NOW });
    expect(r.distance).toBeNull();
    expect(r.reliability).toBe("unverified");
    expect(r.isolatedCluster).toBe(true);
  });

  it("unverified with no evidence at all is not flagged as an isolated cluster, there's simply nothing there", () => {
    const r = evaluateTrust(target, [], [anchor1], { type: "liquidity" }, { now: NOW });
    expect(r.distance).toBeNull();
    expect(r.isolatedCluster).toBe(false);
    expect(r.supportingAttestations).toHaveLength(0);
  });
});

describe("evaluateTrust, relevance filtering", () => {
  it("ignores attestations of a different interaction type", () => {
    const r = evaluateTrust(
      target,
      [attestation({ attester: anchor1, subject: target, type: "settlement" })],
      [anchor1],
      { type: "liquidity" },
      { now: NOW },
    );
    expect(r.distance).toBeNull();
    expect(r.supportingAttestations).toHaveLength(0);
  });

  it("excludes an attestation that names rails but not the one asked for", () => {
    const r = evaluateTrust(
      target,
      [attestation({ attester: anchor1, subject: target, verifiedRails: ["mobile_money"] })],
      [anchor1],
      { type: "liquidity", rail: "bank_transfer" },
      { now: NOW },
    );
    expect(r.supportingAttestations).toHaveLength(0);
  });

  it("does not exclude an attestation that names no rails at all, even when a rail was asked for", () => {
    const r = evaluateTrust(target, [attestation({ attester: anchor1, subject: target, verifiedRails: [] })], [anchor1], { type: "liquidity", rail: "bank_transfer" }, { now: NOW });
    expect(r.supportingAttestations).toHaveLength(1);
  });

  it("excludes an attestation whose stated tier is below the minimum asked for", () => {
    const r = evaluateTrust(
      target,
      [attestation({ attester: anchor1, subject: target, highestVolumeTier: "tier_1" })],
      [anchor1],
      { type: "liquidity", minTier: "tier_3" },
      { now: NOW },
    );
    expect(r.supportingAttestations).toHaveLength(0);
  });

  it("does not exclude an attestation with no stated tier, even when a minimum was asked for", () => {
    const r = evaluateTrust(target, [attestation({ attester: anchor1, subject: target, highestVolumeTier: null })], [anchor1], { type: "liquidity", minTier: "tier_3" }, { now: NOW });
    expect(r.supportingAttestations).toHaveLength(1);
  });

  it("ignores an attestation older than the freshness window", () => {
    const stale = attestation({ attester: anchor1, subject: target, createdAt: NOW - 400 * 24 * 60 * 60 });
    const r = evaluateTrust(target, [stale], [anchor1], { type: "liquidity" }, { now: NOW, freshnessWindowSeconds: 30 * 24 * 60 * 60 });
    expect(r.supportingAttestations).toHaveLength(0);
  });

  it("uses lastActive over createdAt for freshness when it's present", () => {
    const recentlyActive = attestation({ attester: anchor1, subject: target, createdAt: NOW - 400 * 24 * 60 * 60, lastActive: NOW - 10 });
    const r = evaluateTrust(target, [recentlyActive], [anchor1], { type: "liquidity" }, { now: NOW, freshnessWindowSeconds: 30 * 24 * 60 * 60 });
    expect(r.supportingAttestations).toHaveLength(1);
  });
});

describe("evaluateTrust, disputes and conflicts", () => {
  it("flags a dispute from a direct anchor", () => {
    const r = evaluateTrust(target, [attestation({ attester: anchor1, subject: target, disputeMaliciousActor: true })], [anchor1], { type: "liquidity" }, { now: NOW });
    expect(r.disputesFromAnchors).toHaveLength(1);
    expect(r.overriddenByAnchorDispute).toBe(true);
  });

  it("does not flag a dispute made by a non-anchor", () => {
    const attestations = [attestation({ attester: anchor1, subject: peerB }), attestation({ attester: peerB, subject: target, disputeMaliciousActor: true })];
    const r = evaluateTrust(target, attestations, [anchor1], { type: "liquidity" }, { now: NOW });
    expect(r.disputesFromAnchors).toHaveLength(0);
    expect(r.overriddenByAnchorDispute).toBe(false);
  });

  it("a newer, non-disputing attestation for the same tuple resolves an old dispute", () => {
    const old = attestation({ attester: anchor1, subject: target, createdAt: NOW - 1000, disputeMaliciousActor: true });
    const resolved = attestation({ attester: anchor1, subject: target, createdAt: NOW, disputeMaliciousActor: false });
    const r = evaluateTrust(target, [old, resolved], [anchor1], { type: "liquidity" }, { now: NOW });
    expect(r.disputesFromAnchors).toHaveLength(0);
    expect(r.supportingAttestations).toHaveLength(1);
  });

  it("flags attestations from two anchors at the same distance that disagree", () => {
    const attestations = [
      attestation({ attester: anchor1, subject: target, slaCompliance: "target_met" }),
      attestation({ attester: anchor2, subject: target, slaCompliance: "target_missed" }),
    ];
    const r = evaluateTrust(target, attestations, [anchor1, anchor2], { type: "liquidity" }, { now: NOW });
    expect(r.conflicting).toBe(true);
  });

  it("does not flag agreement between two anchors at the same distance", () => {
    const attestations = [
      attestation({ attester: anchor1, subject: target, slaCompliance: "target_met" }),
      attestation({ attester: anchor2, subject: target, slaCompliance: "target_met" }),
    ];
    const r = evaluateTrust(target, attestations, [anchor1, anchor2], { type: "liquidity" }, { now: NOW });
    expect(r.conflicting).toBe(false);
  });

  it("does not flag disagreement between attestations at different distances", () => {
    // anchor1 attests directly (distance 1), peerB is two hops away and disagrees; not "equal distance", so not flagged as a same-level conflict.
    const attestations = [
      attestation({ attester: anchor1, subject: target, slaCompliance: "target_met" }),
      attestation({ attester: anchor1, subject: peerB }),
      attestation({ attester: peerB, subject: target, slaCompliance: "target_missed" }),
    ];
    const r = evaluateTrust(target, attestations, [anchor1], { type: "liquidity" }, { now: NOW });
    expect(r.conflicting).toBe(false);
  });
});