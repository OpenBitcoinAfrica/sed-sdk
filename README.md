# sed-sdk

A TypeScript SDK for SeD (Service Discovery). SeD is a protocol that lets Bitcoin liquidity services announce what they offer on Nostr, and lets other services vouch for them, so a business in one country can find and check a partner in another without flying someone out to meet them.

The SDK is written against the [SeD specification](https://github.com/OpenBitcoinAfrica/ServiceDiscoveryProtocol). The spec is still a draft, and so is this SDK, so expect the API to change before 1.0. It is published on npm as `@openbitcoin-africa/sed-sdk`.

## Contents

* [What SeD is, in two minutes](#what-sed-is-in-two-minutes)
* [Install](#install)
* [Quick start](#quick-start)
* [How to do each job](#how-to-do-each-job)
* [API reference](#api-reference)
* [Things that will catch you out](#things-that-will-catch-you-out)
* [Where this SDK differs from the spec](#where-this-sdk-differs-from-the-spec)
* [Project layout and scripts](#project-layout-and-scripts)
* [What is done and what is pending](#what-is-done-and-what-is-pending)

## What SeD is, in two minutes

Say you run a payment service in Nigeria and you want to open a corridor into Kenya. You need a local partner who can do cash in and cash out. Today you find one through Telegram groups and people you know. SeD gives you a better way.

**Capability signals.** A service publishes a small signed message to Nostr relays that says: these are the countries, currencies and payment rails I support, this is how much volume I can handle, and this is where my API lives. The message expires, so a service that goes quiet drops out of search results on its own.

**Attestations.** A service that has actually done business with another one can publish a signed statement about it: what kind of work it was, what size, whether the other side kept its promises. There is no score and no star rating. Clients read the facts and decide for themselves.

**Two keys per service.** Every service has an identity key (IPK) and an operational key (OPK).

* The IPK is the permanent identity. It stays offline. All reputation attaches to it.
* The OPK is the hot key on the server. It signs capability signals. It can be replaced.

**The domain says which OPK is real.** The service hosts a file at `https://service.com/.well-known/nostr.json`:

```json
{
  "names": {
    "_": "<identity key, the IPK>",
    "api": "<operational key, the OPK>"
  }
}
```

A signal signed by an OPK counts only while that file lists the OPK. That is how a client knows the key really speaks for `service.com`. It is also how a service rotates keys: change the file.

**Trust is worked out on the client.** Nobody hands you a reputation number. You keep a list of services you already trust (your anchors), and the SDK walks the attestations outward from them to show you how close a candidate is, who vouches for it, and whether anyone you trust has flagged it.

The SDK covers all of this: building and checking events, the domain check, revocation, talking to relays, private attestations, and the trust walk.

## Install

You need Node 22 or newer. The SDK uses the built in `fetch`, `AbortSignal.timeout` and `WebSocket`, and Node 20 has no global `WebSocket`.

```
npm install @openbitcoin-africa/sed-sdk
```

Everything is exported from the package root:

```ts
import { buildCapabilitySignal, resolveTrustedSignal } from "@openbitcoin-africa/sed-sdk";
```

The SDK does not sign events or store keys for you. For signing it expects you to use [nostr-tools](https://github.com/nostr-protocol/nostr-tools) (`finalizeEvent`, `generateSecretKey`, `getPublicKey` from `nostr-tools/pure`). The SDK depends on it already, but your own code should install it too, so you do not rely on it being there by accident:

```
npm install nostr-tools
```

## Quick start

This publishes a capability signal and then reads it back as a client would, with every check turned on.

```ts
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import {
  buildCapabilitySignal,
  createRelayPool,
  fetchEvents,
  parseRevocation,
  publishEvent,
  resolveTrustedSignal,
  revocationDTag,
} from "@openbitcoin-africa/sed-sdk";

const relays = ["wss://relay.damus.io", "wss://nos.lol"];
const pool = createRelayPool();

// Service side: build, sign with the operational key, publish.
const opkSecret = generateSecretKey();
const now = Math.floor(Date.now() / 1000);

const unsigned = buildCapabilitySignal({
  nip05: "api@service.com",
  regions: ["NG", "KE"],
  currencies: ["NGN", "KES"],
  rails: ["bank_transfer", "m-pesa"],
  capacityTier: "tier_3",
  expiration: now + 7 * 24 * 60 * 60,
  endpoint: { url: "https://api.service.com", port: 443 },
});
const signal = finalizeEvent(unsigned, opkSecret);

for (const outcome of await publishEvent(pool, relays, signal)) {
  console.log(outcome.relay, outcome.ok ? "accepted" : `rejected: ${outcome.reason}`);
}

// Client side: pull signals, then check each one.
const found = await fetchEvents(pool, relays, { kinds: [30078], limit: 50 });

for (const candidate of found) {
  const revocationEvents = await fetchEvents(pool, relays, {
    kinds: [30080],
    "#d": [revocationDTag(candidate.pubkey)],
  });
  const revocations = revocationEvents.flatMap((e) => {
    const r = parseRevocation(e);
    return r.ok ? [r.value] : [];
  });

  const trusted = await resolveTrustedSignal(candidate, revocations);
  if (trusted.ok) {
    console.log(trusted.value.signal.domain, "is backed by identity key", trusted.value.identity.ipk);
  } else {
    console.log("rejected:", trusted.errors.join("; "));
  }
}

pool.close(relays);
```

With the made up domain above, the check will fail at the domain step, because `service.com` does not list that key. That is the check doing its job. To see a full run that passes, clone this repo and run the offline walkthrough, which fakes the domain and the relays:

```
npx tsx examples/walkthrough.ts
```

## How to do each job

### Results, builders and signing

Every parser takes a Nostr event and returns a `Result`: either `{ ok: true, value }` or `{ ok: false, errors }`. Parsers never throw, and they list every problem they find, not only the first.

```ts
const r = parseCapabilitySignal(event);
if (r.ok) {
  console.log(r.value.domain);
} else {
  console.log(r.errors);
}
```

Every builder returns an unsigned event template. You sign it yourself. A builder checks its own output with the matching parser and throws if the result would be invalid, so you cannot sign a bad event by accident. Builders are the only place the SDK throws.

### Publish a capability signal (service side)

1. Generate an OPK and an IPK. Keep the IPK secret key offline.
2. Host `https://yourdomain/.well-known/nostr.json` with `"_"` set to your IPK and a name of your choice, like `"api"`, set to your OPK. All keys are lowercase hex.
3. Build the signal with `buildCapabilitySignal`, sign it with the OPK, and publish it with `publishEvent`. The `nip05` field must be `<name>@<domain>`, where the name is the one in your `nostr.json`.
4. Publish again before the signal expires. The signal is replaceable, so each new one replaces the last. The SDK allows an expiration up to 90 days out. The spec says 7 days, so use 7 or less if you want to work with strict clients.

You can run more than one OPK, such as `pos@service.com` and `lightning@service.com`, as long as each is listed in `nostr.json`.

### Discover and check signals (client side)

`resolveTrustedSignal(event, revocations, now?, options?)` runs the whole structural check in order and stops at the first failure:

1. the event's signature is genuine
2. the event parses as a capability signal
3. it has not expired
4. the domain's `nostr.json` lists the signing key, and the SDK reads the service's IPK from the same file
5. the OPK has not been revoked by that IPK

On success you get `{ signal, identity }`. `identity.ipk` is the key you use for everything about reputation.

It takes the revocations as an argument and does not fetch them. Fetch them with `fetchEvents` as in the quick start. If you do not use `createRelayPool` to get events, check each event with `verifyEventSignature` yourself, because only that pool checks signatures as events arrive.

**Pin the identity key if you already know it.** `nostr.json` is the only thing linking the OPK to the IPK, so whoever controls that URL controls the link. If you already hold the service's IPK, for example from your anchor set, pass it in:

```ts
const trusted = await resolveTrustedSignal(candidate, revocations, undefined, {
  expectedIpk: knownIpk,
});
```

If the domain now lists a different `_` entry, the check fails. The SDK keeps no history between calls, so remembering past IPKs is up to you.

You can also use the pieces on their own: `parseCapabilitySignal`, `isSignalLive`, `verifyEventSignature`, `resolveServiceIdentity` and `resolveSignalIdentity`.

### Attest to a service (public)

An attestation says "I dealt with this service". It always points at the subject's IPK, never at an OPK. You sign it with your own identity key.

```ts
import { finalizeEvent } from "nostr-tools/pure";
import { buildAttestation, publishEvent } from "@openbitcoin-africa/sed-sdk";

const unsigned = buildAttestation({
  subject: theirIpk,
  type: "liquidity", // liquidity, settlement, integration or custody
  relationshipStart: 1688040000,
  lastActive: Math.floor(Date.now() / 1000),
  verifiedRails: ["m-pesa"],
  highestVolumeTier: "tier_3", // tier_1 to tier_4, coarse volume buckets
  slaCompliance: "target_met", // or "target_missed"
});
const attestation = finalizeEvent(unsigned, myIdentitySecret);
await publishEvent(pool, relays, attestation);
```

Only `subject` and `type` are required. Publishing again with the same subject and type replaces your earlier attestation, so this is also how you update your view when a relationship changes. To warn others about a bad actor, add `disputeMaliciousActor: true`.

`latestAttestations` keeps only the newest attestation for each attester, subject and type, which is what the spec requires before you evaluate anything.

### Attest privately

If you cannot publish who you work with, you can encrypt the attestation for one recipient with NIP-44. The relay sees who it is addressed to, but not who it is about.

```ts
import { finalizeEvent } from "nostr-tools/pure";
import {
  buildPrivateAttestation,
  decryptPrivateAttestation,
  parsePrivateAttestationEnvelope,
} from "@openbitcoin-africa/sed-sdk";

// Attester
const unsigned = buildPrivateAttestation({
  subject: theirIpk,
  type: "liquidity",
  highestVolumeTier: "tier_2",
  slaCompliance: "target_met",
  attesterSecretKey: mySecret, // Uint8Array
  recipientPubkey: partnerPubkey,
});
const event = finalizeEvent(unsigned, mySecret);

// Recipient
const envelope = parsePrivateAttestationEnvelope(event); // who it is for, with no key needed
const inner = decryptPrivateAttestation(event, partnerSecret, event.pubkey);
if (inner.ok) console.log(inner.value.subject, inner.value.slaCompliance);
```

A wrong key or tampered content returns an error result, never a crash. Decrypting does not check the signature, so run `verifyEventSignature` on the event first. One event reaches one recipient. To reach five partners, build five events.

### Weigh the evidence

`evaluateTrust` takes a candidate's IPK, a list of parsed attestations, and your anchors (IPKs you already trust), and tells you what the graph shows.

```ts
import { evaluateTrust, fetchEvents, parseAttestation } from "@openbitcoin-africa/sed-sdk";

const events = await fetchEvents(pool, relays, { kinds: [30079], limit: 1000 });
const attestations = events.flatMap((e) => {
  const r = parseAttestation(e);
  return r.ok ? [r.value] : [];
});

const evidence = evaluateTrust(candidateIpk, attestations, myAnchors, {
  type: "liquidity",
  rail: "m-pesa", // optional
  minTier: "tier_2", // optional
});

console.log(evidence.reliability); // "direct", "indirect", "deep" or "unverified"
console.log(evidence.distance); // hops from your nearest anchor, or null
```

You get evidence, not a score. The spec rejects numeric scoring on purpose, so the SDK does not make one up. The fields:

| Field | Meaning |
|---|---|
| `distance` | Hops from your nearest anchor to the candidate. `null` if there is no path. |
| `reliability` | `direct` for 0 or 1 hop, `indirect` for 2, `deep` for more, `unverified` for no path. |
| `supportingAttestations` | Every relevant, fresh attestation pointing at the candidate. |
| `disputesFromAnchors` | Attestations from your own anchors that dispute the candidate. |
| `overriddenByAnchorDispute` | True if any anchor disputes it. The spec says this should outweigh positive evidence from further away. What you do about it is your call. |
| `conflicting` | True if attesters at the same distance disagree. Show it to the user instead of hiding it. |
| `isolatedCluster` | True if there are positive attestations but no path back to your anchors. This must never make a service trusted by itself. |

By default, attestations older than about six months are ignored and the walk goes two hops. Change them with `freshnessWindowSeconds` and `maxDistance` in the options.

A few things to keep in mind. The function does not check signatures, so pass in attestations that came from `createRelayPool` or that you verified yourself. An attestation only gets filtered out by `rail` or `minTier` when it states something that contradicts your query. One that does not mention a rail or tier stays in. And a disputed candidate still has a distance, because a dispute is still an attestation. Check `overriddenByAnchorDispute`.

### Revoke a compromised operational key

If an OPK is stolen, do these in order:

1. **Fix the domain first.** Remove the OPK from your `nostr.json`. From that moment, clients that check the domain reject the key.
2. **Publish a revocation signed by your IPK.** This is the durable record.
3. **Ask relays to delete the old signal.** This is a request. Relays may ignore it, so it is cleanup, not protection.

```ts
import { finalizeEvent } from "nostr-tools/pure";
import { buildRevocation, buildSignalDeletion, publishEvent } from "@openbitcoin-africa/sed-sdk";

const revocation = finalizeEvent(
  buildRevocation({ revokedOpk: stolenOpk, reason: "operational_key_compromise" }),
  ipkSecret,
);
const deletion = finalizeEvent(buildSignalDeletion(stolenOpk, "Key compromised"), stolenOpkSecret);

await publishEvent(pool, relays, revocation);
await publishEvent(pool, relays, deletion);
```

`isOpkRevoked(opk, serviceIpk, revocations)` only counts a revocation signed by that service's IPK, so nobody else can revoke your key and a fake revocation is ignored.

## API reference

Everything below is exported from `@openbitcoin-africa/sed-sdk`. Deep imports into `dist/` are blocked on purpose, so use the package root only.

### Capability signals (SeD-02)

| Function | What it does |
|---|---|
| `parseCapabilitySignal(event)` | Checks a kind 30078 event and returns the signal fields. |
| `buildCapabilitySignal(input)` | Builds an unsigned signal. Throws if it would be invalid. |
| `isSignalLive(signal, now)` | True while `now` is at or before the signal's expiration. |

### Identity (SeD-01)

| Function | What it does |
|---|---|
| `resolveServiceIdentity(domain, opkName, opk, options?)` | Fetches the domain's `nostr.json`, checks it lists `opk` under `opkName`, and returns `{ opkName, domain, opk, ipk }`. |
| `resolveSignalIdentity(signal, options?)` | The same, taking the domain, name and key from a parsed signal. |

Options: `fetchImpl` (your own `fetch`), `timeoutMs` (default 5000), `expectedIpk`. The `opk` you pass must be lowercase hex. Keys read from the file can be any case.

### Verification and the combined check (SeD-06 phase 1)

| Function | What it does |
|---|---|
| `verifyEventSignature(event)` | Recomputes the event hash and checks the signature. Returns a `Result`. |
| `isEventSignatureValid(event)` | The same, as a boolean. |
| `resolveTrustedSignal(event, revocations, now?, options?)` | Runs signature, parse, expiry, domain and revocation checks. Returns `{ signal, identity }`. |

### Attestations (SeD-03)

| Function | What it does |
|---|---|
| `parseAttestation(event)` | Checks a kind 30079 event and returns the attestation. Flags `isSelfAttestation`. |
| `buildAttestation(input)` | Builds an unsigned attestation. |
| `attestationDTag(subjectIpk, type)` | The `d` tag that makes an attestation replaceable. |
| `latestAttestations(list)` | Keeps the newest per attester, subject and type. |
| `buildPrivateAttestation(input)` | Builds an encrypted attestation for one recipient. |
| `parsePrivateAttestationEnvelope(event)` | Reads the recipient from the outer event, no key needed. |
| `decryptPrivateAttestation(event, myPrivateKey, otherPartyPubkey)` | Decrypts and parses the inner attestation. |
| `privateAttestationDTag(conversationKey, subject, type)` | The hashed `d` tag used for private attestations. |

### Revocation (SeD-05)

| Function | What it does |
|---|---|
| `parseRevocation(event)` | Checks a kind 30080 event. |
| `buildRevocation(input)` | Builds an unsigned revocation. Sign it with the IPK. |
| `revocationDTag(opk)` | The `d` tag of a revocation, useful as a relay filter. |
| `isOpkRevoked(opk, serviceIpk, revocations)` | True if the service's own IPK has revoked that OPK. |
| `buildSignalDeletion(opk, note?)` | Builds the NIP-09 request that asks relays to delete the old signal. |

### Trust evaluation (SeD-06 phases 2 and 3)

| Function | What it does |
|---|---|
| `evaluateTrust(candidateIpk, attestations, anchors, query, options?)` | Returns distance, reliability, supporting attestations, disputes and conflict flags. |

### Relays (SeD-04)

| Function | What it does |
|---|---|
| `createRelayPool(options?)` | A relay pool that checks every incoming event with this SDK's own signature check. |
| `publishEvent(pool, relays, event)` | Sends to every relay. Returns `{ relay, ok, reason }` for each, and never throws. |
| `fetchEvents(pool, relays, filter)` | Queries the relays. Returns events newest first. |

`publishEvent` and `fetchEvents` only need an object with `publish` and `querySync` methods (the `RelayPool` interface). That is what lets you swap in a fake pool in tests, or a different transport.

### Shared helpers

`Result`, `ok`, `fail`, `SED_KINDS`, `MAX_SIGNAL_TTL_SECONDS`, `TIERS`, `INTERACTION_TYPES`, `HEX64`, `nowSeconds`, `tagsNamed`, `exactlyOne`, `requireMany`.

## Things that will catch you out

* **All keys are lowercase hex, 64 characters.** The `opk` you give `resolveServiceIdentity` must be lowercase. A key written in capitals in a `nostr.json` file is fine, because the SDK lowercases what it reads from the file.
* **A good signature is not enough.** `verifyEventSignature` proves nobody changed the event. It does not prove the key belongs to the service. The domain check does that, and `resolveTrustedSignal` runs both.
* **Do not use nostr-tools' `verifyEvent` for this.** It caches its answer on the event object, and the cache survives `{ ...event, content: "x" }`. A forged copy of a real event could pass. The SDK's own check recomputes everything each time.
* **Nothing is cached.** Every identity check fetches `nostr.json` again. The spec wants this, because a key must stop working as soon as the domain stops listing it. If you check many signals from one domain, you may want to batch them yourself.
* **The identity check only tells you what the domain says right now.** Use `expectedIpk` when you know the service already.
* **Revocations and attestations are not fetched for you.** You decide where they come from and pass them in.
* **Expired and revoked are different.** A signal expires by its own `expiration` tag. A key is revoked by an IPK signed notice. Both are checked.
* **Domains are strict.** A `nip05` domain with a port, a username, an IP address, a trailing dot or no dot is rejected before any request is made, and redirects are refused. This is on purpose, so a signal cannot point your client at some other server.
* **Use `ws` on Node if the built in `WebSocket` crashes.** Node's own `WebSocket` is built on undici, which has a history of taking the whole process down when a connection errors out. `createRelayPool({ websocketImplementation })` takes any WebSocket class. `examples/relay-live.ts` shows it with the `ws` package.

## Where this SDK differs from the spec

The spec leaves some things open, and in a few places this SDK is stricter or different on purpose. If you build a client that has to interoperate with others, know these.

* **Signal lifetime is up to 90 days, not 7.** SeD-02 says at most 7. A client that follows the spec strictly will reject a signal with an expiration beyond 7 days.
* **Endpoints must be `https`, with no username or password, and the port tag must match the URL.** An implicit port counts as 443. The spec does not say.
* **Currency codes are 3 to 5 uppercase letters or digits.** The spec gives no length.
* **`capacity_tier` can be any non empty text.** The spec shows `tier_3` but does not list the allowed values.
* **In an attestation only `protocol`, `d`, the subject and `type` are required.** The spec does not say which of its other tags are mandatory.
* **`_` and the OPK's own entry must not be the same key.** The spec does not forbid it, but using one key for both defeats the point of having two.
* **The OPK name is not fixed to `api`.** The name comes from the signal's `nip05` tag.
* **A private attestation's public tag names the recipient, not the subject.** The spec only says the subject tag "can be restricted or blinded". The SDK tags the recipient so the recipient can find it with an ordinary relay filter. The `d` tag is a hash that only the two parties can rebuild, so the relay learns nothing about the subject.
* **Reaching several recipients means publishing once for each.** NIP-44 works between two parties. The spec has no group encryption.
* **No trust score, ever.** SeD-06 mentions a "proportional risk discount" at distance 2 without defining it, and elsewhere says SeD rejects numeric scoring. So `evaluateTrust` returns the evidence and leaves the decision to your app.
* **Default freshness is about six months and default depth is two hops.** The spec leaves both to the client. Both are options.

## Project layout and scripts

This part is for working on the SDK itself. Clone the repo, run `npm install`, and the scripts below work.

```
git clone https://github.com/OpenBitcoinAfrica/sed-sdk.git
cd sed-sdk
npm install
```

```
src/sed/common.ts               shared types, event kinds, tiers and tag helpers
src/sed/signal.ts               SeD-02 capability signal
src/sed/attestation.ts          SeD-03 attestation
src/sed/private-attestation.ts  SeD-03 section 3.6, encrypted attestation
src/sed/revocation.ts           SeD-05 revocation and deletion request
src/sed/verify.ts               SeD-06 phase 1, signature and id check
src/sed/identity.ts             SeD-01 operational key authorization
src/sed/trust.ts                SeD-06 phase 1, every check in one call
src/sed/reputation.ts           SeD-06 phases 2 and 3, trust evaluation
src/sed/relay.ts                SeD-04 relay transport
src/sed/index.ts                exports everything above
test/                           one test file per source file
examples/walkthrough.ts         offline, narrated run through every piece
examples/relay-live.ts          publishes to real public relays with throwaway keys
```

```
npm test            # run the tests
npm run typecheck   # check types without running anything
npm run build       # compile to dist/
npx tsx examples/walkthrough.ts   # no network needed
npx tsx examples/relay-live.ts    # needs internet; writes to real relays
```

CI runs the typecheck, the tests and the build on Node 22 and 24.

## What is done and what is pending

### Done

* Published to npm as `@openbitcoin-africa/sed-sdk`, version 0.1.0
* Capability signals: parse, build, expiry check (SeD-02)
* Public and private attestations: parse, build, latest-wins, NIP-44 encryption (SeD-03)
* Revocation notices and the NIP-09 deletion request (SeD-05)
* Signature and id verification that cannot be fooled by a cached flag (SeD-06 phase 1)
* Domain based authorization of operational keys, with identity pinning through `expectedIpk` (SeD-01)
* The whole phase 1 check in one call (SeD-06 phase 1)
* Relay publishing and querying, behind a small interface you can swap (SeD-04)
* Trust evaluation: graph distance, disputes, conflicts, isolated clusters (SeD-06 phases 2 and 3)

### Pending

* **Bridge to the Pontmore agent discovery protocol.** Not part of SeD itself, and not started.
* **Relay admission rules (SeD-04 section 4.2).** Some relays will require NIP-13 proof of work or a Lightning payment. `publishEvent` sends the event as it is, so those relays will reject it. The SDK does not yet mine a nonce or attach an invoice.
* **Fetching at scale.** The examples fetch attestations with a plain filter and a limit. That is fine for small networks. A real client will need smarter queries and its own storage.
* **Caching of `nostr.json`.** None, on purpose for now. The spec does not say how long a result may be reused.

### Open questions for the spec

* Which values may `capacity_tier` take?
* Which tags in an attestation and in a revocation are required?
* What makes an operational key "expired" apart from the signal's own `expiration` tag? How long may a `nostr.json` result be cached?
* What is the "proportional risk discount" at distance 2 supposed to be, given that SeD rejects numeric scoring?


npm install, npm run typecheck, npm test.