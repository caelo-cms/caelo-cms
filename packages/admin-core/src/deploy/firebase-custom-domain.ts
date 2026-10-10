// SPDX-License-Identifier: MPL-2.0

/**
 * Firebase Hosting custom domains — status, self-heal (reconnect) and the
 * CDN purge after a domain turns active. Used on `CAELO_PROVIDER=gcp-firebase`
 * installs, where the gcp-firebase Pulumi stack creates the apex custom
 * domain on the Hosting site (`CAELO_FIREBASE_SITE`).
 *
 * The rule that decides "stuck" lives in firebase-custom-domain-health.ts
 * (pure). This module is the REST side:
 *
 *   - listCustomDomains / getCustomDomain — read the domains + their states.
 *   - reconnectCustomDomain — DELETE then POST `customDomains?customDomainId=`
 *     (Firebase re-runs ownership + host verification from scratch). DELETE
 *     is a soft delete (30-day expiry); when the create answers "already
 *     exists" the soft-deleted domain is restored with `:undelete`, which
 *     also restarts verification. Then polls briefly for HOST_ACTIVE.
 *   - purgeCdnIfDomainsActivatedSinceLastRelease — Firebase's CDN keeps the
 *     "Site Not Found" 404 it served while the domain was inactive; a new
 *     release on the live channel purges it. Re-releasing the version that
 *     is already live changes no content. Stateless: it fires only while
 *     an active domain's `updateTime` is newer than the latest live
 *     release, so the release it creates also ends it.
 */

import {
  customDomainHostname,
  domainsActivatedSince,
  type FirebaseCustomDomain,
  isCustomDomainActive,
} from "./firebase-custom-domain-health.js";
import {
  FirebaseHostingHttpError,
  firebaseFetch,
  googleAuthToken,
  siteName,
} from "./static-publisher-firebase.js";

/** Where the custom domains live + the token to reach them. */
export interface HostingTarget {
  readonly project: string;
  readonly site: string;
  readonly token: string;
}

/** Resolve the install's Firebase project + site + an ADC token. */
export async function resolveHostingTarget(): Promise<HostingTarget> {
  const site = siteName();
  // customDomains is project-scoped (`projects/<p>/sites/<s>/…`). The
  // stack sets no project env on the admin service; Cloud Run's metadata
  // server answers ADC's project lookup.
  let project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.CAELO_PROVIDER_PROJECT;
  if (!project) {
    const { GoogleAuth } = await import("google-auth-library");
    project = await new GoogleAuth().getProjectId();
  }
  if (!project) {
    throw new Error(
      "firebase-custom-domain: could not resolve the GCP project (GOOGLE_CLOUD_PROJECT unset and ADC returned none).",
    );
  }
  const token = await googleAuthToken(["https://www.googleapis.com/auth/cloud-platform"]);
  return { project, site, token };
}

function domainsPath(t: HostingTarget): string {
  return `projects/${t.project}/sites/${t.site}/customDomains`;
}

function hostnamePath(t: HostingTarget, hostname: string): string {
  return `${domainsPath(t)}/${encodeURIComponent(hostname)}`;
}

function isStatus(e: unknown, ...statuses: number[]): e is FirebaseHostingHttpError {
  return e instanceof FirebaseHostingHttpError && statuses.includes(e.status);
}

