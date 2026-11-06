# sed-sdk

A TypeScript SDK for the SeD (Service Discovery) protocol, a way for Bitcoin liquidity services in Africa to announce what they offer and build reputation on Nostr.

The SDK is written against the SeD specification at https://github.com/OpenBitcoinAfrica/ServiceDiscoveryProtocol, as it stands in pull request 3. It is not published to npm yet.

## Status

The SDK is feature-complete against the spec as it stands in pull request 3. Reading, checking and building SeD events is done. Checking that an event's signature is genuine is done, so is checking that an operational key is authorized to sign for a service, running every SeD-06 phase 1 check together in one call, publishing to or querying a relay, private (encrypted) attestations, and weighing the evidence a graph of attestations actually provides (SeD-06 phases 2 and 3). What's left is a bridge to the Pontmore agent discovery protocol, which isn't part of SeD itself.

### Implemented

| Piece | Spec | What you get |
|---|---|---|
| Capability signal, kind 30078 | SeD-02 | `parseCapabilitySignal`, `buildCapabilitySignal`, `isSignalLive` |
| Attestation, kind 30079 | SeD-03 | `parseAttestation`, `buildAttestation`, `attestationDTag`, `latestAttestations` |
| Revocation, kind 30080 | SeD-05 | `parseRevocation`, `buildRevocation`, `isOpkRevoked`, `buildSignalDeletion` (the NIP-09 cleanup request) |
| Signature and id verification | SeD-06 phase 1 | `verifyEventSignature`, `isEventSignatureValid` |
| Operational key authorization | SeD-01 | `resolveServiceIdentity`, `resolveSignalIdentity` |
| Combined phase 1 check | SeD-06 phase 1 | `resolveTrustedSignal` |
| Relay transport | SeD-04 | `createRelayPool`, `publishEvent`, `fetchEvents` |
| Private (encrypted) attestations | SeD-03 section 3.6 | `buildPrivateAttestation`, `decryptPrivateAttestation`, `parsePrivateAttestationEnvelope`, `privateAttestationDTag` |
| Trust evaluation | SeD-06 phases 2 and 3 | `evaluateTrust` |
| Shared helpers | | `Result`, `ok`, `fail`, `exactlyOne`, `tagsNamed`, event kinds, tiers, interaction types |

Every parser takes a Nostr event and returns a `Result`: either `{ ok: true, value }` or `{ ok: false, errors }`. Parsers never throw, and they report every problem at once. Every builder returns an unsigned event, and refuses to build anything its own parser would reject.

### Not implemented yet

* A bridge to the Pontmore agent discovery protocol. Not part of SeD itself.
* NIP-13 proof-of-work and Lightning-payment admission for relays that require them (SeD-04 section 4.2). `publishEvent` sends the event as is; a relay enforcing either of these will reject it, and this SDK does not yet mine a PoW nonce or attach an invoice to get past that.

## Getting started

You need Node.js. The code has been run on Node 22, which has `fetch`, `AbortSignal.timeout` and `WebSocket` built in; all three are used.

```
npm install
npm test
```

Other commands:

```
npm run typecheck              # check types without running anything
npm run build                  # compile to dist/
npx tsx examples/walkthrough.ts  # a narrated, step-by-step run through every piece
```

## Example

