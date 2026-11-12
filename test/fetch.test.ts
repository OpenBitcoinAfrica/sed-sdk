import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "../src/sed/common.js";
import { buildAttestation } from "../src/sed/attestation.js";
import { buildRevocation } from "../src/sed/revocation.js";
import { evaluateTrust } from "../src/sed/reputation.js";
import type { Filter, RelayPool } from "../src/sed/relay.js";
import {
  collectTrustGraph,
  fetchAllEvents,
  fetchAttestationsAbout,
  fetchRevocationsFor,
} from "../src/sed/fetch.js";

const NOW = Math.floor(Date.now() / 1000);

/** A relay that honours kinds, authors, #p, #d, since, until and limit, and caps every answer. */
function fakeRelay(events: NostrEvent[], cap = Number.POSITIVE_INFINITY, log: Filter[] = []): RelayPool {
  return {
    publish: () => [],
    querySync: async (_relays, filter) => {
      log.push(filter);
      const tag = (e: NostrEvent, name: string) => e.tags.filter((t) => t[0] === name).map((t) => t[1]);
      const hits = events.filter(
        (e) =>
          (!filter.kinds || filter.kinds.includes(e.kind)) &&
          (!filter.authors || filter.authors.includes(e.pubkey)) &&
          (!filter["#p"] || filter["#p"].some((v) => tag(e, "p").includes(v))) &&
          (!filter["#d"] || filter["#d"].some((v) => tag(e, "d").includes(v))) &&
          (filter.since === undefined || e.created_at >= filter.since) &&
          (filter.until === undefined || e.created_at <= filter.until),
      );
      hits.sort((a, b) => b.created_at - a.created_at);
      return hits.slice(0, Math.min(filter.limit ?? Infinity, cap));
    },
  };
}

const keyPair = () => {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
};

const note = (sk: Uint8Array, createdAt: number, content = ""): NostrEvent =>
  finalizeEvent({ kind: 1, created_at: createdAt, tags: [], content: content || String(createdAt) + Math.random() }, sk);

const attest = (from: { sk: Uint8Array }, subject: string, extra: object = {}): NostrEvent =>
  finalizeEvent(buildAttestation({ subject, type: "liquidity", lastActive: NOW, ...extra }), from.sk);