/** Every custom domain of the site, soft-deleted ones included (they carry `deleteTime`). */
export async function listCustomDomains(t: HostingTarget): Promise<FirebaseCustomDomain[]> {
  type Page = { customDomains?: FirebaseCustomDomain[]; nextPageToken?: string };
  const out: FirebaseCustomDomain[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({ showDeleted: "true" });
    if (pageToken) query.set("pageToken", pageToken);
    const page = await firebaseFetch<Page>(`${domainsPath(t)}?${query}`, { token: t.token });
    out.push(...(page.customDomains ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/** The custom domain, or null when the site has none by that name. */
export async function getCustomDomain(
  t: HostingTarget,
  hostname: string,
): Promise<FirebaseCustomDomain | null> {
  try {
    return await firebaseFetch<FirebaseCustomDomain>(hostnamePath(t, hostname), {
      token: t.token,
    });
  } catch (e) {
    if (isStatus(e, 404)) return null;
    throw e;
  }
}

interface LiveRelease {
  readonly name: string;
  readonly type?: string;
  readonly releaseTime?: string;
  readonly version?: { readonly name?: string };
}

async function latestLiveRelease(t: HostingTarget): Promise<LiveRelease | null> {
  const r = await firebaseFetch<{ releases?: LiveRelease[] }>(
    `sites/${t.site}/channels/live/releases?pageSize=1`,
    { token: t.token },
  );
  return r.releases?.[0] ?? null;
}

export interface CdnPurge {
  /** The live version that was re-released. */
  readonly versionName: string;
  /** The domains whose activation triggered the purge. */
  readonly hostnames: string[];
}

/** A release that re-points the live channel at a version (purges the CDN). */
function releasableVersion(release: LiveRelease | null): string | null {
  // SITE_DISABLE releases carry no version: the site is switched off on
  // purpose, and re-enabling it is not this module's call.
  if (!release || release.type === "SITE_DISABLE") return null;
  return release.version?.name ?? null;
}

async function releaseLiveAgain(
  t: HostingTarget,
  versionName: string,
  hostnames: string[],
): Promise<CdnPurge> {
  await firebaseFetch(`sites/${t.site}/releases?versionName=${versionName}`, {
    method: "POST",
    body: JSON.stringify({
      message: `Caelo: purge CDN cache after custom domain ${hostnames.join(", ")} became active`,
    }),
    token: t.token,
  });
  return { versionName, hostnames };
}

/**
 * Re-release the live version when an active domain changed after the
 * latest live release (see module doc). Null when nothing needs purging
 * or nothing is live yet.
 */
export async function purgeCdnIfDomainsActivatedSinceLastRelease(
  t: HostingTarget,
  domains: readonly FirebaseCustomDomain[],
): Promise<CdnPurge | null> {
  if (!domains.some(isCustomDomainActive)) return null;
  const head = await latestLiveRelease(t);
  const versionName = releasableVersion(head);
  if (!head || !versionName || !head.releaseTime) return null;
  const activated = domainsActivatedSince(domains, head.releaseTime);
  if (activated.length === 0) return null;
  return releaseLiveAgain(t, versionName, activated.map(customDomainHostname));
}

export interface ReconnectOptions {
  /** The domain is already soft-deleted (an interrupted reconnect): skip the DELETE. */
  readonly alreadyDeleted?: boolean;
  /** How long to wait for HOST_ACTIVE after re-creating. Default 60 s. */
  readonly waitMs?: number;
  /** Poll interval while waiting. Default 5 s. */
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface ReconnectResult {
  /** `recreated` (DELETE + POST) or `undeleted` (POST said it still exists). */
  readonly method: "recreated" | "undeleted";
  readonly active: boolean;
  /** The domain as last read after the reconnect (null if not readable yet). */
  readonly domain: FirebaseCustomDomain | null;
  /** The CDN purge, when the domain turned active within the wait window. */
  readonly cdnPurge: CdnPurge | null;
  /** Set when the domain is active but the purge release failed. */
  readonly cdnPurgeError: string | null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Delete + re-create the custom domain so Firebase verifies it afresh,
 * then wait briefly for it to go active and purge the CDN when it does.
 * When it is not active within the window, the next status read
 * (`domains.hosting_status`) purges once it is — the re-created domain's
 * `updateTime` is newer than the live release.
 */
export async function reconnectCustomDomain(
  t: HostingTarget,
  hostname: string,
  opts: ReconnectOptions = {},
): Promise<ReconnectResult> {
  const waitMs = opts.waitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 5_000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  if (!opts.alreadyDeleted) {
    try {
      await firebaseFetch(hostnamePath(t, hostname), { method: "DELETE", token: t.token });
    } catch (e) {
      // Already gone (e.g. a previous attempt deleted it) — create anyway.
      if (!isStatus(e, 404)) throw e;
    }
  }

  let method: ReconnectResult["method"] = "recreated";
  try {
    await firebaseFetch(`${domainsPath(t)}?customDomainId=${encodeURIComponent(hostname)}`, {
      method: "POST",
      body: JSON.stringify({}),
      token: t.token,
    });
  } catch (e) {
    const alreadyExists =
      isStatus(e, 409) || (isStatus(e, 400) && /already exists/i.test(e.message));
    if (!alreadyExists) throw e;
    // The soft-deleted domain still holds the id: restore it instead.
    await firebaseFetch(`${hostnamePath(t, hostname)}:undelete`, {
      method: "POST",
      body: JSON.stringify({}),
      token: t.token,
    });
    method = "undeleted";
  }

  const deadline = now() + waitMs;
  let domain = await getCustomDomain(t, hostname);
  while (!(domain && isCustomDomainActive(domain)) && now() < deadline) {
    await sleep(pollMs);
    domain = await getCustomDomain(t, hostname);
  }
  const active = domain !== null && isCustomDomainActive(domain);
  if (!active) {
    return { method, active, domain, cdnPurge: null, cdnPurgeError: null };
  }
  try {
    const versionName = releasableVersion(await latestLiveRelease(t));
    const cdnPurge = versionName ? await releaseLiveAgain(t, versionName, [hostname]) : null;
    return { method, active, domain, cdnPurge, cdnPurgeError: null };
  } catch (e) {
    return { method, active, domain, cdnPurge: null, cdnPurgeError: (e as Error).message };
  }
}
