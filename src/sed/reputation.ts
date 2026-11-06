import { type InteractionType, type Tier, TIERS, nowSeconds } from "./common.js";
import { type Attestation, latestAttestations } from "./attestation.js";

const DEFAULT_FRESHNESS_WINDOW_SECONDS = 180 * 24 * 60 * 60; // ~6 months, see evaluateTrust's doc comment
const DEFAULT_MAX_DISTANCE = 2;

export type TrustReliability = "direct" | "indirect" | "deep" | "unverified";

export interface EvaluateTrustQuery {
  /** Which kind of interaction this lookup is about; only attestations of this same type count as evidence. */
  type: InteractionType;
  /** If given, an attestation that names specific verified rails must include this one to count. An attestation that names no rails at all is never excluded by this, it just hasn't made a claim either way. */
  rail?: string;
  /** If given, an attestation's own highest_volume_tier, when it states one, must be at least this tier. An attestation with no stated tier is never excluded by this. */
  minTier?: Tier;
}

export interface EvaluateTrustOptions {
  now?: number;
  /** How old an attestation's own freshness signal (lastActive, or createdAt if it has none) may be before it's ignored entirely. Defaults to roughly 6 months; SeD-06 leaves this entirely up to the client. */
  freshnessWindowSeconds?: number;
  /** How many hops from an anchor this will even look. SeD-06 treats anything past 2 as barely useful unless the client explicitly asks for it, so this defaults to 2. */
  maxDistance?: number;
}

export interface TrustEvidence {
  candidateIpk: string;
  /** Graph distance from the nearest anchor, in attestation hops. null means no path was found within maxDistance hops. */
  distance: number | null;
  reliability: TrustReliability;
  /** Every relevant, fresh attestation that targets the candidate directly, whoever made it and however far they are from an anchor. */
  supportingAttestations: Attestation[];
  /** Attestations among those above where the attester is one of the caller's own anchors and it disputes the candidate. */
  disputesFromAnchors: Attestation[];
  /** True exactly when disputesFromAnchors is non-empty. SeD-06 phase 3: a direct anchor's dispute SHOULD override positive indirect evidence until it's resolved, which in practice means the attester either retracts it or a newer, non-disputing attestation for the same tuple replaces it. This flag only reports the fact, applying the override is the caller's call. */
  overriddenByAnchorDispute: boolean;
  /** True when two or more of the supporting attestations, made by attesters sitting at the same distance from an anchor, disagree (one disputes and another doesn't, or they report different sla_compliance). SeD-06 phase 3 says to surface this rather than collapse it, so this is a flag, not a resolution. */
  conflicting: boolean;
  /** True when distance is null but positive-looking attestations exist anyway, a cluster of attestations with no path back to the caller's own anchors. SeD-06: this MUST NOT make the candidate trusted by itself. */
  isolatedCluster: boolean;
}

function isRelevant(a: Attestation, query: EvaluateTrustQuery, now: number, freshnessWindowSeconds: number): boolean {
  if (a.type !== query.type) return false;
  if (query.rail && a.verifiedRails.length > 0 && !a.verifiedRails.includes(query.rail)) return false;
  if (query.minTier && a.highestVolumeTier && TIERS.indexOf(a.highestVolumeTier) < TIERS.indexOf(query.minTier)) return false;
  const freshnessAnchor = a.lastActive ?? a.createdAt;
  return now - freshnessAnchor <= freshnessWindowSeconds;
}

export function evaluateTrust(
  candidateIpk: string,
  attestations: Attestation[],
  anchors: string[],
  query: EvaluateTrustQuery,
  options: EvaluateTrustOptions = {},
): TrustEvidence {
  const now = options.now ?? nowSeconds();
  const freshnessWindowSeconds = options.freshnessWindowSeconds ?? DEFAULT_FRESHNESS_WINDOW_SECONDS;
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const anchorSet = new Set(anchors);

  const deduped = latestAttestations(attestations);
  const relevantAttestations = deduped.filter((a) => isRelevant(a, query, now, freshnessWindowSeconds));

  const distances = new Map<string, number>();
  for (const a of anchors) distances.set(a, 0);
  let frontier = new Set<string>(anchors);
  for (let hop = 1; hop <= maxDistance && frontier.size > 0; hop++) {
    const next = new Set<string>();
    for (const a of relevantAttestations) {
      if (frontier.has(a.attester) && !distances.has(a.subject)) {
        distances.set(a.subject, hop);
        next.add(a.subject);
      }
    }
    frontier = next;
  }

  const distance = distances.get(candidateIpk) ?? null;
  const reliability: TrustReliability = distance === null ? "unverified" : distance <= 1 ? "direct" : distance === 2 ? "indirect" : "deep";

  const supportingAttestations = relevantAttestations.filter((a) => a.subject === candidateIpk);
  const disputesFromAnchors = supportingAttestations.filter((a) => anchorSet.has(a.attester) && a.disputeMaliciousActor);

  let conflicting = false;
  const byAttesterDistance = new Map<number, Attestation[]>();
  for (const a of supportingAttestations) {
    const attesterDistance = anchorSet.has(a.attester) ? 0 : distances.get(a.attester);
    if (attesterDistance === undefined) continue; // this attester has no path back to any anchor at all
    const group = byAttesterDistance.get(attesterDistance) ?? [];
    group.push(a);
    byAttesterDistance.set(attesterDistance, group);
  }
  for (const group of byAttesterDistance.values()) {
    if (group.length < 2) continue;
    const disputed = group.some((a) => a.disputeMaliciousActor);
    const clean = group.some((a) => !a.disputeMaliciousActor);
    const met = group.some((a) => a.slaCompliance === "target_met");
    const missed = group.some((a) => a.slaCompliance === "target_missed");
    if ((disputed && clean) || (met && missed)) conflicting = true;
  }

  return {
    candidateIpk,
    distance,
    reliability,
    supportingAttestations,
    disputesFromAnchors,
    overriddenByAnchorDispute: disputesFromAnchors.length > 0,
    conflicting,
    isolatedCluster: distance === null && supportingAttestations.length > 0,
  };
}