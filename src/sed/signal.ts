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
  requireMany,
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

  // nip05: normalize to lowercase before validating, so the stored
  // identifier, name and domain always agree with each other.
  let nip05 = "";
  let name = "";
  let domain = "";
  const n = exactlyOne(event, "nip05", errors);
  if (n) {
    const value = (n[1] ?? "").trim().toLowerCase();
    const [local = "", host = "", ...rest] = value.split("@");
    const parts = value.split("@");
    if(rest.length > 0 || local === "" || host === "" || !NIP05_LOCAL_RE.test(local)) {
      errors.push('"nip05" must look like "name@domain", with the name using only a-z 0-9 - _ .');
    } else if (!HOSTNAME_RE.test(host)) {
      errors.push('"nip05" domain must be a plain hostname such as "service.com"');
    } else {
      nip05 = value;
      name = local;
      domain = host;
    }
  }

   const regions = requireMany(
    event,
    "region",
    (r) => REGION_RE.test(r),
    (r) => `invalid region "${r}", expected two uppercase letters`,
    errors,
  );
  const currencies = requireMany(
    event,
    "currency",
    (c) => CURRENCY_RE.test(c),
    (c) => `invalid currency "${c}", expected 3 to 5 uppercase letters or digits`,
    errors,
  );
  const rails = requireMany(
    event,
    "rail",
    (r) => !!r.trim(),
    (r) => `"rail" tag must not be empty`,
    errors,
  );


  let capacityTier = "";
  const ct = exactlyOne(event, "capacity_tier", errors);
  if (ct) {
    const value = (ct[1] ?? "").trim();
    if (value === "") errors.push('"capacity_tier" must not be empty');
    else capacityTier = value;
  }

  // expiration: must be after created_at and within the maximum TTL.
  let expiration = 0;
  const ex = exactlyOne(event, "expiration", errors);
  if (ex) {
    const raw = ex[1] ?? "";
    if (!UNIX_RE.test(raw) || !Number.isSafeInteger(Number(raw))) errors.push('"expiration" must be a unix timestamp in seconds');
    else {
       const value = Number(raw);
       const maxDays = Math.round(MAX_SIGNAL_TTL_SECONDS / 86400);
      if (value <= event.created_at) {
        errors.push('"expiration" must be after created_at');
      } else if (value - event.created_at > MAX_SIGNAL_TTL_SECONDS) {
        errors.push(`"expiration" is more than ${maxDays} days after created_at`);
      } else {
        expiration = value;
      }
     
    }
  }

  // endpoint: https URL without credentials, plus a port that must not
  // contradict a port written into the URL itself.
  let endpoint = { url: "", port: 0 };
  const ep = exactlyOne(event, "endpoint", errors);
  if (ep) {
    const rawUrl = ep[1] ?? "";
    const portRaw = ep[2] ?? "";

    let parsed: URL | null = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      parsed = null;
    }

      const urlOk =
      parsed !== null &&
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "";
    if (!urlOk) {
      errors.push('"endpoint" url must be an absolute https:// URL without a username or password');
    }

    const port = Number(portRaw);
    const portOk = /^[0-9]+$/.test(portRaw) && port >= 1 && port <= 65535;
    if (!portOk) errors.push('"endpoint" port must be a whole number from 1 to 65535');
     if (urlOk && portOk && parsed) {
      if (parsed.port !== "" && Number(parsed.port) !== port) {
        errors.push(`"endpoint" url port ${parsed.port} does not match port tag ${port}`);
      } else {
        endpoint = { url: rawUrl, port };
      }
    }
  
  }

  if (errors.length) return fail(...new Set(errors));
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