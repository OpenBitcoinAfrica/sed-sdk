import { type NostrEvent, SED_KINDS } from "./common.js";
import { type Attestation, latestAttestations, parseAttestation } from "./attestation.js";
import { type Revocation, parseRevocation, revocationDTag } from "./revocation.js";
import { type Filter, type RelayPool, fetchEvents } from "./relay.js";

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_EVENTS = 5000;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_DISTANCE = 2;
const AUTHORS_PER_QUERY = 100;

export interface FetchAllOptions {
  maxEvents?: number;
  maxPages?: number;
}

export interface FetchAllResult {
  events: NostrEvent[];
  truncated: boolean;
}

export async function fetchAllEvents(
  pool: RelayPool,
  relays: string[],
  filter: Filter,
  options: FetchAllOptions = {},
): Promise<FetchAllResult> {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const limit = filter.limit ?? DEFAULT_PAGE_SIZE;
  const since = filter.since ?? 0;

  const seen = new Map<string, NostrEvent>();
  let until = filter.until;
  let truncated = false;

  for (let pages = 1; ; pages++) {
    const page = await fetchEvents(pool, relays, { ...filter, until, limit });
    if (page.length === 0) break;

    let added = 0;
    for (const event of page) {
      if (!seen.has(event.id)) {
        seen.set(event.id, event);
        added++;
      }
    }

    if (seen.size >= maxEvents || pages >= maxPages) {
      truncated = true;
      break;
    }

    const oldest = page[page.length - 1]!.created_at;
    until = added === 0 ? oldest - 1 : oldest;
    if (until < since) break;
  }

  const events = [...seen.values()].sort((a, b) => b.created_at - a.created_at).slice(0, maxEvents);
  return { events, truncated };
}

export interface FetchAttestationsResult {
  attestations: Attestation[];
  truncated: boolean;
  skipped: number;
}

function parseAttestations(events: NostrEvent[]): { attestations: Attestation[]; skipped: number } {
  const parsed: Attestation[] = [];
  let skipped = 0;
  for (const event of events) {
    const r = parseAttestation(event);
    if (r.ok) parsed.push(r.value);
    else skipped++;
  }
  return { attestations: latestAttestations(parsed), skipped };
}

export async function fetchAttestationsAbout(
  pool: RelayPool,
  relays: string[],
  subjectIpk: string,
  options: FetchAllOptions = {},
): Promise<FetchAttestationsResult> {
  const { events, truncated } = await fetchAllEvents(
    pool,
    relays,
    { kinds: [SED_KINDS.ATTESTATION], "#p": [subjectIpk] },
    options,
  );
  return { ...parseAttestations(events), truncated };
}

export interface FetchRevocationsResult {
  revocations: Revocation[];
  truncated: boolean;
  skipped: number;
}

export async function fetchRevocationsFor(
  pool: RelayPool,
  relays: string[],
  opk: string,
  options: FetchAllOptions = {},
): Promise<FetchRevocationsResult> {
  const { events, truncated } = await fetchAllEvents(
    pool,
    relays,
    { kinds: [SED_KINDS.REVOCATION], "#d": [revocationDTag(opk)] },
    options,
  );
  const revocations: Revocation[] = [];
  let skipped = 0;
  for (const event of events) {
    const r = parseRevocation(event);
    if (r.ok) revocations.push(r.value);
    else skipped++;
  }
  return { revocations, truncated, skipped };
}

export interface CollectTrustGraphOptions extends FetchAllOptions {
  maxDistance?: number;
  candidateIpk?: string;
}

export interface TrustGraph {
  attestations: Attestation[];
  truncated: boolean;
  skipped: number;
}

export async function collectTrustGraph(
  pool: RelayPool,
  relays: string[],
  anchors: string[],
  options: CollectTrustGraphOptions = {},
): Promise<TrustGraph> {
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const all: Attestation[] = [];
  const visited = new Set<string>(anchors);
  let frontier = [...new Set(anchors)];
  let truncated = false;
  let skipped = 0;

  for (let hop = 1; hop <= maxDistance && frontier.length > 0; hop++) {
    const found: Attestation[] = [];
    for (let i = 0; i < frontier.length; i += AUTHORS_PER_QUERY) {
      const authors = frontier.slice(i, i + AUTHORS_PER_QUERY);
      const r = await fetchAllEvents(pool, relays, { kinds: [SED_KINDS.ATTESTATION], authors }, options);
      truncated ||= r.truncated;
      const parsed = parseAttestations(r.events);
      skipped += parsed.skipped;
      found.push(...parsed.attestations);
    }
    all.push(...found);

    const next: string[] = [];
    for (const a of found) {
      if (!visited.has(a.subject)) {
        visited.add(a.subject);
        next.push(a.subject);
      }
    }
    frontier = next;
  }

  if (options.candidateIpk !== undefined) {
    const about = await fetchAttestationsAbout(pool, relays, options.candidateIpk, options);
    truncated ||= about.truncated;
    skipped += about.skipped;
    all.push(...about.attestations);
  }

  return { attestations: latestAttestations(all), truncated, skipped };
}