describe("fetchAllEvents", () => {
  const author = keyPair();

  it("returns everything even when the relay caps each answer far below the total", async () => {
    const events = Array.from({ length: 10 }, (_, i) => note(author.sk, 1000 + i));
    const r = await fetchAllEvents(fakeRelay(events, 3), ["r"], { kinds: [1] });
    expect(r.events).toHaveLength(10);
    expect(r.truncated).toBe(false);
  });

  it("returns events newest first", async () => {
    const events = Array.from({ length: 7 }, (_, i) => note(author.sk, 2000 + i));
    const r = await fetchAllEvents(fakeRelay(events, 2), ["r"], { kinds: [1] });
    const times = r.events.map((e) => e.created_at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("gets past a second that holds as many events as one page", async () => {
    const stamps = [10, 9, 9, 9, 8, 7];
    const events = stamps.map((t) => note(author.sk, t));
    const r = await fetchAllEvents(fakeRelay(events, 3), ["r"], { kinds: [1] });
    expect(r.events.map((e) => e.created_at)).toEqual([10, 9, 9, 9, 8, 7]);
  });

  it("removes duplicates returned by several relays", async () => {
    const events = [note(author.sk, 5), note(author.sk, 4)];
    const dup: RelayPool = {
      publish: () => [],
      querySync: async () => [...events, ...events],
    };
    const r = await fetchAllEvents(dup, ["a", "b"], { kinds: [1] });
    expect(r.events).toHaveLength(2);
  });

  it("returns nothing, not truncated, when the relays have nothing", async () => {
    const r = await fetchAllEvents(fakeRelay([]), ["r"], { kinds: [1] });
    expect(r).toEqual({ events: [], truncated: false });
  });

  it("stops at maxEvents, returns that many of the newest, and says it was cut short", async () => {
    const events = Array.from({ length: 20 }, (_, i) => note(author.sk, 100 + i));
    const r = await fetchAllEvents(fakeRelay(events, 5), ["r"], { kinds: [1] }, { maxEvents: 8 });
    expect(r.events).toHaveLength(8);
    expect(r.truncated).toBe(true);
    expect(r.events[0]!.created_at).toBe(119);
  });

  it("stops at maxPages and says it was cut short", async () => {
    const events = Array.from({ length: 20 }, (_, i) => note(author.sk, 100 + i));
    const log: Filter[] = [];
    const r = await fetchAllEvents(fakeRelay(events, 2, log), ["r"], { kinds: [1] }, { maxPages: 3 });
    expect(log).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it("respects since and until", async () => {
    const events = Array.from({ length: 10 }, (_, i) => note(author.sk, 100 + i));
    const r = await fetchAllEvents(fakeRelay(events, 3), ["r"], { kinds: [1], since: 103, until: 107 });
    expect(r.events.map((e) => e.created_at)).toEqual([107, 106, 105, 104, 103]);
  });

  it("uses filter.limit as the page size", async () => {
    const events = Array.from({ length: 6 }, (_, i) => note(author.sk, 100 + i));
    const log: Filter[] = [];
    await fetchAllEvents(fakeRelay(events, 100, log), ["r"], { kinds: [1], limit: 4 });
    expect(log[0]!.limit).toBe(4);
  });

  it("does not loop forever when a relay keeps answering with the same events", async () => {
    const same = [note(author.sk, 50)];
    const stuck: RelayPool = { publish: () => [], querySync: async () => same };
    const r = await fetchAllEvents(stuck, ["r"], { kinds: [1] }, { maxPages: 10 });
    expect(r.events).toHaveLength(1);
  });
});

describe("fetchAttestationsAbout", () => {
  const a = keyPair();
  const b = keyPair();
  const subject = keyPair();
  const other = keyPair();

  it("returns only attestations naming the subject, parsed", async () => {
    const relay = fakeRelay([attest(a, subject.pk), attest(b, subject.pk), attest(a, other.pk)]);
    const r = await fetchAttestationsAbout(relay, ["r"], subject.pk);
    expect(r.attestations.map((x) => x.subject)).toEqual([subject.pk, subject.pk]);
    expect(r.truncated).toBe(false);
  });

  it("keeps only the newest attestation per attester and type", async () => {
    const older = finalizeEvent(buildAttestation({ subject: subject.pk, type: "liquidity", createdAt: NOW - 100, lastActive: NOW - 100 }), a.sk);
    const newer = finalizeEvent(buildAttestation({ subject: subject.pk, type: "liquidity", createdAt: NOW, lastActive: NOW }), a.sk);
    const r = await fetchAttestationsAbout(fakeRelay([older, newer]), ["r"], subject.pk);
    expect(r.attestations).toHaveLength(1);
    expect(r.attestations[0]!.createdAt).toBe(NOW);
  });

  it("counts events that are not valid attestations as skipped", async () => {
    const junk = finalizeEvent({ kind: 30079, created_at: NOW, tags: [["p", subject.pk, "subject"]], content: "" }, a.sk);
    const r = await fetchAttestationsAbout(fakeRelay([attest(b, subject.pk), junk]), ["r"], subject.pk);
    expect(r.attestations).toHaveLength(1);
    expect(r.skipped).toBe(1);
  });

  it("pages through more attestations than the relay returns at once", async () => {
    const many = Array.from({ length: 9 }, (_, i) => attest(keyPair(), subject.pk, { createdAt: NOW - i }));
    const r = await fetchAttestationsAbout(fakeRelay(many, 2), ["r"], subject.pk);
    expect(r.attestations).toHaveLength(9);
  });
});

describe("fetchRevocationsFor", () => {
  const ipk = keyPair();
  const opk = keyPair().pk;
  const otherOpk = keyPair().pk;

  it("returns revocations for that key only", async () => {
    const mine = finalizeEvent(buildRevocation({ revokedOpk: opk, reason: "operational_key_compromise" }), ipk.sk);
    const theirs = finalizeEvent(buildRevocation({ revokedOpk: otherOpk, reason: "operational_key_compromise" }), ipk.sk);
    const r = await fetchRevocationsFor(fakeRelay([mine, theirs]), ["r"], opk);
    expect(r.revocations).toHaveLength(1);
    expect(r.revocations[0]!.revokedOpk).toBe(opk);
    expect(r.revocations[0]!.signer).toBe(ipk.pk);
  });
});

describe("collectTrustGraph", () => {
  const anchor = keyPair();
  const mid = keyPair();
  const far = keyPair();
  const stranger = keyPair();
  const candidate = keyPair();
  const query = { type: "liquidity" as const };

  const network = () => [
    attest(anchor, mid.pk), // anchor vouches for mid: distance 1
    attest(mid, candidate.pk), // mid vouches for candidate: distance 2
    attest(stranger, far.pk), // unrelated corner of the network
    attest(far, candidate.pk), // a vouch for the candidate from outside the graph
  ];

  it("collects what evaluateTrust needs and reaches the same answer as having everything", async () => {
    const events = network();
    const graph = await collectTrustGraph(fakeRelay(events, 2), ["r"], [anchor.pk], { candidateIpk: candidate.pk });
    const everything = (await fetchAllEvents(fakeRelay(events), ["r"], { kinds: [30079] })).events;
    const full = await fetchAttestationsAbout(fakeRelay(everything), ["r"], candidate.pk);

    const collected = evaluateTrust(candidate.pk, graph.attestations, [anchor.pk], query);
    expect(collected.distance).toBe(2);
    expect(collected.supportingAttestations).toHaveLength(2);
    expect(graph.truncated).toBe(false);
    expect(full.attestations).toHaveLength(2);
  });

  it("does not download attestations from outside the graph", async () => {
    const log: Filter[] = [];
    await collectTrustGraph(fakeRelay(network(), 100, log), ["r"], [anchor.pk]);
    const askedAuthors = log.flatMap((f) => f.authors ?? []);
    expect(askedAuthors).toContain(anchor.pk);
    expect(askedAuthors).toContain(mid.pk);
    expect(askedAuthors).not.toContain(stranger.pk);
  });

  it("stops after maxDistance hops", async () => {
    const graph = await collectTrustGraph(fakeRelay(network()), ["r"], [anchor.pk], { maxDistance: 1 });
    expect(graph.attestations.map((a) => a.subject)).toEqual([mid.pk]);
  });

  it("stops early when a hop finds nothing new", async () => {
    const log: Filter[] = [];
    await collectTrustGraph(fakeRelay([], 100, log), ["r"], [anchor.pk], { maxDistance: 5 });
    expect(log.length).toBe(1);
  });

  it("splits a long list of authors across several queries", async () => {
    const many = Array.from({ length: 230 }, () => keyPair().pk);
    const log: Filter[] = [];
    await collectTrustGraph(fakeRelay([], 100, log), ["r"], many, { maxDistance: 1 });
    expect(log.length).toBe(3);
    expect(Math.max(...log.map((f) => f.authors!.length))).toBe(100);
  });

  it("reports truncated when a fetch hits its limit", async () => {
    const graph = await collectTrustGraph(fakeRelay(network(), 1), ["r"], [anchor.pk], { maxPages: 1 });
    expect(graph.truncated).toBe(true);
  });

  it("copes with attestation cycles", async () => {
    const x = keyPair();
    const y = keyPair();
    const events = [attest(x, y.pk), attest(y, x.pk)];
    const graph = await collectTrustGraph(fakeRelay(events), ["r"], [x.pk], { maxDistance: 5 });
    expect(graph.attestations).toHaveLength(2);
  });
});