# sed-sdk

A TypeScript SDK for the SeD (Service Discovery) protocol, a way for Bitcoin liquidity services in Africa to announce what they offer and build reputation on Nostr.

The SDK is written against the SeD specification at https://github.com/OpenBitcoinAfrica/ServiceDiscoveryProtocol, as it stands in pull request 3. It is not published to npm yet.

## Status

The SDK is unfinished. The first layer, reading, checking and building SeD events, is done. Anything that touches the network, signatures or trust scoring is not.

### Implemented

| Piece | Spec | What you get |
|---|---|---|
| Capability signal, kind 30078 | SeD-02 | `parseCapabilitySignal`, `buildCapabilitySignal`, `isSignalLive` |
| Attestation, kind 30079 | SeD-03 | `parseAttestation`, `buildAttestation`, `attestationDTag`, `latestAttestations` |
| Revocation, kind 30080 | SeD-05 | `parseRevocation`, `buildRevocation`, `isOpkRevoked`, `buildSignalDeletion` (the NIP-09 cleanup request) |
| Shared helpers | | `Result`, `ok`, `fail`, `exactlyOne`, `tagsNamed`, event kinds, tiers, interaction types |

Every parser takes a Nostr event and returns a `Result`: either `{ ok: true, value }` or `{ ok: false, errors }`. Parsers never throw, and they report every problem at once. Every builder returns an unsigned event, and refuses to build anything its own parser would reject.

### Not implemented yet

* Signature and event id verification (SeD-06 phase 1). Until this exists, a successful parse means the event is well formed, not that it is genuine.
* Identity checking (SeD-01): the NIP-05 lookup that proves an operational key may speak for a service.
* A single check that runs signature, expiry, NIP-05 and revocation together.
* Relay transport (SeD-04): publishing to and reading from relays.
* Trust evaluation (SeD-06 phases 2 and 3): anchors, graph distance, disputes, stale data and conflicts.
* Private, encrypted attestations (SeD-03 section 3.6).
* A bridge to the Pontmore agent discovery protocol.

## Getting started

You need Node.js. The code has been run on Node 22.

```
npm install
npm test
```

Other commands:

```
npm run typecheck   # check types without running anything
npm run build       # compile to dist/
npx tsx examples/try-sed.ts   # build, sign, parse and break events by hand
```

## Example

```ts
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { buildCapabilitySignal, isSignalLive, parseCapabilitySignal } from "./src/sed/index.js";

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

// Parsing gives you a clean object, or a list of everything that is wrong.
const result = parseCapabilitySignal(event);

if (result.ok) {
  console.log(result.value.domain, isSignalLive(result.value, now));
} else {
  console.log(result.errors);
}
```

## Project layout

```
src/sed/common.ts        shared types, kinds, tiers and tag helpers
src/sed/signal.ts        SeD-02 capability signal
src/sed/attestation.ts   SeD-03 attestation
src/sed/revocation.ts    SeD-05 revocation and deletion request
src/sed/index.ts         exports everything above
test/                    one test file per source file
examples/try-sed.ts      a script to try the SDK by hand
```

## Where this SDK goes beyond or differs from the spec

These are choices the spec does not settle, or where this SDK is deliberately different. Each one is recorded in the code.

* **Signal lifetime is 90 days, not 7.** SeD-02 says the expiration may be at most 7 days out. This SDK allows up to 90 days, measured from the event's own `created_at`. A client that follows the spec strictly will reject a signal with an expiration beyond 7 days.
* **Currency codes are 3 to 5 uppercase letters or digits.** The spec says an ISO 4217 code or a standard ticker, without a length.
* **Endpoints must be `https` and carry no username or password.** The spec does not say.
* **The domain in `nip05` must be a plain hostname.** This keeps the later `/.well-known/nostr.json` address safe to build.
* **`capacity_tier` accepts any non-empty text.** The spec shows `tier_3` but does not list allowed values.
* **In an attestation, only `protocol`, `d`, the subject and `type` are required.** The spec's example shows more tags but does not say which are mandatory.

## Open questions for the spec

* Which values may `capacity_tier` take?
* Which tags in an attestation and a revocation are required?
* For SeD-01: what makes an operational key "expired", where does the expected identity key come from, how long may a `nostr.json` result be cached, and may a service have several operational key names?
* For SeD-06: what is the "proportional risk discount" at distance 2, what are the default freshness windows, and what counts as "relevance"?