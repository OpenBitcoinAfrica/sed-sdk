import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { type EventTemplate, type InteractionType, type NostrEvent, type Result, HEX64, SED_KINDS, exactlyOne, fail, ok, tagsNamed } from "./common.js";
import { type Attestation, type BuildAttestationInput, attestationDTag, buildAttestation, parseAttestation } from "./attestation.js";

const ENCRYPTED_MARKER = "nip44";
const HEX64_RE = /^[0-9a-f]{64}$/;

export function privateAttestationDTag(conversationKey: Uint8Array, subject: string, type: InteractionType): string {
  const marker = utf8ToBytes(attestationDTag(subject, type));
  return bytesToHex(sha256(concatBytes(conversationKey, marker)));
}

export interface PrivateAttestationEnvelope {
  recipient: string;
  dTag: string;
}

export function parsePrivateAttestationEnvelope(event: NostrEvent): Result<PrivateAttestationEnvelope> {
  const errors: string[] = [];
  if (event.kind !== SED_KINDS.ATTESTATION) {
    return fail(`expected kind ${SED_KINDS.ATTESTATION}, got ${event.kind}`);
  }

  const protocol = exactlyOne(event, "protocol", errors);
  if (protocol && protocol[1] !== "sed") errors.push('"protocol" tag must be "sed"');

  const encrypted = exactlyOne(event, "encrypted", errors);
  if (encrypted && encrypted[1] !== ENCRYPTED_MARKER) errors.push(`"encrypted" tag must be "${ENCRYPTED_MARKER}"`);

  const d = exactlyOne(event, "d", errors);
  if (d && !HEX64_RE.test(d[1] ?? "")) errors.push('"d" must be 64 lowercase hex characters');

  const recipientTags = tagsNamed(event, "p");
  let recipient = "";
  if (recipientTags.length !== 1) {
    errors.push(`private attestation needs exactly one ["p", <recipient>] tag (found ${recipientTags.length})`);
  } else if (!HEX64.test(recipientTags[0]![1] ?? "")) {
    errors.push("recipient must be 64 lowercase hex characters");
  } else {
    recipient = recipientTags[0]![1]!;
  }

  if (errors.length) return fail(...errors);
  return ok({ recipient, dTag: d![1]! });
}

export interface BuildPrivateAttestationInput extends BuildAttestationInput {
  attesterSecretKey: Uint8Array;
  recipientPubkey: string;
}

export function buildPrivateAttestation(input: BuildPrivateAttestationInput): EventTemplate {
  const inner = buildAttestation(input);
  const conversationKey = getConversationKey(input.attesterSecretKey, input.recipientPubkey);
  const ciphertext = nip44Encrypt(JSON.stringify(inner.tags), conversationKey);
  const dTag = privateAttestationDTag(conversationKey, input.subject, input.type);

  return {
    kind: SED_KINDS.ATTESTATION,
    created_at: inner.created_at,
    tags: [
      ["protocol", "sed"],
      ["d", dTag],
      ["p", input.recipientPubkey],
      ["encrypted", ENCRYPTED_MARKER],
    ],
    content: ciphertext,
  };
}

export function decryptPrivateAttestation(event: NostrEvent, myPrivateKey: Uint8Array, otherPartyPubkey: string): Result<Attestation> {
  const envelope = parsePrivateAttestationEnvelope(event);
  if (!envelope.ok) return envelope;

  const conversationKey = getConversationKey(myPrivateKey, otherPartyPubkey);

  let plaintext: string;
  try {
    plaintext = nip44Decrypt(event.content, conversationKey);
  } catch (err) {
    return fail(`could not decrypt: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(plaintext);
  } catch {
    return fail("decrypted content is not valid JSON");
  }
  if (!Array.isArray(parsedContent) || !parsedContent.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))) {
    return fail("decrypted content is not a tag array");
  }

  return parseAttestation({ ...event, tags: parsedContent as string[][], content: "" });
}