// SPDX-License-Identifier: MPL-2.0

/**
 * Health of a Firebase Hosting custom domain — pure, no I/O.
 *
 * Firebase Hosting (REST v1beta1, `projects/<p>/sites/<s>/customDomains/<host>`)
 * reports three independent states per custom domain: `hostState` (does
 * Firebase serve the site on this hostname?), `ownershipState` (has it
 * verified the TXT / A records?) and `cert.state`. It also reports which
 * DNS records it wants (`requiredDnsUpdates.desired`), which it saw
 * (`…discovered`), and when it last looked (`…checkTime`).
 *
 * Observed on a gcp-firebase install: the custom domain was created while
 * DNS still pointed at the old host. After DNS was switched, the cert went
 * CERT_ACTIVE (HTTP challenge) but the domain stayed HOST_MISMATCH /
 * OWNERSHIP_PENDING for hours with desired == discovered, `checkTime`
 * frozen and `updateTime` still at creation — Firebase had stopped
 * re-checking. Visitors got Firebase's "Site Not Found". Deleting and
 * re-creating the custom domain made it active within seconds.
 *
 * `assessCustomDomain` turns that into a status the agent and the
 * operator can act on:
 *
 *   active        HOST_ACTIVE + OWNERSHIP_ACTIVE — serving.
 *   dns_pending   a record still has to be added / removed at the DNS
 *                 provider (requiredAction ADD/REMOVE, or a desired
 *                 record Firebase has not discovered yet).
 *   provisioning  DNS is right and Firebase is still verifying — wait.
 *   stuck         DNS is right but Firebase has not re-checked for
 *                 `staleCheckMs` OR the domain has not changed for
 *                 `noProgressMs` — reconnect (delete + re-create).
 *   deleted       soft-deleted (30-day expiry). Deliberate, or a
 *                 reconnect interrupted between DELETE and re-create —
 *                 reconnecting restores it; never recommended on its own.
 *
 * Reconnecting a domain that is not active takes nothing offline (Firebase
 * is not serving the site on it yet), so the thresholds lean towards
 * recommending it early rather than leaving a site dark for hours.
 */

/** Firebase stopped re-checking DNS when its last check is older than this. */
export const STALE_CHECK_MS = 30 * 60_000;
/** The domain counts as not progressing when unchanged for longer than this. */
export const NO_PROGRESS_MS = 60 * 60_000;

export interface FirebaseDnsRecord {
  readonly domainName?: string;
  readonly type?: string;
  readonly rdata?: string;
  /** NONE | ADD | REMOVE */
  readonly requiredAction?: string;
}

export interface FirebaseDnsRecordSet {
  readonly domainName?: string;
  readonly records?: readonly FirebaseDnsRecord[];
}

/** The slice of a `CustomDomain` resource this module reads. */
export interface FirebaseCustomDomain {
  /** `projects/<p>/sites/<s>/customDomains/<hostname>` */
  readonly name: string;
  readonly hostState?: string;
  readonly ownershipState?: string;
  readonly cert?: { readonly state?: string; readonly type?: string };
  readonly requiredDnsUpdates?: {
    readonly checkTime?: string;
    readonly desired?: readonly FirebaseDnsRecordSet[];
    readonly discovered?: readonly FirebaseDnsRecordSet[];
  };
  readonly createTime?: string;
  readonly updateTime?: string;
  /** Set on a soft-deleted domain (listed with `showDeleted=true`). */
  readonly deleteTime?: string;
  readonly expireTime?: string;
}

export type CustomDomainStatus = "active" | "dns_pending" | "provisioning" | "stuck" | "deleted";

export interface DnsChange {
  readonly action: "ADD" | "REMOVE";
  readonly type: string;
  readonly domainName: string;
  readonly rdata: string;
}

export interface CustomDomainHealth {
  readonly hostname: string;
  readonly status: CustomDomainStatus;
  readonly hostState: string;
  readonly ownershipState: string;
  readonly certState: string;
  /** DNS changes Firebase still waits for (empty unless `dns_pending`). */
  readonly dnsChanges: DnsChange[];
  readonly checkTime: string | null;
  readonly updateTime: string | null;
  /** One operator-readable sentence: what is going on and what to do. */
  readonly summary: string;
}

export interface HealthThresholds {
  readonly staleCheckMs: number;
  readonly noProgressMs: number;
}

const DEFAULT_THRESHOLDS: HealthThresholds = {
  staleCheckMs: STALE_CHECK_MS,
  noProgressMs: NO_PROGRESS_MS,
};

/** The hostname a custom-domain resource name ends in. */
export function customDomainHostname(d: Pick<FirebaseCustomDomain, "name">): string {
  return d.name.split("/").pop() ?? d.name;
}

/** Firebase serves the site on this hostname. */
export function isCustomDomainActive(d: FirebaseCustomDomain): boolean {
  return !d.deleteTime && d.hostState === "HOST_ACTIVE" && d.ownershipState === "OWNERSHIP_ACTIVE";
}

function normaliseName(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/\.$/, "");
}

function recordKey(r: FirebaseDnsRecord): string {
  return `${normaliseName(r.domainName)}|${(r.type ?? "").toUpperCase()}|${(r.rdata ?? "").trim()}`;
}

function flatten(sets: readonly FirebaseDnsRecordSet[] | undefined): FirebaseDnsRecord[] {
  return (sets ?? []).flatMap((s) =>
    (s.records ?? []).map((r) => ({ ...r, domainName: r.domainName ?? s.domainName })),
  );
}

