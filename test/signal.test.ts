import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { buildCapabilitySignal, isSignalLive, parseCapabilitySignal } from "../src/sed/signal.js";

const sk = generateSecretKey();
const make = (tags: string[][], kind = 30078) =>
  finalizeEvent({ kind, created_at: 1782691200, tags, content: "" }, sk);

const base = () => [
  ["protocol", "sed"],
  ["d", "capability-signal"],
  ["nip05", "api@service.com"],
  ["region", "NG"],
  ["currency", "NGN"],
  ["rail", "bank_transfer"],
  ["capacity_tier", "tier_3"],
  ["expiration", "1783296000"],
  ["endpoint", "https://api.service.com", "443"],
];
const without = (name: string) => base().filter((t) => t[0] !== name);
const replace = (name: string, tag: string[]) => base().map((t) => (t[0] === name ? tag : t));

describe("capability signal: kind, protocol and d tags", () => {
  it("accepts the right kind with all required tags", () => {
    expect(parseCapabilitySignal(make(base())).ok).toBe(true);
  });
  it("rejects another kind", () => {
    expect(parseCapabilitySignal(make(base(), 30079)).ok).toBe(false);
  });
  it("rejects a missing protocol tag", () => {
    expect(parseCapabilitySignal(make(without("protocol"))).ok).toBe(false);
  });
  it("rejects a protocol tag that is not sed", () => {
    expect(parseCapabilitySignal(make(replace("protocol", ["protocol", "other"]))).ok).toBe(false);
  });
  it("rejects a duplicate protocol tag", () => {
    expect(parseCapabilitySignal(make([...base(), ["protocol", "sed"]])).ok).toBe(false);
  });
  it("rejects a missing d tag", () => {
    expect(parseCapabilitySignal(make(without("d"))).ok).toBe(false);
  });
  it("rejects a d tag with the wrong value", () => {
    expect(parseCapabilitySignal(make(replace("d", ["d", "something-else"]))).ok).toBe(false);
  });
  it("reports every problem at once, not just the first", () => {
    const r = parseCapabilitySignal(make([]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(9);
  });
});

describe("capability signal: nip05 tag", () => {
  it("splits api@service.com into name and domain", () => {
    const r = parseCapabilitySignal(make(base()));
    expect(r.ok && [r.value.nip05, r.value.name, r.value.domain]).toEqual(["api@service.com", "api", "service.com"]);
  });
  it("lowercases the domain", () => {
    const r = parseCapabilitySignal(make(replace("nip05", ["nip05", "api@Service.COM"])));
    expect(r.ok && r.value.domain).toBe("service.com");
  });
  it("accepts the characters NIP-05 allows in the name", () => {
    expect(parseCapabilitySignal(make(replace("nip05", ["nip05", "_@service.com"]))).ok).toBe(true);
    expect(parseCapabilitySignal(make(replace("nip05", ["nip05", "a.b-c_9@service.com"]))).ok).toBe(true);
  });
  it("rejects a missing tag and a duplicate tag", () => {
    expect(parseCapabilitySignal(make(without("nip05"))).ok).toBe(false);
    expect(parseCapabilitySignal(make([...base(), ["nip05", "other@service.com"]])).ok).toBe(false);
  });
  it("rejects names with characters NIP-05 does not allow", () => {
    for (const bad of ["API@service.com", "a b@service.com", "a+b@service.com", "@service.com"]) {
      expect(parseCapabilitySignal(make(replace("nip05", ["nip05", bad]))).ok).toBe(false);
    }
  });
  it("rejects a domain that is not a plain hostname", () => {
    for (const bad of ["api@", "api@service", "api@service.com/path", "api@service.com:8080", "api@a@b.com", "api@-bad.com", "api@sp ace.com"]) {
      expect(parseCapabilitySignal(make(replace("nip05", ["nip05", bad]))).ok).toBe(false);
    }
  });
});

describe("capability signal: region tags", () => {
  it("keeps every region, in order", () => {
    const r = parseCapabilitySignal(make([...base(), ["region", "KE"]]));
    expect(r.ok && r.value.regions).toEqual(["NG", "KE"]);
  });
  it("needs at least one", () => {
    expect(parseCapabilitySignal(make(without("region"))).ok).toBe(false);
  });
  it("rejects anything that is not two uppercase letters", () => {
    for (const bad of ["ng", "NGA", "N", "N1", ""]) {
      expect(parseCapabilitySignal(make(replace("region", ["region", bad]))).ok).toBe(false);
    }
  });
});

describe("capability signal: rail tags", () => {
  it("keeps every rail, in order", () => {
    const r = parseCapabilitySignal(make([...base(), ["rail", "m-pesa"]]));
    expect(r.ok && r.value.rails).toEqual(["bank_transfer", "m-pesa"]);
  });
  it("needs at least one, and none may be empty", () => {
    expect(parseCapabilitySignal(make(without("rail"))).ok).toBe(false);
    expect(parseCapabilitySignal(make(replace("rail", ["rail", "  "]))).ok).toBe(false);
  });
});

describe("capability signal: currency tags", () => {
  it("keeps every currency, in order", () => {
    const r = parseCapabilitySignal(make([...base(), ["currency", "BTC"]]));
    expect(r.ok && r.value.currencies).toEqual(["NGN", "BTC"]);
  });
  it("accepts 3 to 5 uppercase letters or digits", () => {
    for (const good of ["NGN", "BTC", "USDT", "USDC1"]) {
      expect(parseCapabilitySignal(make(replace("currency", ["currency", good]))).ok).toBe(true);
    }
  });
  it("needs at least one", () => {
    expect(parseCapabilitySignal(make(without("currency"))).ok).toBe(false);
  });
  it("rejects lowercase, too short, too long, and symbols", () => {
    for (const bad of ["ngn", "NG", "USDTXX", "N-N", "N N", ""]) {
      expect(parseCapabilitySignal(make(replace("currency", ["currency", bad]))).ok).toBe(false);
    }
  });
});

describe("capability signal: capacity_tier tag", () => {
  it("reads the value as given", () => {
    const r = parseCapabilitySignal(make(base()));
    expect(r.ok && r.value.capacityTier).toBe("tier_3");
  });
  it("needs exactly one, and it must not be empty", () => {
    expect(parseCapabilitySignal(make(without("capacity_tier"))).ok).toBe(false);
    expect(parseCapabilitySignal(make([...base(), ["capacity_tier", "tier_1"]])).ok).toBe(false);
    expect(parseCapabilitySignal(make(replace("capacity_tier", ["capacity_tier", ""]))).ok).toBe(false);
  });
});

describe("capability signal: expiration tag and liveness", () => {
  it("reads the timestamp as a number", () => {
    const r = parseCapabilitySignal(make(base()));
    expect(r.ok && r.value.expiration).toBe(1783296000);
  });
  it("needs exactly one", () => {
    expect(parseCapabilitySignal(make(without("expiration"))).ok).toBe(false);
    expect(parseCapabilitySignal(make([...base(), ["expiration", "1783296001"]])).ok).toBe(false);
  });
  it("rejects anything that is not whole seconds", () => {
    for (const bad of ["", "soon", "-5", "1.5", "1e9", "0x10", "99999999999999999999"]) {
      expect(parseCapabilitySignal(make(replace("expiration", ["expiration", bad]))).ok).toBe(false);
    }
  });
  it("is live through the expiration second and offline one second after", () => {
    const r = parseCapabilitySignal(make(base()));
    if (!r.ok) throw new Error("parse failed");
    expect(isSignalLive(r.value, 1783295999)).toBe(true);
    expect(isSignalLive(r.value, 1783296000)).toBe(true);
    expect(isSignalLive(r.value, 1783296001)).toBe(false);
  });
});

describe("capability signal: endpoint tag", () => {
  it("reads the url and the port", () => {
    const r = parseCapabilitySignal(make(base()));
    expect(r.ok && r.value.endpoint).toEqual({ url: "https://api.service.com", port: 443 });
  });
  it("needs exactly one", () => {
    expect(parseCapabilitySignal(make(without("endpoint"))).ok).toBe(false);
    expect(parseCapabilitySignal(make([...base(), ["endpoint", "https://b.service.com", "443"]])).ok).toBe(false);
  });
  it("needs a port", () => {
    expect(parseCapabilitySignal(make(replace("endpoint", ["endpoint", "https://api.service.com"]))).ok).toBe(false);
  });
  it("rejects ports that are not whole numbers from 1 to 65535", () => {
    for (const bad of ["0", "65536", "-1", "44.3", "https", "", "4 43"]) {
      expect(parseCapabilitySignal(make(replace("endpoint", ["endpoint", "https://api.service.com", bad]))).ok).toBe(false);
    }
  });
  it("accepts the edge ports", () => {
    for (const good of ["1", "65535", "8443"]) {
      expect(parseCapabilitySignal(make(replace("endpoint", ["endpoint", "https://api.service.com", good]))).ok).toBe(true);
    }
  });
  it("rejects urls that are not absolute https urls", () => {
    for (const bad of ["http://api.service.com", "ftp://api.service.com", "api.service.com", "//api.service.com", "javascript:alert(1)", "file:///etc/passwd", ""]) {
      expect(parseCapabilitySignal(make(replace("endpoint", ["endpoint", bad, "443"]))).ok).toBe(false);
    }
  });
  it("rejects urls with a username or password", () => {
    expect(parseCapabilitySignal(make(replace("endpoint", ["endpoint", "https://user:pw@api.service.com", "443"]))).ok).toBe(false);
    expect(parseCapabilitySignal(make(replace("endpoint", ["endpoint", "https://user@api.service.com", "443"]))).ok).toBe(false);
  });
});

describe("capability signal: builder", () => {
  const input = () => ({
    nip05: "api@service.com",
    regions: ["NG", "KE"],
    currencies: ["NGN", "KES"],
    rails: ["bank_transfer", "m-pesa"],
    capacityTier: "tier_3",
    expiration: 1783296000,
    endpoint: { url: "https://api.service.com", port: 443 },
    content: "SLA window 06:00 to 22:00",
    createdAt: 1782691200,
  });
  it("builds an event the parser accepts, with the values we gave", () => {
    const signed = finalizeEvent(buildCapabilitySignal(input()), sk);
    const r = parseCapabilitySignal(signed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.regions).toEqual(["NG", "KE"]);
    expect(r.value.currencies).toEqual(["NGN", "KES"]);
    expect(r.value.rails).toEqual(["bank_transfer", "m-pesa"]);
    expect(r.value.expiration).toBe(1783296000);
    expect(r.value.endpoint).toEqual({ url: "https://api.service.com", port: 443 });
    expect(signed.content).toBe("SLA window 06:00 to 22:00");
  });
  it("uses kind 30078 and puts the d tag in", () => {
    const t = buildCapabilitySignal(input());
    expect(t.kind).toBe(30078);
    expect(t.tags).toContainEqual(["d", "capability-signal"]);
  });
  it("defaults created_at to now and content to empty", () => {
    const { createdAt, content, ...rest } = input();
    const t = buildCapabilitySignal(rest);
    expect(Math.abs(t.created_at - Math.floor(Date.now() / 1000))).toBeLessThan(5);
    expect(t.content).toBe("");
  });
  it("refuses to build something the parser would reject", () => {
    expect(() => buildCapabilitySignal({ ...input(), regions: [] })).toThrow(/region/);
    expect(() => buildCapabilitySignal({ ...input(), currencies: ["ngn"] })).toThrow(/currency/);
    expect(() => buildCapabilitySignal({ ...input(), endpoint: { url: "http://x.com", port: 80 } })).toThrow(/endpoint/);
    expect(() => buildCapabilitySignal({ ...input(), nip05: "bad" })).toThrow(/nip05/);
  });
});