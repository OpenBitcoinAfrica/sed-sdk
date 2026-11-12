# Changelog

All notable changes to this package are written down here. While the version is
below 1.0, a minor release (0.1 to 0.2) can change the API, and a patch release
(0.1.0 to 0.1.1) only fixes things or updates the docs.

## 0.2.0

### Added

* **Proof of work (NIP-13).** `addProofOfWork` mines a nonce into an unsigned
  event for relays that ask for it. `getEventDifficulty` and `meetsDifficulty`
  check an event's real difficulty. `MAX_POW_DIFFICULTY` is 32.
* **Relay proof of work requirement in publish results.** When a relay refuses
  an event for lacking work and says how much it wants, `publishEvent` puts the
  number in `requiredPowBits`. `parseRequiredPowBits` is exported on its own.
* **Fetching at scale.** `fetchAllEvents` pages through everything a filter
  matches instead of stopping at the first page, removes duplicates, and says
  whether it was cut short. `fetchAttestationsAbout` and `fetchRevocationsFor`
  fetch only what one candidate or key needs. `collectTrustGraph` walks out from
  your anchors and collects just the attestations `evaluateTrust` can use.
* **Optional cache for `nostr.json`.** `createNostrJsonCache` and the `cache`
  option on the identity checks. It is off unless you pass one. A key the
  domain removes keeps passing until its cached entry expires, so keep the
  lifetime short.
* A publish workflow that releases to npm with provenance, and a changelog.
* The walkthrough example now covers proof of work, the trust graph and the
  cache.

## 0.1.0

First release. Capability signals, public and private attestations,
revocation, signature checks, domain based authorization of operational keys
with `expectedIpk` pinning, relay publishing and querying, and trust
evaluation.