function toChange(r: FirebaseDnsRecord, action: "ADD" | "REMOVE"): DnsChange {
  return {
    action,
    type: r.type ?? "?",
    domainName: normaliseName(r.domainName),
    rdata: r.rdata ?? "",
  };
}

/** The DNS changes Firebase still waits for: explicit ADD/REMOVE plus undiscovered desired records. */
function pendingDnsChanges(d: FirebaseCustomDomain): DnsChange[] {
  const desired = flatten(d.requiredDnsUpdates?.desired);
  const discovered = flatten(d.requiredDnsUpdates?.discovered);
  const changes = new Map<string, DnsChange>();
  for (const r of [...desired, ...discovered]) {
    if (r.requiredAction === "ADD" || r.requiredAction === "REMOVE") {
      changes.set(`${r.requiredAction}|${recordKey(r)}`, toChange(r, r.requiredAction));
    }
  }
  const seen = new Set(discovered.map(recordKey));
  for (const r of desired) {
    if (r.requiredAction !== "REMOVE" && !seen.has(recordKey(r))) {
      changes.set(`ADD|${recordKey(r)}`, toChange(r, "ADD"));
    }
  }
  return [...changes.values()];
}

function ageMs(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, now.getTime() - t);
}

function humanAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 120) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/**
 * Classify one custom domain. Pure: `now` and the thresholds are inputs,
 * so the rule is pinned by unit tests instead of wall-clock behaviour.
 */
export function assessCustomDomain(
  d: FirebaseCustomDomain,
  now: Date,
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): CustomDomainHealth {
  const hostname = customDomainHostname(d);
  const base = {
    hostname,
    hostState: d.hostState ?? "HOST_STATE_UNSPECIFIED",
    ownershipState: d.ownershipState ?? "OWNERSHIP_STATE_UNSPECIFIED",
    certState: d.cert?.state ?? "CERT_STATE_UNSPECIFIED",
    checkTime: d.requiredDnsUpdates?.checkTime ?? null,
    updateTime: d.updateTime ?? null,
  };
  const states = `${base.hostState} / ${base.ownershipState}`;

  if (d.deleteTime) {
    return {
      ...base,
      status: "deleted",
      dnsChanges: [],
      summary: `deleted in Firebase at ${d.deleteTime}${
        d.expireTime ? ` (restorable until ${d.expireTime})` : ""
      } — Firebase does not serve the site on it. If that was not intended (e.g. an interrupted reconnect), reconnecting restores it.`,
    };
  }

  if (isCustomDomainActive(d)) {
    return {
      ...base,
      status: "active",
      dnsChanges: [],
      summary: `active — Firebase serves the site on ${hostname} (certificate ${base.certState}).`,
    };
  }

  const dnsChanges = pendingDnsChanges(d);
  if (dnsChanges.length > 0) {
    const list = dnsChanges
      .map((c) => `${c.action === "ADD" ? "add" : "remove"} ${c.type} ${c.domainName} ${c.rdata}`)
      .join("; ");
    return {
      ...base,
      status: "dns_pending",
      dnsChanges,
      summary: `waiting for DNS (${states}) — at the DNS provider: ${list}.`,
    };
  }

  if (flatten(d.requiredDnsUpdates?.desired).length === 0) {
    return {
      ...base,
      status: "provisioning",
      dnsChanges: [],
      summary: `provisioning (${states}) — Firebase has not computed the required DNS records yet.`,
    };
  }

  const checkAge = ageMs(d.requiredDnsUpdates?.checkTime, now);
  const updateAge = ageMs(d.updateTime, now);
  const staleCheck = checkAge !== null && checkAge > thresholds.staleCheckMs;
  const noProgress = updateAge !== null && updateAge > thresholds.noProgressMs;
  if (staleCheck || noProgress) {
    const why = staleCheck
      ? `Firebase last checked DNS ${humanAge(checkAge)} ago and stopped re-checking`
      : `the domain has not changed for ${humanAge(updateAge ?? 0)}`;
    return {
      ...base,
      status: "stuck",
      dnsChanges: [],
      summary:
        `stuck — reconnect recommended: every DNS record is in place, but the domain is still ${states} and ${why}. ` +
        "Reconnecting (delete + re-create the Firebase custom domain) makes Firebase verify it afresh; the domain is not serving yet, so nothing goes offline.",
    };
  }
  return {
    ...base,
    status: "provisioning",
    dnsChanges: [],
    summary: `verifying (${states}) — DNS is correct and Firebase is checking it${
      checkAge === null ? "" : ` (last check ${humanAge(checkAge)} ago)`
    }; this usually completes within minutes.`,
  };
}

/**
 * The active domains whose last change is newer than the live release —
 * i.e. that turned active after the CDN last had its cache purged. Firebase
 * caches the "Site Not Found" answer it served while the domain was not
 * active, and only a new release purges that cache.
 */
export function domainsActivatedSince(
  domains: readonly FirebaseCustomDomain[],
  releaseTime: string,
): FirebaseCustomDomain[] {
  const released = Date.parse(releaseTime);
  if (Number.isNaN(released)) return [];
  return domains.filter((d) => {
    if (!isCustomDomainActive(d) || !d.updateTime) return false;
    const changed = Date.parse(d.updateTime);
    return !Number.isNaN(changed) && changed > released;
  });
}
