import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  attestationDTag,
  buildAttestation,
  latestAttestations,
  parseAttestation,
} from "../src/sed/attestation.js";
import type { Attestation } from "../src/sed/attestation.js";

const attesterSk = generateSecretKey();
const attester = getPublicKey(attesterSk);
const subject = getPublicKey(generateSecretKey());
const T = 1782695000;

const sign = (tags: string[][], kind = 30079, sk = attesterSk) =>
  finalizeEvent({ kind, created_at: T, tags, content: "" }, sk);

const base = () => [
  ["protocol", "sed"],
  ["d", `attestation:${subject}:liquidity`],
  ["p", subject, "subject"],
  ["type", "liquidity"],
];
const without = (name: string) => base().filter((t) => t[0] !== name);
const replace = (name: string, tag: string[]) => base().map((t) => (t[0] === name ? tag : t));

describe("attestation: required tags", () => {
  it("accepts the four required tags and reads them", () => {
    const r = parseAttestation(sign(base()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.attester).toBe(attester);
    expect(r.value.subject).toBe(subject);
    expect(r.value.type).toBe("liquidity");
    expect(r.value.relationshipStart).toBeNull();
    expect(r.value.highestVolumeTier).toBeNull();
    expect(r.value.slaCompliance).toBeNull();
    expect(r.value.disputeMaliciousActor).toBe(false);
    expect(r.value.isSelfAttestation).toBe(false);
  });
  it("rejects another kind", () => {
    expect(parseAttestation(sign(base(), 30078)).ok).toBe(false);
  });
  it("rejects a missing or wrong protocol tag", () => {
    expect(parseAttestation(sign(without("protocol"))).ok).toBe(false);
    expect(parseAttestation(sign(replace("protocol", ["protocol", "x"]))).ok).toBe(false);
  });
  it("accepts all four interaction types, and nothing else", () => {
    for (const type of ["liquidity", "settlement", "integration", "custody"]) {
      const tags = [["protocol", "sed"], ["d", attestationDTag(subject, type as "liquidity")], ["p", subject, "subject"], ["type", type]];
      expect(parseAttestation(sign(tags)).ok).toBe(true);
    }
    expect(parseAttestation(sign(replace("type", ["type", "gossip"]))).ok).toBe(false);
  });
  it("needs exactly one type tag", () => {
    expect(parseAttestation(sign(without("type"))).ok).toBe(false);
    expect(parseAttestation(sign([...base(), ["type", "custody"]])).ok).toBe(false);
  });
  it("needs exactly one subject tag holding 64 lowercase hex characters", () => {
    expect(parseAttestation(sign(without("p"))).ok).toBe(false);
    expect(parseAttestation(sign([...base(), ["p", attester, "subject"]])).ok).toBe(false);
    expect(parseAttestation(sign(replace("p", ["p", subject.toUpperCase(), "subject"]))).ok).toBe(false);
    expect(parseAttestation(sign(replace("p", ["p", "abc", "subject"]))).ok).toBe(false);
  });
  it("ignores p tags that are not marked subject", () => {
    expect(parseAttestation(sign([...base(), ["p", attester, "other"]])).ok).toBe(true);
  });
});

describe("attestation: deterministic d tag", () => {
  it("is attestation:<subject>:<type>", () => {
    expect(attestationDTag(subject, "custody")).toBe(`attestation:${subject}:custody`);
  });
  it("must match the subject and the type", () => {
    expect(parseAttestation(sign(without("d"))).ok).toBe(false);
    expect(parseAttestation(sign(replace("d", ["d", `attestation:${subject}:custody`]))).ok).toBe(false);
    expect(parseAttestation(sign(replace("d", ["d", `attestation:${attester}:liquidity`]))).ok).toBe(false);
    expect(parseAttestation(sign(replace("d", ["d", "whatever"]))).ok).toBe(false);
  });
});

describe("attestation: optional fact tags", () => {
  const full = () => [
    ...base(),
    ["relationship_start", "1688040000"],
    ["last_active", "1782691200"],
    ["verified_rail", "m-pesa"],
    ["highest_volume_tier", "tier_3"],
    ["sla_compliance", "target_met"],
  ];
  it("reads the SeD-03 example tags", () => {
    const r = parseAttestation(sign(full()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.relationshipStart).toBe(1688040000);
    expect(r.value.lastActive).toBe(1782691200);
    expect(r.value.verifiedRails).toEqual(["m-pesa"]);
    expect(r.value.highestVolumeTier).toBe("tier_3");
    expect(r.value.slaCompliance).toBe("target_met");
  });
  it("accepts all four volume tiers and both SLA values", () => {
    for (const tier of ["tier_1", "tier_2", "tier_3", "tier_4"]) {
      expect(parseAttestation(sign([...base(), ["highest_volume_tier", tier]])).ok).toBe(true);
    }
    for (const v of ["target_met", "target_missed"]) {
      expect(parseAttestation(sign([...base(), ["sla_compliance", v]])).ok).toBe(true);
    }
  });
  it("rejects bad values", () => {
    expect(parseAttestation(sign([...base(), ["highest_volume_tier", "tier_9"]])).ok).toBe(false);
    expect(parseAttestation(sign([...base(), ["sla_compliance", "mostly"]])).ok).toBe(false);
    expect(parseAttestation(sign([...base(), ["relationship_start", "yesterday"]])).ok).toBe(false);
    expect(parseAttestation(sign([...base(), ["last_active", "-1"]])).ok).toBe(false);
    expect(parseAttestation(sign([...base(), ["verified_rail", " "]])).ok).toBe(false);
  });
  it("rejects a repeated single-value tag", () => {
    expect(parseAttestation(sign([...base(), ["sla_compliance", "target_met"], ["sla_compliance", "target_missed"]])).ok).toBe(false);
    expect(parseAttestation(sign([...base(), ["last_active", "1"], ["last_active", "2"]])).ok).toBe(false);
  });
  it("keeps repeated verified_rail tags", () => {
    const r = parseAttestation(sign([...base(), ["verified_rail", "m-pesa"], ["verified_rail", "bank"]]));
    expect(r.ok && r.value.verifiedRails).toEqual(["m-pesa", "bank"]);
  });
});

describe("attestation: disputes and self attestation", () => {
  it("reads the malicious_actor dispute flag", () => {
    const r = parseAttestation(sign([...base(), ["dispute", "malicious_actor"]]));
    expect(r.ok && r.value.disputeMaliciousActor).toBe(true);
  });
  it("rejects any other dispute value", () => {
    expect(parseAttestation(sign([...base(), ["dispute", "rude"]])).ok).toBe(false);
  });
  it("flags, but accepts, an attester vouching for itself", () => {
    const tags = [["protocol", "sed"], ["d", `attestation:${attester}:custody`], ["p", attester, "subject"], ["type", "custody"]];
    const r = parseAttestation(sign(tags));
    expect(r.ok && r.value.isSelfAttestation).toBe(true);
  });
});

describe("attestation: newest one wins", () => {
  const att = (over: Partial<Attestation>): Attestation => ({
    attester, subject, type: "liquidity", eventId: "f".repeat(64), createdAt: 100,
    relationshipStart: null, lastActive: null, verifiedRails: [], highestVolumeTier: null,
    slaCompliance: null, disputeMaliciousActor: false, isSelfAttestation: false, ...over,
  });
  it("keeps the newest per attester, subject and type", () => {
    const old = att({ createdAt: 100, slaCompliance: "target_met", eventId: "a".repeat(64) });
    const fresh = att({ createdAt: 200, slaCompliance: "target_missed", eventId: "b".repeat(64) });
    const result = latestAttestations([old, fresh]);
    expect(result).toHaveLength(1);
    expect(result[0]!.slaCompliance).toBe("target_missed");
    expect(latestAttestations([fresh, old])[0]!.slaCompliance).toBe("target_missed");
  });
  it("keeps separate records for different types, attesters and subjects", () => {
    const other = getPublicKey(generateSecretKey());
    const list = [
      att({}),
      att({ type: "custody", eventId: "c".repeat(64) }),
      att({ attester: other, eventId: "d".repeat(64) }),
      att({ subject: other, eventId: "e".repeat(64) }),
    ];
    expect(latestAttestations(list)).toHaveLength(4);
  });
  it("breaks a created_at tie with the lowest event id (NIP-01)", () => {
    const a = att({ createdAt: 100, eventId: "1".repeat(64), slaCompliance: "target_met" });
    const b = att({ createdAt: 100, eventId: "2".repeat(64), slaCompliance: "target_missed" });
    expect(latestAttestations([a, b])[0]!.eventId).toBe("1".repeat(64));
    expect(latestAttestations([b, a])[0]!.eventId).toBe("1".repeat(64));
  });
  it("returns an empty list for no input", () => {
    expect(latestAttestations([])).toEqual([]);
  });
});

describe("attestation: builder", () => {
  it("builds an event the parser accepts, with the d tag set", () => {
    const t = buildAttestation({
      subject, type: "liquidity", relationshipStart: 1688040000, lastActive: 1782691200,
      verifiedRails: ["m-pesa"], highestVolumeTier: "tier_3", slaCompliance: "target_met", createdAt: T,
    });
    expect(t.kind).toBe(30079);
    expect(t.tags).toContainEqual(["d", `attestation:${subject}:liquidity`]);
    const r = parseAttestation(finalizeEvent(t, attesterSk));
    expect(r.ok && r.value.verifiedRails).toEqual(["m-pesa"]);
  });
  it("adds the dispute tag when asked", () => {
    const t = buildAttestation({ subject, type: "custody", disputeMaliciousActor: true, createdAt: T });
    expect(t.tags).toContainEqual(["dispute", "malicious_actor"]);
  });
  it("builds a minimal attestation", () => {
    const t = buildAttestation({ subject, type: "settlement", createdAt: T });
    expect(t.tags).toHaveLength(4);
  });
  it("refuses a bad subject", () => {
    expect(() => buildAttestation({ subject: "nope", type: "liquidity" })).toThrow(/subject/);
  });
});