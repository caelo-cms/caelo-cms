// SPDX-License-Identifier: MPL-2.0

/**
 * The release check: ask GitHub for the newest Caelo release and keep the
 * answer in `release_check_cache` (singleton row), which
 * `platform_updates.status` reads for Settings → Updates, the bell and the
 * AI's `get_caelo_version`.
 *
 * Two callers share it:
 *   - the release-check worker, once at admin start and then hourly;
 *   - Settings → Updates' "Check now" (`checkReleasesNow`), which records
 *     its result through the human-only `platform_updates.check_now` op.
 *
 * The network call always happens OUTSIDE any database transaction
 * (`fetchLatestRelease`); only the cache write (`writeReleaseCheck`) runs in
 * one. A slow GitHub holding a pooled connection open is the
 * connection-pool exhaustion vector P21 ship 5 removed — see
 * release-check-worker.ts.
 */

import {
  type DatabaseAdapter,
  execute,
  type OperationRegistry,
  type QueryError,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import { CAELO_VERSION, type ExecutionContext, isNewerVersion } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { type ManifestReader, readReleaseFacts } from "./release-facts.js";

export const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/caelo-cms/caelo-cms/releases/latest";
const FETCH_TIMEOUT_MS = 5_000;
/** Settings → Updates shows an excerpt; the full notes stay on GitHub. */
const RELEASE_NOTES_MAX_CHARS = 20_000;

/**
 * A "Check now" click within this long of the last check (by anyone, or the
 * hourly worker) is refused: GitHub allows 60 unauthenticated API calls an
 * hour per IP, and a release does not appear more often than that.
 */
export const RELEASE_CHECK_COOLDOWN_MS = 60_000;

/** Why the check did not produce a release. */
export const RELEASE_CHECK_PROBLEMS = [
  "unreachable",
  "rate_limited",
  "http_error",
  "malformed",
] as const;

const githubReleaseSchema = z
  .object({
    reached: z.literal(true),
    latestVersion: z.string().min(1).max(100),
    releaseUrl: z.string().max(2000).nullable(),
    releaseNotes: z.string().max(RELEASE_NOTES_MAX_CHARS).nullable(),
    publishedAt: z.string().max(100).nullable(),
  })
  .strict();

const checkFailedSchema = z
  .object({
    reached: z.literal(false),
    problem: z.enum(RELEASE_CHECK_PROBLEMS),
    message: z.string().min(1).max(500),
  })
  .strict();

/** What GitHub answered: the newest release, or why there is none. */
export type GitHubReleaseOutcome =
  | z.infer<typeof githubReleaseSchema>
  | z.infer<typeof checkFailedSchema>;

/**
 * What one release check found: the newest release plus how it would be
 * installed (#817), or why there is none.
 */
export const releaseCheckOutcomeSchema = z.discriminatedUnion("reached", [
  githubReleaseSchema
    .extend({
      /**
       * The release raises the infrastructure contract over the running
       * release (its manifest vs the running release's), so the in-admin
       * upgrader cannot install it. null = not known (a manifest could not
       * be read) or nothing to install. Display only: the upgrader job
       * re-decides from the signed manifest before it changes anything.
       */
      infraChange: z.boolean().nullable(),
    })
    .strict(),
  checkFailedSchema,
]);

/** Output of `predictReleaseRoute`; input of `writeReleaseCheck`. */
export type ReleaseCheckOutcome = z.infer<typeof releaseCheckOutcomeSchema>;

/** The `fetch` shape the check needs — injectable for tests and the e2e stand-in. */
export type ReleaseFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Options for `fetchLatestRelease`. */
export interface FetchLatestReleaseOpts {
  /** Defaults to Caelo's GitHub "latest release" API URL. */
  readonly url?: string;
  /** Defaults to the global `fetch`. */
  readonly fetchImpl?: ReleaseFetch;
}

/** GitHub's rate-limit answer: 403/429 with no requests left. */
function rateLimitMessage(res: Response): string | null {
  const limited =
    res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
  if (!limited) return null;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const when =
    Number.isFinite(reset) && reset > 0
      ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC`
      : " for a while";
  return `GitHub is limiting how often this server may ask${when}. Caelo checks again by itself every hour.`;
}

/**
 * Ask GitHub for the newest release. Never throws and never touches the
 * database: a failure comes back as `{ reached: false, problem, message }`
 * with a sentence the page can show as it is.
 */
export async function fetchLatestRelease(
  opts: FetchLatestReleaseOpts = {},
): Promise<GitHubReleaseOutcome> {
  const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  let res: Response;
  try {
    res = await doFetch(opts.url ?? GITHUB_LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return {
      reached: false,
      problem: "unreachable",
      message: timedOut
        ? "GitHub did not answer within 5 seconds. Try again in a few minutes."
        : "Could not reach GitHub from this server. Check its internet access, or try again in a few minutes.",
    };
  }
  const limited = rateLimitMessage(res);
  if (limited) return { reached: false, problem: "rate_limited", message: limited };
  if (!res.ok) {
    return {
      reached: false,
      problem: "http_error",
      message: `GitHub answered the release check with HTTP ${res.status}. Try again in a few minutes.`,
    };
  }
  let json: { tag_name?: unknown; html_url?: unknown; body?: unknown; published_at?: unknown };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return {
      reached: false,
      problem: "malformed",
      message: "GitHub's answer to the release check was not readable. Try again later.",
    };
  }
  const tag = typeof json.tag_name === "string" ? json.tag_name.replace(/^v/, "") : "";
  if (tag === "") {
    return {
      reached: false,
      problem: "malformed",
      message: "GitHub's answer to the release check named no release. Try again later.",
    };
  }
  return {
    reached: true,
    latestVersion: tag.slice(0, 100),
    releaseUrl: typeof json.html_url === "string" ? json.html_url.slice(0, 2000) : null,
    releaseNotes:
      typeof json.body === "string" && json.body !== ""
        ? json.body.slice(0, RELEASE_NOTES_MAX_CHARS)
        : null,
    publishedAt: typeof json.published_at === "string" ? json.published_at : null,
  };
}

/** What {@link predictReleaseRoute} needs: where manifests come from, and the install's provider. */
export interface RoutePredictionOpts {
  /** Reads release manifests from the registry (release-facts.ts). */
  readonly readManifest: ManifestReader;
  /** `CAELO_PROVIDER` as Settings → Updates resolves it (`self-hosted` has no cloud setup to change). */
  readonly provider: string | undefined;
}

/**
 * Add the route to a release GitHub named (#817): does it raise the
 * infrastructure contract over the running release? Reads the manifests
 * over the network, so it runs outside any transaction like the fetch. The
 * same comparison the auto-update scheduler makes (`readReleaseFacts`), so
 * the page and the scheduler never disagree about a release.
 */
export async function predictReleaseRoute(
  outcome: GitHubReleaseOutcome,
  opts: RoutePredictionOpts,
): Promise<ReleaseCheckOutcome> {
  if (!outcome.reached) return outcome;
  // Not newer than what runs: there is no install to route.
  if (!isNewerVersion(outcome.latestVersion, CAELO_VERSION)) {
    return { ...outcome, infraChange: null };
  }
  const facts = await readReleaseFacts(
    {
      installedVersion: CAELO_VERSION,
      targetVersion: outcome.latestVersion,
      provider: opts.provider,
    },
    opts.readManifest,
  );
  return { ...outcome, infraChange: "unavailable" in facts ? null : facts.infraChange };
}

/**
 * Store one check's result in the cache. A failed check clears the release
 * (NULLs) and still stamps `fetched_at`, so the page can say "the last check
 * failed" instead of showing a stale "Up to date".
 *
 * `onlyIfOlderThanMs`: write only when the previous check is at least that
 * old (the "Check now" cooldown, decided inside the same transaction so two
 * simultaneous clicks cannot both write). Returns whether it wrote.
 */
export async function writeReleaseCheck(
  tx: TransactionRunner,
  outcome: ReleaseCheckOutcome,
  onlyIfOlderThanMs?: number,
): Promise<boolean> {
  const release = outcome.reached
    ? outcome
    : {
        latestVersion: null,
        releaseUrl: null,
        releaseNotes: null,
        publishedAt: null,
        infraChange: null,
      };
  const cooldown =
    onlyIfOlderThanMs === undefined
      ? sql`true`
      : sql`fetched_at <= now() - (${Math.round(onlyIfOlderThanMs)}::int * interval '1 millisecond')`;
  const rows = (await tx.execute(sql`
    UPDATE release_check_cache
       SET latest_version = ${release.latestVersion},
           release_url    = ${release.releaseUrl},
           release_notes  = ${release.releaseNotes},
           published_at   = ${release.publishedAt}::timestamptz,
           latest_infra_change = ${release.infraChange}::boolean,
           infra_change_from   = ${outcome.reached ? CAELO_VERSION : null},
           fetched_at     = now()
     WHERE id = 1 AND ${cooldown}
     RETURNING id
  `)) as unknown as { id: number }[];
  return rows.length > 0;
}

/**
 * Milliseconds until "Check now" may run again, 0 when it may run now.
 * `checkedAt` null = never checked.
 */
export function releaseCheckCooldownMs(checkedAt: string | null, now: Date): number {
  if (checkedAt === null) return 0;
  const since = now.getTime() - new Date(checkedAt).getTime();
  // A clock that puts the last check in the future still waits one cooldown.
  if (since < 0) return RELEASE_CHECK_COOLDOWN_MS;
  return Math.max(0, RELEASE_CHECK_COOLDOWN_MS - since);
}

/** The sentence a refused "Check now" shows. */
export function releaseCheckCooldownMessage(remainingMs: number): string {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return `Caelo checked for new releases less than a minute ago. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
}

/** Result of `checkReleasesNow`. */
export type CheckReleasesNowResult =
  | { readonly ok: true; readonly latestVersion: string }
  | {
      readonly ok: false;
      readonly kind: "cooldown" | "check_failed" | "op_failed";
      readonly message: string;
    };

/** Options for `checkReleasesNow`. */
export interface CheckReleasesNowOpts extends FetchLatestReleaseOpts, RoutePredictionOpts {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  /** The human who clicked "Check now". */
  readonly ctx: ExecutionContext;
  /** Clock for the cooldown; defaults to now. */
  readonly now?: Date;
}

function errorMessage(error: QueryError, fallback: string): string {
  if (error.kind === "RateLimited") {
    return releaseCheckCooldownMessage(error.retryAfterMs ?? RELEASE_CHECK_COOLDOWN_MS);
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message !== "" ? message : fallback;
}

/**
 * "Check now" on Settings → Updates: run the release check immediately.
 *
 *   1. read when the last check ran (`platform_updates.status`) and refuse
 *      within the cooldown — before any request goes to GitHub;
 *   2. ask GitHub, and read the release's manifest for its route, outside
 *      any transaction;
 *   3. record the result with `platform_updates.check_now` (permission,
 *      cooldown re-checked in its transaction, audit).
 */
export async function checkReleasesNow(
  opts: CheckReleasesNowOpts,
): Promise<CheckReleasesNowResult> {
  const { registry, adapter, ctx } = opts;
  const status = await execute(registry, adapter, ctx, "platform_updates.status", {});
  if (!status.ok) {
    return {
      ok: false,
      kind: "op_failed",
      message: errorMessage(status.error, "Could not read when Caelo last checked for releases."),
    };
  }
  const { checkedAt } = status.value as { checkedAt: string | null };
  const wait = releaseCheckCooldownMs(checkedAt, opts.now ?? new Date());
  if (wait > 0) return { ok: false, kind: "cooldown", message: releaseCheckCooldownMessage(wait) };

  const outcome = await predictReleaseRoute(await fetchLatestRelease(opts), opts);
  const recorded = await execute(registry, adapter, ctx, "platform_updates.check_now", {
    outcome,
  });
  if (!recorded.ok) {
    return {
      ok: false,
      kind: recorded.error.kind === "RateLimited" ? "cooldown" : "op_failed",
      message: errorMessage(recorded.error, "Could not save the release check."),
    };
  }
  if (!outcome.reached) return { ok: false, kind: "check_failed", message: outcome.message };
  return { ok: true, latestVersion: outcome.latestVersion };
}