```ts
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { buildCapabilitySignal, createRelayPool, fetchEvents, publishEvent, resolveTrustedSignal } from "./src/sed/index.js";

const opkSecret = generateSecretKey();
const now = Math.floor(Date.now() / 1000);

// The builder returns an unsigned event.
const unsigned = buildCapabilitySignal({
  nip05: "api@service.com",
  regions: ["NG", "KE"],
  currencies: ["NGN", "KES"],
  rails: ["bank_transfer", "m-pesa"],
  capacityTier: "tier_3",
  expiration: now + 30 * 24 * 60 * 60,
  endpoint: { url: "https://api.service.com", port: 443 },
});

// You sign it with the operational key.
const event = finalizeEvent(unsigned, opkSecret);

const relays = ["wss://relay.damus.io", "wss://nos.lol"];
const pool = createRelayPool();

// Publish it. Each relay answers for itself; some may accept while others don't.
for (const outcome of await publishEvent(pool, relays, event)) {
  console.log(outcome.relay, outcome.ok ? "accepted" : `rejected: ${outcome.reason}`);
}

// Later, or from a different process, pull capability signals back.
const found = await fetchEvents(pool, relays, { kinds: [30078], limit: 50 });

// resolveTrustedSignal runs every SeD-06 phase 1 check in order: signature,
// parsing, expiry, SeD-01 identity, and revocation, stopping at the first
// one that fails. Revocation events are not fetched for you automatically,
// so fetch them yourself the same way and pass the parsed list in.
for (const candidate of found) {
  const trusted = await resolveTrustedSignal(candidate, /* revocations */ []);
  if (trusted.ok) {
    console.log(trusted.value.signal.domain, "is backed by", trusted.value.identity.ipk);
  }
}

pool.destroy();
```

## Project layout

```
src/sed/common.ts        shared types, kinds, tiers and tag helpers
src/sed/signal.ts        SeD-02 capability signal
src/sed/attestation.ts   SeD-03 attestation
src/sed/private-attestation.ts  SeD-03 section 3.6, private (encrypted) attestation
src/sed/revocation.ts    SeD-05 revocation and deletion request
src/sed/reputation.ts    SeD-06 phases 2 and 3, trust evaluation
src/sed/verify.ts        SeD-06 phase 1 signature and id verification
src/sed/identity.ts      SeD-01 operational key authorization
src/sed/trust.ts         SeD-06 phase 1, run end to end
src/sed/relay.ts         SeD-04 relay transport
src/sed/index.ts         exports everything above
test/                    one test file per source file
```

## Where this SDK goes beyond or differs from the spec

These are choices the spec does not settle, or where this SDK is deliberately different. Each one is recorded in the code.

