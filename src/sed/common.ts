export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(...errors: string[]): Result<T> => ({ ok: false, errors });

export const SED_KINDS = {
  CAPABILITY_SIGNAL: 30078,
  ATTESTATION: 30079,
  REVOCATION: 30080,
  DELETION: 5,
} as const;

export const MAX_SIGNAL_TTL_SECONDS = 7 * 24 * 60 * 60;

export const TIERS = ["tier_1", "tier_2", "tier_3", "tier_4"] as const;
export type Tier = (typeof TIERS)[number];

export const INTERACTION_TYPES = ["liquidity", "settlement", "integration", "custody"] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

export const HEX64 = /^[0-9a-f]{64}$/;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const tagsNamed = (e: Pick<NostrEvent, "tags">, name: string): string[][] =>
  e.tags.filter((t) => t[0] === name);

export function exactlyOne(
  e: Pick<NostrEvent, "tags">,
  name: string,
  errors: string[],
): string[] | null {
  const found = tagsNamed(e, name);
  if (found.length !== 1) {
    errors.push(`"${name}" tag must appear exactly once (found ${found.length})`);
    return null;
  }
  return found[0]!;
}