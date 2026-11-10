// SPDX-License-Identifier: MPL-2.0

/**
 * Release candidates on Google Cloud installs (#1558).
 *
 * A release candidate (`vX.Y.Z-rc.N`, any version with a pre-release part)
 * is cut to test a release on a scratch install before any install is
 * offered it. In Caelo's Google Cloud registry, the mirror Cloud Run pulls
 * from, its images carry the marker tag `rc-<version>` and a cleanup rule
 * deletes them once they are {@link RELEASE_CANDIDATE_RETENTION_DAYS} days
 * old (docs/maintainer-ar-cleanup-policy.json; the registry's keep-10 rule
 * can only hold one longer, never shorter). Cloud Run
 * services keep running on the copy they imported at deploy time, but Cloud
 * Run jobs pull their image each time they run, so from then on such an
 * install loses its in-product updates (the upgrader's first stage runs the
 * installed release's image), its converge job, its quality audit and its
 * page captures. Installing or upgrading to one therefore warns and needs a
 * confirmation.
 *
 * Self-hosted installs pull from GHCR, which keeps release candidates, so
 * none of this applies to them.
 *
 * `--channel rc|beta` resolves here too: the pipeline publishes no moving
 * channel tag, so a channel becomes an exact version before anything is
 * resolved, and is then treated like `--version`.
 */

import { channelForVersion, compareSemver, type ReleaseChannel } from "./release-manifest.js";
import { canonicalReleaseTag } from "./upgrade/release-images.js";

/** Days a release candidate's images stay in the Google Cloud registry (the cleanup rule's `olderThan`). */
export const RELEASE_CANDIDATE_RETENTION_DAYS = 14;

/** The prefix of the marker tag a release candidate's images and manifest carry in that registry. */
export const RELEASE_CANDIDATE_TAG_PREFIX = "rc-";

/** The flag that confirms a release candidate where no prompt can ask (a script, CI). */
export const ACCEPT_RELEASE_CANDIDATE_FLAG = "--accept-release-candidate";

const PRERELEASE = /^v?\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;

/**
 * Whether `version` is a pre-release (`0.12.5-rc.1`, `v0.13.0-beta.2`): the
 * versions the release pipeline publishes as release candidates.
 */
export function isPrereleaseVersion(version: string): boolean {
  return PRERELEASE.test(version);
}

/** What the operator is about to do with a release candidate. */
export type ReleaseCandidateAction = "install" | "upgrade";

/**
 * Why a release candidate is for test installs only, in the words the CLI
 * prints before it asks.
 *
 * @param version - the release candidate, with or without a leading `v`.
 */
export function releaseCandidateWarning(version: string): string[] {
  const v = version.replace(/^v/, "");
  return [
    `v${v} is a release candidate, meant for test installs only.`,
    `Caelo's Google Cloud registry keeps a release candidate's images for ${RELEASE_CANDIDATE_RETENTION_DAYS} days after it was published, then deletes them.`,
    "The Cloud Run services keep running on their own copy of the image, but the install's Cloud Run jobs (update, converge, quality audit, page capture) pull their image each time they run.",
    "From then on the install can no longer update from Settings → Updates or audit a Stage; only an upgrade from a terminal moves it on to a newer release.",
  ];
}

/** The side effects of {@link confirmReleaseCandidate}, injectable for tests. */
export interface ReleaseCandidatePrompt {
  /** Show the warning lines. */
  readonly warn: (lines: readonly string[]) => void;
  /** Ask a yes/no question (default no); false also for a cancelled prompt. */
  readonly confirm: (message: string) => Promise<boolean>;
}

/** How {@link confirmReleaseCandidate} decided. */
export type ReleaseCandidateDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `declined`: the operator said no. `needs-flag`: no prompt could ask. */
      readonly reason: "declined" | "needs-flag";
      readonly message: string;
    };

/**
 * Let a release candidate through only once the operator confirmed it: in a
 * terminal by answering the prompt, elsewhere by passing
 * {@link ACCEPT_RELEASE_CANDIDATE_FLAG}. A stable version passes untouched.
 *
 * @param opts.interactive - whether a prompt can be shown (a TTY, and no `--non-interactive`).
 * @param opts.accepted - whether {@link ACCEPT_RELEASE_CANDIDATE_FLAG} was passed.
 */
export async function confirmReleaseCandidate(
  opts: {
    readonly version: string;
    readonly action: ReleaseCandidateAction;
    readonly interactive: boolean;
    readonly accepted: boolean;
  },
  prompt: ReleaseCandidatePrompt,
): Promise<ReleaseCandidateDecision> {
  if (!isPrereleaseVersion(opts.version)) return { ok: true };
  const v = opts.version.replace(/^v/, "");
  prompt.warn(releaseCandidateWarning(v));
  if (opts.accepted) return { ok: true };
  if (!opts.interactive) {
    return {
      ok: false,
      reason: "needs-flag",
      message: `Nothing was changed: v${v} is a release candidate. To ${opts.action} it without a prompt, pass ${ACCEPT_RELEASE_CANDIDATE_FLAG}.`,
    };
  }
  const question =
    opts.action === "install"
      ? `Install release candidate v${v} anyway?`
      : `Upgrade to release candidate v${v} anyway?`;
  if (await prompt.confirm(question)) return { ok: true };
  return {
    ok: false,
    reason: "declined",
    message: `Nothing was changed. For an install you keep, ${opts.action} a stable release.`,
  };
}

/** The channels `--channel` names, from the most to the least stable. */
const CHANNEL_ORDER: readonly ReleaseChannel[] = ["stable", "rc", "beta", "alpha"];

/** Caelo's GitHub releases, newest first (one page: the newest stable release is always on it). */
const RELEASES_URL = "https://api.github.com/repos/caelo-cms/caelo-cms/releases?per_page=100";

/**
 * The exact version `--channel <channel>` installs: the newest release on
 * that channel or a more stable one, so an rc subscriber whose release
 * candidate became final gets the final release, never the older candidate.
 * Read from the GitHub releases (the registry has no moving channel tag);
 * the tags are rebuilt from a constant alphabet before anything uses them.
 *
 * @example await resolveChannelVersion("rc") // → { ok: true, version: "0.12.5-rc.1" }
 */
export async function resolveChannelVersion(
  channel: "rc" | "beta",
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  const allowed = new Set(CHANNEL_ORDER.slice(0, CHANNEL_ORDER.indexOf(channel) + 1));
  let releases: unknown;
  try {
    const res = await fetchImpl(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { ok: false, reason: `GitHub API HTTP ${res.status} ${res.statusText}` };
    releases = await res.json();
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!Array.isArray(releases)) return { ok: false, reason: "GitHub returned no release list" };
  let newest: string | null = null;
  for (const r of releases as { tag_name?: unknown; draft?: unknown }[]) {
    if (r.draft === true || typeof r.tag_name !== "string") continue;
    const tag = canonicalReleaseTag(r.tag_name);
    const version = tag?.replace(/^v/, "") ?? null;
    if (!version) continue;
    const onChannel = channelForVersion(version);
    if (!onChannel || !allowed.has(onChannel)) continue;
    if (newest === null || compareSemver(version, newest) > 0) newest = version;
  }
  return newest
    ? { ok: true, version: newest }
    : { ok: false, reason: `no ${channel} or stable release on GitHub` };
}
