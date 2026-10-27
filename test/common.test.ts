import { describe, expect, it } from "vitest";
import { MAX_SIGNAL_TTL_SECONDS, SED_KINDS, fail, ok, tagsNamed } from "../src/sed/common.js";

describe("common", () => {
  it("uses the kinds from the spec", () => {
    expect(SED_KINDS).toEqual({ CAPABILITY_SIGNAL: 30078, ATTESTATION: 30079, REVOCATION: 30080, DELETION: 5 });
  });
  it("ninety days is 7776000 seconds", () => {
    expect(MAX_SIGNAL_TTL_SECONDS).toBe(7776000);
  });
  it("tagsNamed returns every tag with that name, and nothing else", () => {
    const e = { tags: [["region", "NG"], ["rail", "bank"], ["region", "KE"]] };
    expect(tagsNamed(e, "region")).toEqual([["region", "NG"], ["region", "KE"]]);
    expect(tagsNamed(e, "missing")).toEqual([]);
  });
  it("ok and fail build the two Result shapes", () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 });
    expect(fail("a", "b")).toEqual({ ok: false, errors: ["a", "b"] });
  });
});