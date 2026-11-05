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
}

export async function publishEvent(pool: RelayPool, relays: string[], event: NostrEvent): Promise<PublishOutcome[]> {
  const settled = await Promise.allSettled(pool.publish(relays, event));
  return relays.map((relay, i) => {
    const outcome = settled[i]!;
    return outcome.status === "fulfilled"
      ? { relay, ok: true, reason: outcome.value }
      : { relay, ok: false, reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) };
  });
}

export async function fetchEvents(pool: RelayPool, relays: string[], filter: Filter): Promise<NostrEvent[]> {
  const events = await pool.querySync(relays, filter);
  return [...events].sort((a, b) => b.created_at - a.created_at);
}