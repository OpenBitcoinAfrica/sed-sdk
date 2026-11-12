/**
 * A guided, narrated run through every piece of the SDK, in the order a
 * real service would actually use them: build a signal, sign it, verify
 * it, check that the signing key was authorized, run every SeD-06 phase 1
 * check together, publish and read it back from a relay, build and
 * decrypt a private attestation between two other services, mine proof of
 * work for relays that ask for it, collect a trust graph from relays that
 * only return a few events at a time, and cache the domain check.
 *
 * Run it with:
 *
 *   npx tsx examples/walkthrough.ts
 *
 * Nothing here needs a real network connection or a real domain. The
 * identity check below fakes the HTTP call a domain's nostr.json would
 * answer, and the relay step fakes the relay pool, so the whole thing
 * runs offline and deterministically. The one line to change to run the
 * relay step against a real relay is marked where it happens.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getConversationKey } from "nostr-tools/nip44";
import {
  addProofOfWork,
  buildAttestation,
  buildCapabilitySignal,
  buildPrivateAttestation,
  buildRevocation,
  collectTrustGraph,
  createNostrJsonCache,
  decryptPrivateAttestation,
  evaluateTrust,
  fetchEvents,
  getEventDifficulty,
  isEventSignatureValid,
  meetsDifficulty,
  parseCapabilitySignal,
  parsePrivateAttestationEnvelope,
  parseRequiredPowBits,
  privateAttestationDTag,
  publishEvent,
  resolveServiceIdentity,
  resolveTrustedSignal,
  type NostrEvent,
  type RelayPool,
  type Revocation,
} from "../src/sed/index.js";

function step(title: string) {
  console.log(`\n--- ${title} ---`);
}

// ---------------------------------------------------------------------
step("1. Two keys");
// ---------------------------------------------------------------------
// Every service has two keys. The IPK (identity public key) is the one
// that's rare to touch, the one reputation attaches to. The OPK
// (operational public key) is the one that actually signs day-to-day
// capability signals, and is expected to rotate.

const ipkSecret = generateSecretKey();
const ipk = getPublicKey(ipkSecret);

const opkSecret = generateSecretKey();
const opk = getPublicKey(opkSecret);

console.log("IPK (cold, identity):", ipk);
console.log("OPK (hot, operational):", opk);

// ---------------------------------------------------------------------
step("2. Build and sign a capability signal (SeD-02)");
// ---------------------------------------------------------------------
// This is the event a service publishes to say what it offers: which
// regions, which currencies, which payment rails, how much volume it can
// handle, and where to reach it. buildCapabilitySignal returns an
// *unsigned* event; it refuses to build anything its own parser would
// reject, so a mistake here is caught before it's ever signed.

const now = Math.floor(Date.now() / 1000);

const unsignedSignal = buildCapabilitySignal({
  nip05: "api@example.com",
  regions: ["NG", "KE"],
  currencies: ["NGN", "KES"],
  rails: ["bank_transfer", "m-pesa"],
  capacityTier: "tier_3",
  expiration: now + 7 * 24 * 60 * 60,
  endpoint: { url: "https://api.example.com", port: 443 },
});

// Signing is the one step this SDK doesn't do for you: finalizeEvent is
// nostr-tools' own function. It stamps created_at, computes the event id,
// and signs with whichever key you hand it, here the OPK, because the
// OPK is what's supposed to sign capability signals, never the IPK.
const signal = finalizeEvent(unsignedSignal, opkSecret);

console.log("Signed signal id:", signal.id);
console.log("Signed by (pubkey on the event):", signal.pubkey);

// ---------------------------------------------------------------------
step("3. Verify the signature (SeD-06 phase 1, verify.ts)");
// ---------------------------------------------------------------------
// This recomputes the event's hash and checks the schnorr signature
// itself, every time. It does not use nostr-tools' own verifyEvent,
// because that function caches its answer on the event object, and the
// cache survives a spread like { ...event, content: "..." }. Watch:

console.log("Genuine signal verifies:", isEventSignatureValid(signal));

// A capability signal carries its real data in tags, not in content (which
// is just ""), so the forgery has to touch a tag to actually change
// anything. id and sig are left exactly as they were on the genuine event.
const forged: NostrEvent = {
  ...signal,
  tags: signal.tags.map((tag) => (tag[0] === "currency" ? ["currency", "USD"] : tag)),
};
console.log("Tampered copy (a currency tag swapped, id and sig left alone) verifies:", isEventSignatureValid(forged));

// ---------------------------------------------------------------------
step("4. Parse it (SeD-02, signal.ts)");
// ---------------------------------------------------------------------
// Verifying a signature only proves who signed the bytes. Parsing is
// separate: it checks the event is shaped like a real capability signal
// (right kind, well-formed tags, not expired) and returns structured
// fields instead of raw tag arrays.

const parsed = parseCapabilitySignal(signal);
if (!parsed.ok) throw new Error("unexpected: " + parsed.errors.join(", "));
console.log("Domain:", parsed.value.domain);
console.log("Operational key name (left of the @ in nip05):", parsed.value.name);
console.log("Regions:", parsed.value.regions);

// ---------------------------------------------------------------------
step("5. Check the OPK was actually authorized to sign this (SeD-01, identity.ts)");
// ---------------------------------------------------------------------
// A signature only proves the event was signed by whoever holds that
// private key. It says nothing about whether that key is allowed to
// speak for "example.com". SeD-01 answers that by fetching
// https://example.com/.well-known/nostr.json and checking the key
// against the "api" entry there, with "_" giving the real identity key.
//
// There's no real example.com to ask, so fetchImpl here is a fake
// fetch standing in for the real HTTP call. On a real domain you would
// just omit fetchImpl and let resolveSignalIdentity use the real fetch.

const fakeNostrJson = {
  names: {
    _: ipk,
    api: opk,
  },
};

const fakeFetch = async () =>
  ({
    ok: true,
    json: async () => fakeNostrJson,
  }) as Response;

// resolveTrustedSignal (next step) calls this under the hood, but it's
// worth seeing resolveServiceIdentity / resolveSignalIdentity run on
// their own first, since this is the step most people ask about.
const { resolveSignalIdentity } = await import("../src/sed/identity.js");
const identity = await resolveSignalIdentity(parsed.value, { fetchImpl: fakeFetch });
if (!identity.ok) throw new Error("unexpected: " + identity.errors.join(", "));
console.log("Authorized. Real identity key (ipk) for this domain:", identity.value.ipk);

// ---------------------------------------------------------------------
step("6. Run every phase 1 check together (SeD-06 phase 1, trust.ts)");
// ---------------------------------------------------------------------
// resolveTrustedSignal is the one call most code will actually use: it
// runs signature, parsing, expiry, SeD-01 identity and revocation in
// order, stopping at the first failure, and returns the parsed signal
// plus its resolved identity together.
//
// Revocations aren't fetched for you, that's the relay step's job, so
// an empty list here means "nothing known to be revoked."

const noRevocations: Revocation[] = [];
const trusted = await resolveTrustedSignal(signal, noRevocations, undefined, { fetchImpl: fakeFetch });
if (!trusted.ok) throw new Error("unexpected: " + trusted.errors.join(", "));
console.log("Trusted. Domain:", trusted.value.signal.domain, "backed by ipk:", trusted.value.identity.ipk);

// Now watch it fail once the OPK is revoked. buildRevocation needs to be
// signed by the IPK, since revoking an operational key is exactly the
// kind of thing only the identity key should be able to do.
const unsignedRevocation = buildRevocation({ revokedOpk: opk, reason: "key rotated" });
const revocation = finalizeEvent(unsignedRevocation, ipkSecret);
const { parseRevocation } = await import("../src/sed/revocation.js");
const parsedRevocation = parseRevocation(revocation);
if (!parsedRevocation.ok) throw new Error("unexpected: " + parsedRevocation.errors.join(", "));

const trustedAfterRevocation = await resolveTrustedSignal(signal, [parsedRevocation.value], undefined, { fetchImpl: fakeFetch });
console.log("Trusted after the OPK is revoked:", trustedAfterRevocation.ok, trustedAfterRevocation.ok ? "" : `(${trustedAfterRevocation.errors.join(", ")})`);

// ---------------------------------------------------------------------
step("7. Publish it and read it back (SeD-04, relay.ts)");
// ---------------------------------------------------------------------
// This is the one step faked for a reason beyond convenience: real
// relay connections need an actual network, which this walkthrough
// doesn't assume you have reachable right now. The fake pool below
// implements the same two-method RelayPool shape (publish, querySync)
// that createRelayPool()'s real one does, so publishEvent and
// fetchEvents don't know or care that it's fake.
//
// To run this against real relays instead, replace the `fakePool`
// below with:
//
//   import { createRelayPool } from "../src/sed/index.js";
//   const pool = createRelayPool();
//   const relays = ["wss://relay.damus.io", "wss://nos.lol"];
//
// and nothing else in this step needs to change.

const published: NostrEvent[] = [];
const fakePool: RelayPool = {
  publish: (relays, event) => {
    published.push(event);
    return relays.map(() => Promise.resolve("ok"));
  },
  querySync: async () => [...published],
};

const relays = ["wss://relay-a.example", "wss://relay-b.example"];

const outcomes = await publishEvent(fakePool, relays, signal);
for (const outcome of outcomes) {
  console.log(outcome.relay, outcome.ok ? "accepted" : `rejected: ${outcome.reason}`);
}

const fetched = await fetchEvents(fakePool, relays, { kinds: [30078] });
console.log("Read back", fetched.length, "event(s); id matches what was published:", fetched[0]?.id === signal.id);

// ---------------------------------------------------------------------
step("8. Private attestations (SeD-03 section 3.6, private-attestation.ts)");
// ---------------------------------------------------------------------
// A different scenario from everything above: Service B wants to attest
// to Service A's track record (the ipk from step 1 is the subject here),
// but only wants Service C, a specific consortium partner, to be able to
// read it. Nobody else should learn who's being attested, or what the
// attestation says, not even that this event concerns Service A at all.

const serviceBSecret = generateSecretKey();
const serviceB = getPublicKey(serviceBSecret);
const serviceCSecret = generateSecretKey();
const serviceC = getPublicKey(serviceCSecret);

// buildPrivateAttestation builds the real attestation the same way
// buildAttestation always does, then encrypts it (NIP-44) for serviceC
// alone. It needs the attester's secret key, not just their public key,
// because the encryption itself depends on it, not only the signature.
const unsignedAttestation = buildPrivateAttestation({
  subject: ipk,
  type: "liquidity",
  highestVolumeTier: "tier_3",
  slaCompliance: "target_met",
  attesterSecretKey: serviceBSecret,
  recipientPubkey: serviceC,
});
const attestation = finalizeEvent(unsignedAttestation, serviceBSecret);

console.log("Does the public event mention Service A's real ipk anywhere?", JSON.stringify(attestation.tags).includes(ipk));

// Anyone can check who it's addressed to without any key at all, that's
// the point of tagging the recipient instead of the subject.
const envelope = parsePrivateAttestationEnvelope(attestation);
if (!envelope.ok) throw new Error("unexpected: " + envelope.errors.join(", "));
console.log("Publicly visible: addressed to Service C:", envelope.value.recipient === serviceC);

// Service C decrypts it with their own secret key and Service B's pubkey
// (sitting right there on the event, no lookup needed).
const asRecipient = decryptPrivateAttestation(attestation, serviceCSecret, serviceB);
if (!asRecipient.ok) throw new Error("unexpected: " + asRecipient.errors.join(", "));
console.log("Service C decrypts it. Real subject matches Service A's ipk:", asRecipient.value.subject === ipk);
console.log("Tier:", asRecipient.value.highestVolumeTier, " SLA:", asRecipient.value.slaCompliance);

// Some unrelated key cannot, NIP-44 authenticates as well as encrypts, so
// a wrong key fails cleanly rather than decrypting to garbage.
const outsiderSecret = generateSecretKey();
const asOutsider = decryptPrivateAttestation(attestation, outsiderSecret, serviceB);
console.log("An unrelated key cannot decrypt it:", !asOutsider.ok);

// The public "d" tag (relays need one to know a newer attestation replaces
// an older one) is a hash of Service B and Service C's own shared secret,
// not the plain "attestation:<subject>:<type>" text a public attestation
// uses. Both sides can derive it independently, from their own keys, and
// it looks like noise to anyone else.
const conversationKeyAsB = getConversationKey(serviceBSecret, serviceC);
const conversationKeyAsC = getConversationKey(serviceCSecret, serviceB);
const dTagFromB = privateAttestationDTag(conversationKeyAsB, ipk, "liquidity");
const dTagFromC = privateAttestationDTag(conversationKeyAsC, ipk, "liquidity");
console.log("Service B and Service C derive the same d tag independently:", dTagFromB === dTagFromC && dTagFromB === envelope.value.dTag);

// ---------------------------------------------------------------------
step("9. Proof of work for relays that ask for it (SeD-04 section 4.2, pow.ts)");
// ---------------------------------------------------------------------
// Some relays only take capability signals whose id starts with a number
// of zero bits (NIP-13). The work has to be mined into the unsigned
// event before it is signed, and it has to be mined for the key that
// will sign, because the pubkey is part of what gets hashed. 12 bits is
// instant; real relays often want 20 or more.

const mined = addProofOfWork(unsignedSignal, opk, 12);
const minedSignal = finalizeEvent(mined, opkSecret);
console.log("Difficulty of the signed event:", getEventDifficulty(minedSignal), "bits");
console.log("Meets 12 bits:", meetsDifficulty(minedSignal, 12));

// When a relay refuses an event for lacking work, its message usually says
// how much it wants. publishEvent reads that out for you as requiredPowBits.
console.log('Reading "pow: difficulty 25>=30" gives:', parseRequiredPowBits("pow: difficulty 25>=30"));

// ---------------------------------------------------------------------
step("10. Collect a trust graph from relays that only answer a few at a time (fetch.ts)");
// ---------------------------------------------------------------------
// A relay caps how many events one query returns. collectTrustGraph keeps
// asking, hop by hop outward from your anchors, and fetches only the
// attestations evaluateTrust can use. This fake relay answers two events
// at a time, to show the paging working.

const anchorSecret = generateSecretKey();
const anchor = getPublicKey(anchorSecret);
const partnerSecret = generateSecretKey();
const partner = getPublicKey(partnerSecret);
const newcomerSecret = generateSecretKey();
const newcomer = getPublicKey(newcomerSecret);

const network: NostrEvent[] = [
  // You trust the anchor. The anchor vouches for a partner. The partner vouches for a newcomer.
  finalizeEvent(buildAttestation({ subject: partner, type: "liquidity", lastActive: now }), anchorSecret),
  finalizeEvent(buildAttestation({ subject: newcomer, type: "liquidity", lastActive: now }), partnerSecret),
  // Noise from elsewhere on the network that the walk should never download.
  ...Array.from({ length: 5 }, (_, i) => {
    const stranger = generateSecretKey();
    return finalizeEvent(
      buildAttestation({ subject: getPublicKey(generateSecretKey()), type: "liquidity", createdAt: now - i, lastActive: now }),
      stranger,
    );
  }),
];

const smallPagesRelay: RelayPool = {
  publish: () => [],
  querySync: async (_relays, filter) =>
    network
      .filter((e) => (!filter.kinds || filter.kinds.includes(e.kind)) && (!filter.authors || filter.authors.includes(e.pubkey)))
      .filter((e) => !filter["#p"] || e.tags.some((tag) => tag[0] === "p" && filter["#p"]!.includes(tag[1] ?? "")))
      .filter((e) => (filter.until === undefined || e.created_at <= filter.until))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 2),
};

const graph = await collectTrustGraph(smallPagesRelay, relays, [anchor], { candidateIpk: newcomer });
console.log("Collected", graph.attestations.length, "attestation(s) out of", network.length, "on the network. Cut short:", graph.truncated);

const evidence = evaluateTrust(newcomer, graph.attestations, [anchor], { type: "liquidity" });
console.log("Newcomer is", evidence.distance, "hops from the anchor, reliability:", evidence.reliability);

// ---------------------------------------------------------------------
step("11. Reuse nostr.json with a cache (identity.ts)");
// ---------------------------------------------------------------------
// By default every identity check downloads the domain's nostr.json
// again. With a cache, repeat checks within the lifetime skip the
// download. Keep the lifetime short: a key the domain has just removed
// keeps passing until its cached entry expires.

let downloads = 0;
const countingFetch = (async () => {
  downloads++;
  return { ok: true, json: async () => fakeNostrJson } as Response;
}) as typeof fetch;

const cache = createNostrJsonCache({ ttlMs: 60_000 });
for (let i = 0; i < 3; i++) {
  await resolveServiceIdentity("example.com", "api", opk, { fetchImpl: countingFetch, cache });
}
console.log("Three checks, downloads of nostr.json:", downloads);

step("Done");