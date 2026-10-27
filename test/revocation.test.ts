import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  buildRevocation,
  buildSignalDeletion,
  isOpkRevoked,
  parseRevocation,
  revocationDTag,
} from "../src/sed/revocation.js";

const ipkSk = generateSecretKey();
const ipk = getPublicKey(ipkSk);
const opk = getPublicKey(generateSecretKey());
const stranger = generateSecretKey();
const T = 1782691200;

const sign = (tags: string[][], kind = 30080, sk = ipkSk) =>
  finalizeEvent({ kind, created_at: T, tags, content: "Operational key revoked." }, sk);

const base = () => [
  ["protocol", "sed"],
  ["d", `revocation:${opk}`],
  ["p", opk, "revoked_opk"],
  ["revoked_at", "1782691200"],
  ["reason", "operational_key_compromise"],
];
const without = (name: string) => base().filter((t) => t[0] !== name);
const replace = (name: string, tag: string[]) => base().map((t) => (t[0] === name ? tag : t));

describe("revocation: parsing", () => {
  it("reads the SeD-05 example", () => {
    const r = parseRevocation(sign(base()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ signer: ipk, revokedOpk: opk, revokedAt: 1782691200, reason: "operational_key_compromise" });
  });
  it("needs only protocol, d and p", () => {
    const r = parseRevocation(sign([base()[0]!, base()[1]!, base()[2]!]));
    expect(r.ok && [r.value.revokedAt, r.value.reason]).toEqual([null, null]);
  });
  it("rejects another kind", () => {
    expect(parseRevocation(sign(base(), 30078)).ok).toBe(false);
  });
  it("rejects a missing or wrong protocol tag", () => {
    expect(parseRevocation(sign(without("protocol"))).ok).toBe(false);
    expect(parseRevocation(sign(replace("protocol", ["protocol", "x"]))).ok).toBe(false);
  });
  it("needs exactly one revoked_opk tag with 64 lowercase hex characters", () => {
    expect(parseRevocation(sign(without("p"))).ok).toBe(false);
    expect(parseRevocation(sign([...base(), ["p", ipk, "revoked_opk"]])).ok).toBe(false);
    expect(parseRevocation(sign(replace("p", ["p", "abc", "revoked_opk"]))).ok).toBe(false);
    expect(parseRevocation(sign(replace("p", ["p", opk.toUpperCase(), "revoked_opk"]))).ok).toBe(false);
  });
  it("needs the d tag to match the revoked key", () => {
    expect(revocationDTag(opk)).toBe(`revocation:${opk}`);
    expect(parseRevocation(sign(without("d"))).ok).toBe(false);
    expect(parseRevocation(sign(replace("d", ["d", `revocation:${ipk}`]))).ok).toBe(false);
  });
  it("checks revoked_at and reason when present", () => {
    expect(parseRevocation(sign(replace("revoked_at", ["revoked_at", "soon"]))).ok).toBe(false);
    expect(parseRevocation(sign([...base(), ["revoked_at", "5"]])).ok).toBe(false);
    expect(parseRevocation(sign([...base(), ["reason", "again"]])).ok).toBe(false);
  });
});

describe("revocation: who is believed", () => {
  it("counts a notice signed by the service IPK", () => {
    const r = parseRevocation(sign(base()));
    if (!r.ok) throw new Error("parse failed");
    expect(isOpkRevoked(opk, ipk, [r.value])).toBe(true);
  });
  it("ignores a notice signed by anyone else", () => {
    const r = parseRevocation(sign(base(), 30080, stranger));
    if (!r.ok) throw new Error("parse failed");
    expect(isOpkRevoked(opk, ipk, [r.value])).toBe(false);
  });
  it("ignores a notice about a different key, and an empty list", () => {
    const r = parseRevocation(sign(base()));
    if (!r.ok) throw new Error("parse failed");
    expect(isOpkRevoked(getPublicKey(generateSecretKey()), ipk, [r.value])).toBe(false);
    expect(isOpkRevoked(opk, ipk, [])).toBe(false);
  });
  it("counts the notice whatever its revoked_at says", () => {
    const r = parseRevocation(sign(replace("revoked_at", ["revoked_at", "1"])));
    if (!r.ok) throw new Error("parse failed");
    expect(isOpkRevoked(opk, ipk, [r.value])).toBe(true);
  });
});

describe("revocation: builders", () => {
  it("builds a notice the parser accepts", () => {
    const t = buildRevocation({ revokedOpk: opk, reason: "operational_key_compromise", note: "breach", createdAt: T });
    expect(t.kind).toBe(30080);
    expect(t.tags).toContainEqual(["d", `revocation:${opk}`]);
    expect(t.tags).toContainEqual(["revoked_at", String(T)]);
    const r = parseRevocation(finalizeEvent(t, ipkSk));
    expect(r.ok && r.value.reason).toBe("operational_key_compromise");
  });
  it("uses a given revoked_at, and leaves out reason when none is given", () => {
    const t = buildRevocation({ revokedOpk: opk, revokedAt: 5, createdAt: T });
    expect(t.tags).toContainEqual(["revoked_at", "5"]);
    expect(t.tags.some((x) => x[0] === "reason")).toBe(false);
  });
  it("refuses a bad key", () => {
    expect(() => buildRevocation({ revokedOpk: "nope" })).toThrow(/revoked OPK/);
  });
  it("builds the NIP-09 deletion for the capability signal", () => {
    const t = buildSignalDeletion(opk, "purge", T);
    expect(t.kind).toBe(5);
    expect(t.tags).toEqual([["a", `30078:${opk}:capability-signal`], ["k", "30078"]]);
    expect(t.content).toBe("purge");
    expect(() => buildSignalDeletion("nope")).toThrow();
  });
});