* **Signal lifetime is 90 days, not 7.** SeD-02 says the expiration may be at most 7 days out. This SDK allows up to 90 days, measured from the event's own `created_at`. A client that follows the spec strictly will reject a signal with an expiration beyond 7 days.
* **Currency codes are 3 to 5 uppercase letters or digits.** The spec says an ISO 4217 code or a standard ticker, without a length.
* **Endpoints must be `https` and carry no username or password, and the port tag must agree with the url, even when the url leaves its port implicit.** The spec does not say.
* **The domain in `nip05` must be a plain hostname.** This keeps the later `/.well-known/nostr.json` address safe to build.
* **`capacity_tier` accepts any non-empty text.** The spec shows `tier_3` but does not list allowed values.
* **In an attestation, only `protocol`, `d`, the subject and `type` are required.** The spec's example shows more tags but does not say which are mandatory.
* **Signature checking does not use nostr-tools' own `verifyEvent`.** That function caches its answer on a property it sets on the event object, and the cache survives an object spread such as `{ ...event, content: "something else" }`. A forged event built that way from a genuinely signed one would carry the cached "verified" flag with it. `verifyEventSignature` recomputes the hash and checks the signature itself every time, so a spread-and-edit forgery like that is caught rather than waved through on a stale cache. `createRelayPool` wires this same checker into relay events too, for the same reason.
* **An operational key's name is not assumed to be `api`.** SeD-01's own example uses `api`, but the rule in section 1.2 just says to look up whatever name the signal's `nip05` tag gives. `resolveServiceIdentity` takes that name as an argument rather than hardcoding it, so a service can run several named operational keys (`pos@service.com`, `lightning@service.com`) side by side.
* **`_` and the operational key's own entry must not be the same key.** The spec does not forbid a service from using one key for both the IPK and an OPK, but doing so defeats the reason the two keys exist, so this SDK rejects it.
* **`resolveServiceIdentity` keeps no history.** It only reports what a domain's `nostr.json` says right now. SeD-01 treats OPK rotation as routine and expected, and says nothing about a client needing to notice when the IPK itself changes for a domain it already knew. A caller that wants to notice that has to keep its own record of which IPK it last saw for a domain; this function does not keep one for it.
* **`resolveTrustedSignal` takes `revocations` as a plain argument, it does not fetch them.** This SDK's relay transport can fetch them (`fetchEvents` with `kinds: [30080]`), but `resolveTrustedSignal` itself stays decoupled from any particular transport; the caller wires the two together.
* **Relay transport depends on a narrow `RelayPool` interface, not on nostr-tools' pool directly.** SeD-04 section 4.1 says SeD payloads are not tied to Nostr relays specifically, a DHT or a gossip channel is also allowed. `publishEvent` and `fetchEvents` only need `publish` and `querySync`, so anything with those two methods can stand in for `createRelayPool`'s real one.
* **A private attestation's outer event carries a public tag naming the recipient, not the subject.** SeD-03 section 3.6 says the subject tag "can be restricted or blinded" without saying which. This SDK tags the recipient so they can find it with an ordinary relay filter instead of pulling every private attestation an attester ever published and trying to decrypt each one; the real subject stays inside the encrypted content, built with the exact same `buildAttestation` used for public attestations.
* **A private attestation's public "d" tag is a hash of the attester and recipient's own NIP-44 conversation key, the subject, and the type, not plain text.** The spec doesn't say what the "d" tag should be for a private attestation; using the plain-text `attestation:<subject>:<type>` format would defeat the whole point, since anyone reading the relay would learn exactly who is being attested to. Only the attester and the recipient can ever reconstruct this value, since only they can compute that conversation key (`privateAttestationDTag`).
* **Reaching several consortium members means publishing once per member.** NIP-44 is a point-to-point mechanism, there's no group-encryption primitive in the spec or in NIP-44 itself. `buildPrivateAttestation` encrypts for exactly one recipient; a caller that wants a consortium of five members to all read the same attestation calls it five times.
* **`evaluateTrust` never returns a trust score.** SeD-06's own introduction says SeD "completely rejects numeric scoring algorithms, star ratings, and global reputation weights", but phase 2 also talks about a "proportional risk discount" at distance 2 without ever defining one, no percentage, no formula, anywhere in the spec. Rather than invent a number the protocol explicitly says not to compute, `evaluateTrust` returns the evidence: the graph distance, which attestations support it, any disputes from the caller's own anchors, any conflicting attestations at the same distance. The calling application decides what to do with that.
* **The freshness window and search depth for trust evaluation are both configurable, with defaults.** SeD-06 phase 3 says a client "MAY define freshness windows per interaction type" and phase 2 says a client may "explicitly allow deeper trust paths", neither sets a number. `evaluateTrust` defaults to roughly 6 months for freshness and 2 hops for search depth (matching the spec's own cutoff for when a path stops being reliable), both overridable per call.
* **A capability-relevant query (rail, minimum tier) only ever excludes an attestation that actively contradicts it, never one that simply doesn't mention it.** SeD-03's attestation fields are all optional. Treating a silent field as a mismatch would throw away attestations that just didn't happen to state a rail or tier, rather than ones that genuinely don't qualify.

## Open questions for the spec

* Which values may `capacity_tier` take?
* Which tags in an attestation and a revocation are required?
* For SeD-01: what makes an operational key "expired", separately from the capability signal's own `expiration` tag? How long may a `nostr.json` result be cached before it needs re-checking?
* For SeD-06: what is the "proportional risk discount" at distance 2 actually supposed to be, given section 3.1 says SeD rejects numeric scoring outright? This SDK's answer is to not compute one at all, see "evaluateTrust never returns a trust score" above.

npm install, npm run typecheck, npm test.