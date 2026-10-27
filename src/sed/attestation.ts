import {
  type EventTemplate,
  type InteractionType,
  type NostrEvent,
  type Result,
  type Tier,
  HEX64,
  INTERACTION_TYPES,
  SED_KINDS,
  TIERS,
  exactlyOne,
  fail,
  nowSeconds,
  ok,
  tagsNamed,
} from "./common.js";

export type SlaCompliance = "target_met" | "target_missed";

export interface Attestation {
  attester: string;
  subject: string;
  type: InteractionType;
  eventId: string;
  createdAt: number;
  relationshipStart: number | null;
  lastActive: number | null;
  verifiedRails: string[];
  highestVolumeTier: Tier | null;
  slaCompliance: SlaCompliance | null;
  disputeMaliciousActor: boolean;
  isSelfAttestation: boolean;
}

export const attestationDTag = (subjectIpk: string, type: InteractionType): string =>
  `attestation:${subjectIpk}:${type}`;

const UNIX_RE = /^[0-9]+$/;

function optionalUnix(event: NostrEvent, name: string, errors: string[]): number | null {
  const found = tagsNamed(event, name);
  if (found.length === 0) return null;
  if (found.length > 1) {
    errors.push(`"${name}" tag must appear at most once`);
    return null;
  }
  const raw = found[0]![1] ?? "";
  if (!UNIX_RE.test(raw) || !Number.isSafeInteger(Number(raw))) {
    errors.push(`"${name}" must be a unix timestamp in seconds`);
    return null;
  }
  return Number(raw);
}

export function parseAttestation(event: NostrEvent): Result<Attestation> {
  const errors: string[] = [];
  if (event.kind !== SED_KINDS.ATTESTATION) {
    return fail(`expected kind ${SED_KINDS.ATTESTATION}, got ${event.kind}`);
  }

  const protocol = exactlyOne(event, "protocol", errors);
  if (protocol && protocol[1] !== "sed") errors.push('"protocol" tag must be "sed"');

  let type: InteractionType = "liquidity";
  let typeOk = false;
  const typeTag = exactlyOne(event, "type", errors);
  if (typeTag) {
    if (!(INTERACTION_TYPES as readonly string[]).includes(typeTag[1] ?? "")) {
      errors.push(`"type" must be one of ${INTERACTION_TYPES.join(", ")}`);
    } else {
      type = typeTag[1] as InteractionType;
      typeOk = true;
    }
  }

  let subject = "";
  const subjectTags = tagsNamed(event, "p").filter((t) => t[2] === "subject");
  if (subjectTags.length !== 1) {
    errors.push(`attestation needs exactly one ["p", <subject>, "subject"] tag (found ${subjectTags.length})`);
  } else if (!HEX64.test(subjectTags[0]![1] ?? "")) {
    errors.push("subject must be 64 lowercase hex characters");
  } else {
    subject = subjectTags[0]![1]!;
  }

  const d = exactlyOne(event, "d", errors);
  if (d && subject && typeOk && d[1] !== attestationDTag(subject, type)) {
    errors.push(`"d" tag must be "${attestationDTag(subject, type)}"`);
  }

  const relationshipStart = optionalUnix(event, "relationship_start", errors);
  const lastActive = optionalUnix(event, "last_active", errors);

  let highestVolumeTier: Tier | null = null;
  const tierTags = tagsNamed(event, "highest_volume_tier");
  if (tierTags.length > 1) errors.push('"highest_volume_tier" tag must appear at most once');
  else if (tierTags.length === 1) {
    if (!(TIERS as readonly string[]).includes(tierTags[0]![1] ?? "")) {
      errors.push(`"highest_volume_tier" must be one of ${TIERS.join(", ")}`);
    } else highestVolumeTier = tierTags[0]![1] as Tier;
  }

  let slaCompliance: SlaCompliance | null = null;
  const slaTags = tagsNamed(event, "sla_compliance");
  if (slaTags.length > 1) errors.push('"sla_compliance" tag must appear at most once');
  else if (slaTags.length === 1) {
    const v = slaTags[0]![1];
    if (v !== "target_met" && v !== "target_missed") errors.push('"sla_compliance" must be target_met or target_missed');
    else slaCompliance = v;
  }

  const disputes = tagsNamed(event, "dispute");
  for (const t of disputes) {
    if (t[1] !== "malicious_actor") errors.push(`unknown dispute value "${t[1] ?? ""}"`);
  }

  const verifiedRails = tagsNamed(event, "verified_rail").map((t) => t[1] ?? "");
  for (const r of verifiedRails) if (r.trim() === "") errors.push('"verified_rail" tag must not be empty');

  if (errors.length) return fail(...errors);
  return ok({
    attester: event.pubkey,
    subject,
    type,
    eventId: event.id,
    createdAt: event.created_at,
    relationshipStart,
    lastActive,
    verifiedRails,
    highestVolumeTier,
    slaCompliance,
    disputeMaliciousActor: disputes.length > 0,
    isSelfAttestation: event.pubkey === subject,
  });
}

export function latestAttestations(attestations: Attestation[]): Attestation[] {
  const best = new Map<string, Attestation>();
  for (const a of attestations) {
    const key = `${a.attester}|${a.subject}|${a.type}`;
    const current = best.get(key);
    const newer = !current || a.createdAt > current.createdAt || (a.createdAt === current.createdAt && a.eventId < current.eventId);
    if (newer) best.set(key, a);
  }
  return [...best.values()];
}

export interface BuildAttestationInput {
  subject: string;
  type: InteractionType;
  relationshipStart?: number;
  lastActive?: number;
  verifiedRails?: string[];
  highestVolumeTier?: Tier;
  slaCompliance?: SlaCompliance;
  disputeMaliciousActor?: boolean;
  createdAt?: number;
}

export function buildAttestation(input: BuildAttestationInput): EventTemplate {
  const tags: string[][] = [
    ["protocol", "sed"],
    ["d", attestationDTag(input.subject, input.type)],
    ["p", input.subject, "subject"],
    ["type", input.type],
  ];
  if (input.relationshipStart !== undefined) tags.push(["relationship_start", String(input.relationshipStart)]);
  if (input.lastActive !== undefined) tags.push(["last_active", String(input.lastActive)]);
  for (const r of input.verifiedRails ?? []) tags.push(["verified_rail", r]);
  if (input.highestVolumeTier) tags.push(["highest_volume_tier", input.highestVolumeTier]);
  if (input.slaCompliance) tags.push(["sla_compliance", input.slaCompliance]);
  if (input.disputeMaliciousActor) tags.push(["dispute", "malicious_actor"]);

  const template: EventTemplate = {
    kind: SED_KINDS.ATTESTATION,
    created_at: input.createdAt ?? nowSeconds(),
    tags,
    content: "",
  };
  const check = parseAttestation({ ...template, id: "", pubkey: "", sig: "" });
  if (!check.ok) throw new Error(`invalid attestation: ${check.errors.join("; ")}`);
  return template;
}