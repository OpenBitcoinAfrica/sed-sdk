import {
  type EventTemplate,
  type NostrEvent,
  type Result,
  HEX64,
  SED_KINDS,
  exactlyOne,
  fail,
  nowSeconds,
  ok,
  tagsNamed,
} from "./common.js";

export interface Revocation {
  signer: string;
  revokedOpk: string;
  revokedAt: number | null;
  reason: string | null;
  eventId: string;
}

export const revocationDTag = (opk: string): string => `revocation:${opk}`;

export function parseRevocation(event: NostrEvent): Result<Revocation> {
  const errors: string[] = [];
  if (event.kind !== SED_KINDS.REVOCATION) {
    return fail(`expected kind ${SED_KINDS.REVOCATION}, got ${event.kind}`);
  }

  const protocol = exactlyOne(event, "protocol", errors);
  if (protocol && protocol[1] !== "sed") errors.push('"protocol" tag must be "sed"');

  let revokedOpk = "";
  const p = tagsNamed(event, "p").filter((t) => t[2] === "revoked_opk");
  if (p.length !== 1) {
    errors.push(`revocation needs exactly one ["p", <opk>, "revoked_opk"] tag (found ${p.length})`);
  } else if (!HEX64.test(p[0]![1] ?? "")) {
    errors.push("revoked OPK must be 64 lowercase hex characters");
  } else {
    revokedOpk = p[0]![1]!;
  }

  const d = exactlyOne(event, "d", errors);
  if (d && revokedOpk && d[1] !== revocationDTag(revokedOpk)) {
    errors.push(`"d" tag must be "${revocationDTag(revokedOpk)}"`);
  }

  let revokedAt: number | null = null;
  const at = tagsNamed(event, "revoked_at");
  if (at.length > 1) errors.push('"revoked_at" tag must appear at most once');
  else if (at.length === 1) {
    const raw = at[0]![1] ?? "";
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) errors.push('"revoked_at" must be a unix timestamp in seconds');
    else revokedAt = Number(raw);
  }

  const reasons = tagsNamed(event, "reason");
  if (reasons.length > 1) errors.push('"reason" tag must appear at most once');
  const reason = reasons[0]?.[1] ?? null;

  if (errors.length) return fail(...errors);
  return ok({ signer: event.pubkey, revokedOpk, revokedAt, reason, eventId: event.id });
}

export function isOpkRevoked(opk: string, serviceIpk: string, revocations: Revocation[]): boolean {
  return revocations.some((r) => r.revokedOpk === opk && r.signer === serviceIpk);
}

export interface BuildRevocationInput {
  revokedOpk: string;
  reason?: string;
  note?: string;
  revokedAt?: number;
  createdAt?: number;
}

export function buildRevocation(input: BuildRevocationInput): EventTemplate {
  const createdAt = input.createdAt ?? nowSeconds();
  const tags: string[][] = [
    ["protocol", "sed"],
    ["d", revocationDTag(input.revokedOpk)],
    ["p", input.revokedOpk, "revoked_opk"],
    ["revoked_at", String(input.revokedAt ?? createdAt)],
  ];
  if (input.reason) tags.push(["reason", input.reason]);
  const template: EventTemplate = {
    kind: SED_KINDS.REVOCATION,
    created_at: createdAt,
    tags,
    content: input.note ?? "",
  };
  const check = parseRevocation({ ...template, id: "", pubkey: "", sig: "" });
  if (!check.ok) throw new Error(`invalid revocation: ${check.errors.join("; ")}`);
  return template;
}

export function buildSignalDeletion(opk: string, note = "", createdAt: number = nowSeconds()): EventTemplate {
  if (!HEX64.test(opk)) throw new Error("opk must be 64 lowercase hex characters");
  return {
    kind: SED_KINDS.DELETION,
    created_at: createdAt,
    tags: [
      ["a", `${SED_KINDS.CAPABILITY_SIGNAL}:${opk}:capability-signal`],
      ["k", String(SED_KINDS.CAPABILITY_SIGNAL)],
    ],
    content: note,
  };
}