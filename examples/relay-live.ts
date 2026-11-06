/**
 * Unlike examples/walkthrough.ts, this one talks to real relays on the
 * open Nostr network: it signs a capability signal with a fresh, throwaway
 * test key, publishes it to a couple of well-known public relays, reads it
 * back, then does the same for a private (encrypted) attestation.
 *
 * Run it with:
 *
 *   npx tsx examples/relay-live.ts
 *
 * It needs a real internet connection and working outbound websockets.
 * Every key here is generated new every run and isn't tied to anything
 * real, so there's nothing sensitive in what gets published, it's a test
 * capability signal advertising a fake domain and a test attestation about
 * a made-up subject. Still, these are real, public writes to real relays,
 * so this isn't something to run in a tight loop.
 *
 * This uses the `ws` package instead of Node's own built-in `WebSocket`.
 * Node's built-in one is backed by undici, and undici's WebSocket client
 * has a well-documented history of crashing the whole process, not just
 * failing the one connection, when a connection errors out (a relay
 * refusing the connection, being unreachable, or sending something it
 * doesn't like). `ws` fails the same situations normally instead. See
 * src/sed/relay.ts for the longer explanation.
 */
import WebSocket from "ws";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  buildCapabilitySignal,
  buildPrivateAttestation,
  createRelayPool,
  decryptPrivateAttestation,
  fetchEvents,
  isEventSignatureValid,
  parsePrivateAttestationEnvelope,
  publishEvent,
} from "../src/sed/index.js";

const RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

async function main() {
  const opkSecret = generateSecretKey();
  const opk = getPublicKey(opkSecret);

  const now = Math.floor(Date.now() / 1000);
  const unsigned = buildCapabilitySignal({
    nip05: "api@example.com",
    regions: ["NG"],
    currencies: ["NGN"],
    rails: ["bank_transfer"],
    capacityTier: "tier_1",
    expiration: now + 60 * 60, // 1 hour, this is just a live test, not a real offer
    endpoint: { url: "https://api.example.com", port: 443 },
  });
  const signal = finalizeEvent(unsigned, opkSecret);

  console.log("Signed a test capability signal.");
  console.log("  id:", signal.id);
  console.log("  pubkey (this run's throwaway OPK):", signal.pubkey);

  const pool = createRelayPool({ websocketImplementation: WebSocket as unknown as typeof globalThis.WebSocket });

  try {
    console.log("\nPublishing to:", RELAYS.join(", "));
    const outcomes = await publishEvent(pool, RELAYS, signal);
    for (const outcome of outcomes) {
      console.log(" ", outcome.relay, outcome.ok ? "accepted" : `rejected: ${outcome.reason}`);
    }

    if (!outcomes.some((o) => o.ok)) {
      console.log("\nNo relay accepted it, nothing to read back.");
    } else {
      console.log("\nReading it back, filtered to this run's own pubkey so we don't pull in anyone else's signals...");
      const found = await fetchEvents(pool, RELAYS, {
        kinds: [signal.kind],
        authors: [signal.pubkey],
        since: signal.created_at - 5,
      });

      console.log(`Found ${found.length} event(s) from this run.`);
      const roundTripped = found.find((e) => e.id === signal.id);
      console.log("The exact event we published is among them:", Boolean(roundTripped));
      if (roundTripped) {
        console.log("Its signature still checks out after the round trip:", isEventSignatureValid(roundTripped));
      }
    }

    // ---------------------------------------------------------------
    console.log("\n--- Private attestation (SeD-03 section 3.6) ---");
    // ---------------------------------------------------------------
    // Three separate parties here: Service B is attesting, about Service A
    // (the subject, an IPK that doesn't have to be the one that signed the
    // capability signal above, attestations target IPKs, not OPKs), and
    // only wants Service C, a specific consortium partner, to be able to
    // read it.

    const serviceBSecret = generateSecretKey();
    const serviceB = getPublicKey(serviceBSecret);
    const serviceAIpk = getPublicKey(generateSecretKey());
    const serviceCSecret = generateSecretKey();
    const serviceC = getPublicKey(serviceCSecret);

    const unsignedAttestation = buildPrivateAttestation({
      subject: serviceAIpk,
      type: "liquidity",
      highestVolumeTier: "tier_2",
      slaCompliance: "target_met",
      attesterSecretKey: serviceBSecret,
      recipientPubkey: serviceC,
    });
    const attestation = finalizeEvent(unsignedAttestation, serviceBSecret);

    console.log("Publishing a private attestation from Service B, about Service A, for Service C only...");
    const attestationOutcomes = await publishEvent(pool, RELAYS, attestation);
    for (const outcome of attestationOutcomes) {
      console.log(" ", outcome.relay, outcome.ok ? "accepted" : `rejected: ${outcome.reason}`);
    }

    if (!attestationOutcomes.some((o) => o.ok)) {
      console.log("\nNo relay accepted it, nothing to read back.");
      return;
    }

    const foundAttestations = await fetchEvents(pool, RELAYS, {
      kinds: [attestation.kind],
      authors: [attestation.pubkey],
      since: attestation.created_at - 5,
    });
    const roundTrippedAttestation = foundAttestations.find((e) => e.id === attestation.id);
    console.log("\nFound it on the relay:", Boolean(roundTrippedAttestation));
    if (!roundTrippedAttestation) return;

    const envelope = parsePrivateAttestationEnvelope(roundTrippedAttestation);
    console.log("Anyone reading the relay can see it's addressed to:", envelope.ok ? envelope.value.recipient === serviceC : envelope.errors);
    console.log("But nobody reading the relay can see the real subject:", !JSON.stringify(roundTrippedAttestation.tags).includes(serviceAIpk));

    const asRecipient = decryptPrivateAttestation(roundTrippedAttestation, serviceCSecret, serviceB);
    console.log("Service C can decrypt it:", asRecipient.ok);
    if (asRecipient.ok) {
      console.log("  real subject (Service A's IPK) matches:", asRecipient.value.subject === serviceAIpk);
      console.log("  tier:", asRecipient.value.highestVolumeTier, " sla:", asRecipient.value.slaCompliance);
    }

    const outsiderSecret = generateSecretKey();
    const asOutsider = decryptPrivateAttestation(roundTrippedAttestation, outsiderSecret, serviceB);
    console.log("An unrelated key cannot:", asOutsider.ok === false);
  } finally {
    // Closes the sockets this pool opened so the process can exit instead
    // of hanging on an open websocket connection.
    pool.close(RELAYS);
  }
}

main().catch((err) => {
  console.error("\nSomething went wrong:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});