import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getConversationKey } from "nostr-tools/nip44";
import {
  buildPrivateAttestation,
  decryptPrivateAttestation,
  parsePrivateAttestationEnvelope,
  privateAttestationDTag,
} from "../src/sed/private-attestation.js";

const attesterSk = generateSecretKey();
const attester = getPublicKey(attesterSk);
const recipientSk = generateSecretKey();
const recipient = getPublicKey(recipientSk);
const outsiderSk = generateSecretKey();
const outsider = getPublicKey(outsiderSk);
const subject = getPublicKey(generateSecretKey());

const buildAndSign = (overrides: Partial<Parameters<typeof buildPrivateAttestation>[0]> = {}) => {
  const template = buildPrivateAttestation({
    subject,
    type: "liquidity",
    highestVolumeTier: "tier_3",
    slaCompliance: "target_met",
    attesterSecretKey: attesterSk,
    recipientPubkey: recipient,
    ...overrides,
  });
  return finalizeEvent(template, attesterSk);
};

describe("buildPrivateAttestation / decryptPrivateAttestation round trip", () => {
  it("the recipient can decrypt what the attester sent, and reads the real subject and facts back out", () => {
    const event = buildAndSign();
    const r = decryptPrivateAttestation(event, recipientSk, attester);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.attester).toBe(attester);
    expect(r.value.subject).toBe(subject);
    expect(r.value.type).toBe("liquidity");
    expect(r.value.highestVolumeTier).toBe("tier_3");
    expect(r.value.slaCompliance).toBe("target_met");
    expect(r.value.eventId).toBe(event.id);
    expect(r.value.createdAt).toBe(event.created_at);
  });

  it("the attester can also decrypt their own sent copy, using their own secret key and the recipient's pubkey", () => {
    const event = buildAndSign();
    const r = decryptPrivateAttestation(event, attesterSk, recipient);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.subject).toBe(subject);
  });

  it("nobody else can decrypt it, not even with their own otherwise-valid secret key", () => {
    const event = buildAndSign();
    const r = decryptPrivateAttestation(event, outsiderSk, attester);
    expect(r.ok).toBe(false);
  });

  it("the outer event never reveals the subject, only the recipient", () => {
    const event = buildAndSign();
    expect(JSON.stringify(event.tags)).not.toContain(subject);
    expect(JSON.stringify(event.tags)).toContain(recipient);
    expect(event.content).not.toContain(subject.slice(0, 16));
  });
});

describe("parsePrivateAttestationEnvelope", () => {
  it("reads the recipient and d tag without needing any key", () => {
    const event = buildAndSign();
    const r = parsePrivateAttestationEnvelope(event);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.recipient).toBe(recipient);
    expect(r.value.dTag).toBe(event.tags.find((t) => t[0] === "d")![1]);
  });

  it("rejects an event missing the encrypted marker", () => {
    const event = buildAndSign();
    const tampered = { ...event, tags: event.tags.filter((t) => t[0] !== "encrypted") };
    const r = parsePrivateAttestationEnvelope(tampered);
    expect(r.ok).toBe(false);
  });

  it("rejects an event with more than one recipient tag", () => {
    const event = buildAndSign();
    const tampered = { ...event, tags: [...event.tags, ["p", outsider]] };
    const r = parsePrivateAttestationEnvelope(tampered);
    expect(r.ok).toBe(false);
  });

  it("rejects the wrong kind", () => {
    const event = buildAndSign();
    const r = parsePrivateAttestationEnvelope({ ...event, kind: 1 });
    expect(r.ok).toBe(false);
  });
});

describe("privateAttestationDTag", () => {
  it("both parties independently derive the same d tag from their own keys", () => {
    const fromAttester = getConversationKey(attesterSk, recipient);
    const fromRecipient = getConversationKey(recipientSk, attester);
    const a = privateAttestationDTag(fromAttester, subject, "liquidity");
    const b = privateAttestationDTag(fromRecipient, subject, "liquidity");
    expect(a).toBe(b);
  });

  it("is 64 lowercase hex characters, and matches what buildPrivateAttestation actually put on the event", () => {
    const event = buildAndSign();
    const dTag = event.tags.find((t) => t[0] === "d")![1]!;
    expect(dTag).toMatch(/^[0-9a-f]{64}$/);

    const conversationKey = getConversationKey(recipientSk, attester);
    expect(privateAttestationDTag(conversationKey, subject, "liquidity")).toBe(dTag);
  });

  it("changes if the subject, type, or either party's key changes", () => {
    const conversationKey = getConversationKey(attesterSk, recipient);
    const base = privateAttestationDTag(conversationKey, subject, "liquidity");
    const otherSubject = privateAttestationDTag(conversationKey, getPublicKey(generateSecretKey()), "liquidity");
    const otherType = privateAttestationDTag(conversationKey, subject, "settlement");
    const otherKey = privateAttestationDTag(getConversationKey(attesterSk, outsider), subject, "liquidity");
    expect(new Set([base, otherSubject, otherType, otherKey]).size).toBe(4);
  });
});

describe("decryptPrivateAttestation against a malformed or tampered payload", () => {
  it("fails cleanly, not by throwing, when content is corrupted", () => {
    const event = buildAndSign();
    const corrupted = { ...event, content: event.content.slice(0, -4) + "abcd" };
    const r = decryptPrivateAttestation(corrupted, recipientSk, attester);
    expect(r.ok).toBe(false);
  });

  it("fails cleanly on an event that isn't shaped like a private attestation at all", () => {
    const event = buildAndSign();
    const r = decryptPrivateAttestation({ ...event, tags: [] }, recipientSk, attester);
    expect(r.ok).toBe(false);
  });
});