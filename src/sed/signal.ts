import {
  type EventTemplate,
  type NostrEvent,
  type Result,
  SED_KINDS,
  exactlyOne,
  fail,
  nowSeconds,
  MAX_SIGNAL_TTL_SECONDS,
  ok,
  tagsNamed,
} from "./common.js";

const NIP05_LOCAL_RE = /^[a-z0-9._-]+$/;
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const REGION_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z0-9]{3,5}$/;
const UNIX_RE = /^[0-9]+$/;

export interface CapabilitySignal {
  opk: string;
  eventId: string;
  createdAt: number;
  nip05: string;
  name: string;
  domain: string;
  regions: string[];
  currencies: string[];
  rails: string[];
  capacityTier: string;
  expiration: number;
  endpoint: { url: string; port: number };
}

export function parseCapabilitySignal(event: NostrEvent): Result<CapabilitySignal> {
  const errors: string[] = [];

  if (event.kind !== SED_KINDS.CAPABILITY_SIGNAL) {
    return fail(`expected kind ${SED_KINDS.CAPABILITY_SIGNAL}, got ${event.kind}`);
  }

  const protocol = exactlyOne(event, "protocol", errors);
  if (protocol && protocol[1] !== "sed") errors.push('"protocol" tag must be "sed"');

  const d = exactlyOne(event, "d", errors);
  if (d && d[1] !== "capability-signal") errors.push('"d" tag must be "capability-signal"');

  let nip05 = "";
  let name = "";
  let domain = "";
  const n = exactlyOne(event, "nip05", errors);
  if (n) {
    const value = n[1] ?? "";
    const parts = value.split("@");
    if (parts.length !== 2 || !NIP05_LOCAL_RE.test(parts[0]!)) {
      errors.push('"nip05" must look like "name@domain", with the name using only a-z 0-9 - _ .');
    } else if (!HOSTNAME_RE.test(parts[1]!)) {
      errors.push('"nip05" domain must be a plain hostname such as "service.com"');
    } else {
      nip05 = value;
      name = parts[0]!;
      domain = parts[1]!.toLowerCase();
    }
  }

  const regions = tagsNamed(event, "region").map((t) => t[1] ?? "");
  if (regions.length === 0) errors.push('at least one "region" tag is required');
  for (const r of regions) if (!REGION_RE.test(r)) errors.push(`invalid region "${r}", expected two uppercase letters`);

  const currencies = tagsNamed(event, "currency").map((t) => t[1] ?? "");
  if (currencies.length === 0) errors.push('at least one "currency" tag is required');
  for (const c of currencies) if (!CURRENCY_RE.test(c)) errors.push(`invalid currency "${c}", expected 3 to 5 uppercase letters or digits`);

  const rails = tagsNamed(event, "rail").map((t) => t[1] ?? "");
  if (rails.length === 0) errors.push('at least one "rail" tag is required');
  for (const r of rails) if (r.trim() === "") errors.push('"rail" tag must not be empty');

  let capacityTier = "";
  const ct = exactlyOne(event, "capacity_tier", errors);
  if (ct) {
    if ((ct[1] ?? "").trim() === "") errors.push('"capacity_tier" must not be empty');
    else capacityTier = ct[1]!;
  }

  let expiration = 0;
  const ex = exactlyOne(event, "expiration", errors);
  if (ex) {
    const raw = ex[1] ?? "";
    if (!UNIX_RE.test(raw) || !Number.isSafeInteger(Number(raw))) errors.push('"expiration" must be a unix timestamp in seconds');
    else {
      expiration = Number(raw);
      if (expiration - event.created_at > MAX_SIGNAL_TTL_SECONDS) errors.push('"expiration" is more than 90 days after created_at');
    }
  }

  let endpoint = { url: "", port: 0 };
  const ep = exactlyOne(event, "endpoint", errors);
  if (ep) {
    const url = ep[1] ?? "";
    const portRaw = ep[2] ?? "";
    let urlOk = false;
    try {
      const u = new URL(url);
      urlOk = u.protocol === "https:" && u.username === "" && u.password === "";
    } catch {
      urlOk = false;
    }
    if (!urlOk) errors.push('"endpoint" url must be an absolute https:// URL without a username or password');
    const port = Number(portRaw);
    const portOk = /^[0-9]+$/.test(portRaw) && port >= 1 && port <= 65535;
    if (!portOk) errors.push('"endpoint" port must be a whole number from 1 to 65535');
    if (urlOk && portOk) endpoint = { url, port };
  }

  if (errors.length) return fail(...errors);
  return ok({
    opk: event.pubkey,
    eventId: event.id,
    createdAt: event.created_at,
    nip05,
    name,
    domain,
    regions,
    currencies,
    rails,
    capacityTier,
    expiration,
    endpoint,
  });
}

export function isSignalLive(signal: Pick<CapabilitySignal, "expiration">, nowSeconds: number): boolean {
  return nowSeconds <= signal.expiration;
}

export interface BuildCapabilitySignalInput {
  nip05: string;
  regions: string[];
  currencies: string[];
  rails: string[];
  capacityTier: string;
  expiration: number;
  endpoint: { url: string; port: number };
  content?: string;
  createdAt?: number;
}

export function buildCapabilitySignal(input: BuildCapabilitySignalInput): EventTemplate {
  const template: EventTemplate = {
    kind: SED_KINDS.CAPABILITY_SIGNAL,
    created_at: input.createdAt ?? nowSeconds(),
    tags: [
      ["protocol", "sed"],
      ["d", "capability-signal"],
      ["nip05", input.nip05],
      ...input.regions.map((r) => ["region", r]),
      ...input.currencies.map((c) => ["currency", c]),
      ...input.rails.map((r) => ["rail", r]),
      ["capacity_tier", input.capacityTier],
      ["expiration", String(input.expiration)],
      ["endpoint", input.endpoint.url, String(input.endpoint.port)],
    ],
    content: input.content ?? "",
  };
  const check = parseCapabilitySignal({ ...template, id: "", pubkey: "", sig: "" });
  if (!check.ok) throw new Error(`invalid capability signal: ${check.errors.join("; ")}`);
  return template;
}