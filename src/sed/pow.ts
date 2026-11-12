import { getEventHash } from "nostr-tools/pure";
import { getPow, minePow } from "nostr-tools/nip13";
import { type EventTemplate, type NostrEvent, HEX64 } from "./common.js";

export const MAX_POW_DIFFICULTY = 32;

type Hashable = Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">;

export function getEventDifficulty(event: Hashable): number {
  return getPow(getEventHash(event));
}

export function meetsDifficulty(event: Hashable, bits: number): boolean {
  return getEventDifficulty(event) >= bits;
}

export function addProofOfWork(template: EventTemplate, pubkey: string, difficulty: number): EventTemplate {
  if (!HEX64.test(pubkey)) throw new Error("pubkey must be 64 lowercase hex characters");
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > MAX_POW_DIFFICULTY) {
    throw new Error(`difficulty must be a whole number from 1 to ${MAX_POW_DIFFICULTY}`);
  }

  const mined = minePow(
    {
      kind: template.kind,
      created_at: template.created_at,
      tags: template.tags.filter((t) => t[0] !== "nonce").map((t) => [...t]),
      content: template.content,
      pubkey,
    },
    difficulty,
  );

  const result: EventTemplate = {
    kind: mined.kind,
    created_at: mined.created_at,
    tags: mined.tags,
    content: mined.content,
  };

  if (!meetsDifficulty({ ...result, pubkey }, difficulty)) {
    throw new Error("proof of work check failed after mining");
  }
  return result;
}