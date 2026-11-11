import { describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { resolveServiceIdentity, resolveSignalIdentity } from "../src/sed/identity.js";

const OPK = getPublicKey(generateSecretKey());
const IPK = getPublicKey(generateSecretKey());

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("resolveServiceIdentity: the happy path", () => {
  it("accepts a matching OPK and reads out the IPK", async () => {
    const fetchImpl = mockFetch(200, { names: { _: IPK, api: OPK } });
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(r).toEqual({ ok: true, value: { opkName: "api", domain: "service.com", opk: OPK, ipk: IPK } });
  });

  it("fetches the fixed well-known path over https", async () => {
    const fetchImpl = mockFetch(200, { names: { _: IPK, api: OPK } });
    await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    const [calledUrl] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(calledUrl)).toBe("https://service.com/.well-known/nostr.json");
  });

  it("is not fussy about the name: any name the signal uses is looked up as-is", async () => {
    const fetchImpl = mockFetch(200, { names: { _: IPK, pos: OPK, lightning: OPK } });
    expect((await resolveServiceIdentity("service.com", "pos", OPK, { fetchImpl })).ok).toBe(true);
  });

  it("rejects an uppercase opk from the caller", async () => {
    const fetchImpl = mockFetch(200, { names: { _: IPK, api: OPK } });
    const r = await resolveServiceIdentity("service.com", "api", OPK.toUpperCase(), { fetchImpl });
    expect(r.ok).toBe(false);
  });

  it("compares and returns keys case-insensitively, normalized to lowercase", async () => {
    const fetchImpl = mockFetch(200, { names: { _: IPK.toUpperCase(), api: OPK.toUpperCase() } });
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(r.ok && r.value.ipk).toBe(IPK);
    expect(r.ok && r.value.opk).toBe(OPK);
  });
});

describe("resolveServiceIdentity: rejects a mismatched or malformed record", () => {
  it("rejects when the signing key is not listed under that name", async () => {
    const someoneElse = "a".repeat(64);
    const fetchImpl = mockFetch(200, { names: { _: IPK, api: someoneElse } });
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/does not match the key that signed this event/);
  });

  it("rejects when the name is missing entirely", async () => {
    const fetchImpl = mockFetch(200, { names: { _: IPK } });
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/no "api" entry/);
  });

  it("rejects when the root _ entry is missing", async () => {
    const fetchImpl = mockFetch(200, { names: { api: OPK } });
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/no "_" entry/);
  });

  it("rejects malformed hex coming out of the file", async () => {
    const fetchImpl = mockFetch(200, { names: { _: "not-hex", api: OPK } });
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/"_".*64 hex characters/);
  });

  it("rejects a malformed opk argument before ever fetching", async () => {
    const fetchImpl = mockFetch(200, { names: { _: IPK, api: OPK } });
    const r = await resolveServiceIdentity("service.com", "api", "not-hex", { fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects _ and the OPK name pointing at the same key", async () => {
    const fetchImpl = mockFetch(200, { names: { _: OPK, api: OPK } });
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/must not be the same key/);
  });

  it("rejects a body with no names object", async () => {
    const fetchImpl = mockFetch(200, { hello: "world" });
    expect((await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl })).ok).toBe(false);
  });
});

describe("resolveServiceIdentity: network problems are reported, not confused with forgery", () => {
  it("reports a non-2xx response", async () => {
    const fetchImpl = mockFetch(404, {});
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/could not reach service\.com: HTTP 404/);
  });

  it("reports a fetch that throws, such as a timeout or DNS failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("timed out");
    }) as unknown as typeof fetch;
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/could not reach service\.com: timed out/);
  });

  it("reports a response body that is not valid JSON", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    })) as unknown as typeof fetch;
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/could not reach service\.com/);
  });
});

describe("resolveSignalIdentity", () => {
  it("pulls domain, name and opk straight off a parsed signal", async () => {
    const fetchImpl = mockFetch(200, { names: { _: IPK, api: OPK } });
    const signal = { domain: "service.com", name: "api", opk: OPK };
    const r = await resolveSignalIdentity(signal, { fetchImpl });
    expect(r).toEqual({ ok: true, value: { opkName: "api", domain: "service.com", opk: OPK, ipk: IPK } });
  });
});

describe("resolveServiceIdentity: hostile domains are rejected before any request", () => {
  const hostile = [
    "trusted.com@evil.com",
    "evil.com/x?",
    "evil.com#",
    "evil.com?",
    "evil.com:8443",
    "user:pass@evil.com",
    "127.0.0.1",
    "10.0.0.5",
    "[::1]",
    "localhost",
    "service.com.",
    "",
    "evil.com\\@trusted.com",
    "service .com",
  ];
  for (const domain of hostile) {
    it(`rejects ${JSON.stringify(domain)}`, async () => {
      const fetchImpl = mockFetch(200, { names: { _: IPK, api: OPK } });
      const r = await resolveServiceIdentity(domain, "api", OPK, { fetchImpl });
      expect(r.ok).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  }

  it("returns the host in lowercase, not the text it was given", async () => {
    const fetchImpl = mockFetch(200, { names: { _: IPK, api: OPK } });
    const r = await resolveServiceIdentity("Service.COM", "api", OPK, { fetchImpl });
    expect(r.ok && r.value.domain).toBe("service.com");
  });
});

describe("resolveServiceIdentity: redirects are not followed", () => {
  it("asks fetch to refuse redirects", async () => {
    const fetchImpl = mockFetch(200, { names: { _: IPK, api: OPK } });
    await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init as RequestInit).redirect).toBe("error");
  });

  it("rejects a response that reports it was redirected", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: "https://service.com/.well-known/nostr.json",
      json: async () => ({ names: { _: IPK, api: OPK } }),
    })) as unknown as typeof fetch;
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/redirect/);
  });

  it("rejects a response that came from a different address than the one requested", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      redirected: false,
      url: "https://evil.com/.well-known/nostr.json",
      json: async () => ({ names: { _: IPK, api: OPK } }),
    })) as unknown as typeof fetch;
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl });
    expect(r.ok).toBe(false);
  });
});

describe("resolveServiceIdentity: expectedIpk", () => {
  it("passes when the domain lists the expected IPK", async () => {
    const fetchImpl = mockFetch(200, { names: { _: IPK, api: OPK } });
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl, expectedIpk: IPK.toUpperCase() });
    expect(r.ok).toBe(true);
  });

  it("fails when the domain lists a different IPK", async () => {
    const other = getPublicKey(generateSecretKey());
    const fetchImpl = mockFetch(200, { names: { _: other, api: OPK } });
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl, expectedIpk: IPK });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/not the identity key that was expected/);
  });

  it("rejects a malformed expectedIpk before fetching", async () => {
    const fetchImpl = mockFetch(200, { names: { _: IPK, api: OPK } });
    const r = await resolveServiceIdentity("service.com", "api", OPK, { fetchImpl, expectedIpk: "nope" });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});