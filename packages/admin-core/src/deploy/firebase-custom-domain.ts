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
 *     All three mutations answer with a long-running Operation: the DELETE
 *     is awaited to completion before the create (a create racing an
 *     unfinished delete hits the still-live domain), and a create/undelete
 *     Operation that is already done with an error fails the reconnect.
 *   - purgeCdnIfDomainsActivatedSinceLastRelease — Firebase's CDN keeps the
 *     "Site Not Found" 404 it served while the domain was inactive; a new
 *     release on the live channel purges it. Re-releasing the version that
 *     is already live changes no content. Stateless: it fires only while
 *     an active domain's `updateTime` is newer than the latest live
 *     release, so the release it creates also ends it. Every purge first
 *     takes the live-release lock (deploy/live-release-lock.ts) BEFORE it
 *     reads the live version, so a publish can never land between that
 *     read and the re-release and be rolled back by it.
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

/** Takes the live-release lock for the caller's transaction; false = a publish holds it, skip. */
export type AcquireLiveReleaseLock = () => Promise<boolean>;

/** A Firebase long-running Operation (customDomains create / delete / undelete). */
interface FirebaseOperation {
  readonly name?: string;
  readonly done?: boolean;
  readonly error?: { readonly code?: number; readonly message?: string };
}

function operationFailure(what: string, op: FirebaseOperation): Error | null {
  if (!op.error) return null;
  return new Error(
    `firebase-custom-domain: ${what} failed (${op.error.code ?? "?"}): ${op.error.message ?? "no detail"}`,
  );
}

interface PollOptions {
  readonly waitMs: number;
  readonly pollMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** Poll an Operation until it is done; throws on its error or when it outlasts `waitMs`. */
async function awaitOperation(
  t: HostingTarget,
  what: string,
  first: FirebaseOperation,
  poll: PollOptions,
): Promise<void> {
  const deadline = poll.now() + poll.waitMs;
  let op = first;
  while (!op.done) {
    // An Operation without a name cannot be polled; Firebase always names
    // pending ones, so treat a nameless answer as already applied.
    if (!op.name) return;
    if (poll.now() >= deadline) {
      throw new Error(
        `firebase-custom-domain: ${what} is still running in Firebase after ${Math.round(poll.waitMs / 1000)} s (${op.name}). ` +
          "Check the domain status again in a minute; if it shows 'deleted', reconnecting again finishes the job.",
      );
    }
    await poll.sleep(poll.pollMs);
    op = await firebaseFetch<FirebaseOperation>(op.name, { token: t.token });
  }
  const failure = operationFailure(what, op);
  if (failure) throw failure;
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
  acquireLock: AcquireLiveReleaseLock,
): Promise<CdnPurge | null> {
  if (!domains.some(isCustomDomainActive)) return null;
  // A publish is running: its own release purges the CDN; if not, the
  // next status read retries (the purge is stateless).
  if (!(await acquireLock())) return null;
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
  /** How long to wait for Firebase to finish the DELETE. Default 60 s. */
  readonly deleteWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** The live-release lock, taken before the post-activation CDN purge. */
  readonly acquireLiveReleaseLock: AcquireLiveReleaseLock;
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
  /** The domain is active but a publish held the live-release lock, so the purge was left to it. */
  readonly cdnPurgeDeferred: boolean;
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
  opts: ReconnectOptions,
): Promise<ReconnectResult> {
  const waitMs = opts.waitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 5_000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const poll: PollOptions = { waitMs: opts.deleteWaitMs ?? 60_000, pollMs, sleep, now };

  if (!opts.alreadyDeleted) {
    let deletion: FirebaseOperation | null = null;
    try {
      deletion = await firebaseFetch<FirebaseOperation>(hostnamePath(t, hostname), {
        method: "DELETE",
        token: t.token,
      });
    } catch (e) {
      // Already gone (e.g. a previous attempt deleted it) — create anyway.
      if (!isStatus(e, 404)) throw e;
    }
    // The DELETE only starts the deletion; creating before it finishes
    // would collide with the still-live domain.
    if (deletion) await awaitOperation(t, `deleting ${hostname}`, deletion, poll);
  }

  let method: ReconnectResult["method"] = "recreated";
  let started: FirebaseOperation;
  try {
    started = await firebaseFetch<FirebaseOperation>(
      `${domainsPath(t)}?customDomainId=${encodeURIComponent(hostname)}`,
      { method: "POST", body: JSON.stringify({}), token: t.token },
    );
  } catch (e) {
    const alreadyExists =
      isStatus(e, 409) || (isStatus(e, 400) && /already exists/i.test(e.message));
    if (!alreadyExists) throw e;
    // The soft-deleted domain still holds the id: restore it instead.
    started = await firebaseFetch<FirebaseOperation>(`${hostnamePath(t, hostname)}:undelete`, {
      method: "POST",
      body: JSON.stringify({}),
      token: t.token,
    });
    method = "undeleted";
  }
  // Not awaited to completion (it runs on through verification, which the
  // HOST_ACTIVE poll below covers) — but an Operation that already failed
  // must not read as a successful reconnect.
  const failed = operationFailure(
    `${method === "undeleted" ? "restoring" : "re-creating"} ${hostname}`,
    started,
  );
  if (failed) throw failed;

  const deadline = now() + waitMs;
  let domain = await getCustomDomain(t, hostname);
  while (!(domain && isCustomDomainActive(domain)) && now() < deadline) {
    await sleep(pollMs);
    domain = await getCustomDomain(t, hostname);
  }
  const active = domain !== null && isCustomDomainActive(domain);
  const base = { method, active, domain, cdnPurge: null, cdnPurgeError: null };
  if (!active) return { ...base, cdnPurgeDeferred: false };
  try {
    // Lock BEFORE reading the live version (see module doc).
    if (!(await opts.acquireLiveReleaseLock())) return { ...base, cdnPurgeDeferred: true };
    const versionName = releasableVersion(await latestLiveRelease(t));
    const cdnPurge = versionName ? await releaseLiveAgain(t, versionName, [hostname]) : null;
    return { ...base, cdnPurge, cdnPurgeDeferred: false };
  } catch (e) {
    return { ...base, cdnPurgeError: (e as Error).message, cdnPurgeDeferred: false };
  }
}
