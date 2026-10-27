import { expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, verifyEvent } from "nostr-tools/pure";
import { SED_KINDS } from "../src/sed/common.js";

it("project works end to end", () => {
  const ev = finalizeEvent(
    { kind: SED_KINDS.CAPABILITY_SIGNAL, created_at: 1, tags: [], content: "" },
    generateSecretKey(),
  );
  expect(verifyEvent(ev)).toBe(true);
});