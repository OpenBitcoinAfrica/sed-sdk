import { AbstractSimplePool } from "nostr-tools/abstract-pool";
import type { Filter } from "nostr-tools/filter";
import { type NostrEvent } from "./common.js";
import { isEventSignatureValid } from "./verify.js";

export type { Filter };

export interface RelayPool {
  publish(relays: string[], event: NostrEvent): Promise<string>[];
  querySync(relays: string[], filter: Filter): Promise<NostrEvent[]>;
}

const DEFAULT_MAX_WAIT_FOR_CONNECTION_MS = 3000;

export function createRelayPool(options: { websocketImplementation?: typeof WebSocket; maxWaitForConnection?: number } = {}): AbstractSimplePool {
  return new AbstractSimplePool({
    verifyEvent: (event) => isEventSignatureValid(event as NostrEvent),
    websocketImplementation: options.websocketImplementation ?? WebSocket,
    maxWaitForConnection: options.maxWaitForConnection ?? DEFAULT_MAX_WAIT_FOR_CONNECTION_MS,
  });
}

export interface PublishOutcome {
  relay: string;
  ok: boolean;
  reason: string;
  requiredPowBits?: number;
}

export function parseRequiredPowBits(reason: string): number | undefined {
  const at = reason.search(/\bpow\b/i);
  if (at === -1) return undefined;
  const numbers = (reason.slice(at).match(/\d+/g) ?? []).map(Number).filter((n) => n >= 1 && n <= 256);
  return numbers.length === 0 ? undefined : Math.max(...numbers);
}

export async function publishEvent(pool: RelayPool, relays: string[], event: NostrEvent): Promise<PublishOutcome[]> {
  const settled = await Promise.allSettled(pool.publish(relays, event));
  return relays.map((relay, i) => {
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") return { relay, ok: true, reason: outcome.value };
    const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    const requiredPowBits = parseRequiredPowBits(reason);
    return requiredPowBits === undefined ? { relay, ok: false, reason } : { relay, ok: false, reason, requiredPowBits };
  });
}

export async function fetchEvents(pool: RelayPool, relays: string[], filter: Filter): Promise<NostrEvent[]> {
  const events = await pool.querySync(relays, filter);
  return [...events].sort((a, b) => b.created_at - a.created_at);
}