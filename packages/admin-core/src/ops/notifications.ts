// SPDX-License-Identifier: MPL-2.0

/**
 * P6.6b — notification surface for the AppShell topbar bell. Reads
 * three sources and aggregates a single counter the bell dropdown
 * uses to render a per-source breakdown:
 *
 *   - pendingProposals — site_memory_proposals awaiting Owner review.
 *   - failedDeploys    — deploy_runs.status='failed' in the last 7 days.
 *   - staleBranches    — chat_sessions whose last_active_at is over 14
 *                        days old, no published_at, no archived_at.
 *
 * P20 — also surfaces the cms-provision-style "newer release available"
 * hint (`upgradeAvailable` + `latestVersion`). Polls
 * github.com/caelo-cms/caelo-cms/releases/latest with a 24h
 * in-process cache and a 5s AbortSignal so a slow GitHub never
 * blocks the bell. Failures degrade silently to upgradeAvailable=false.
 *
 * Single op (not four) so the AppShell makes one network call per
 * poll. Adapter / Validator runs in the same actor scope as the
 * caller so the read is RLS-safe (every authenticated user can see
 * their own notification surface).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { CAELO_VERSION, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const notificationsRow = z.object({
  pendingProposals: z.number().int().nonnegative(),
  failedDeploys: z.number().int().nonnegative(),
  staleBranches: z.number().int().nonnegative(),
  upgradeAvailable: z.boolean(),
  latestVersion: z.string().nullable(),
  releaseUrl: z.string().nullable(),
  total: z.number().int().nonnegative(),
});

const RELEASE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RELEASE_FETCH_TIMEOUT_MS = 5_000;
let releaseCheckCache: {
  fetchedAt: number;
  latestVersion: string | null;
  releaseUrl: string | null;
} | null = null;

async function checkLatestRelease(): Promise<{
  latestVersion: string | null;
  releaseUrl: string | null;
}> {
  const now = Date.now();
  if (releaseCheckCache && now - releaseCheckCache.fetchedAt < RELEASE_CACHE_TTL_MS) {
    return {
      latestVersion: releaseCheckCache.latestVersion,
      releaseUrl: releaseCheckCache.releaseUrl,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.github.com/repos/caelo-cms/caelo-cms/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      releaseCheckCache = { fetchedAt: now, latestVersion: null, releaseUrl: null };
      return { latestVersion: null, releaseUrl: null };
    }
    const json = (await res.json()) as { tag_name?: string; html_url?: string };
    const latestVersion = json.tag_name?.replace(/^v/, "") ?? null;
    const releaseUrl = json.html_url ?? null;
    releaseCheckCache = { fetchedAt: now, latestVersion, releaseUrl };
    return { latestVersion, releaseUrl };
  } catch {
    // Network failure / abort / parse error — cache the negative result
    // so we don't retry every request for the next 24h.
    releaseCheckCache = { fetchedAt: now, latestVersion: null, releaseUrl: null };
    return { latestVersion: null, releaseUrl: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compare two semver strings; returns true when `latest` > `current`.
 * Treats pre-release tags as < the same X.Y.Z stable. Mirrors the
 * comparison in scripts/release.ts so the upgrade hint matches the
 * release pipeline's own ordering.
 */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): { mmp: [number, number, number]; pre: string | null } => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
    if (!m) return { mmp: [0, 0, 0], pre: null };
    return {
      mmp: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ?? null,
    };
  };
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a.mmp[i] ?? 0) > (b.mmp[i] ?? 0)) return true;
    if ((a.mmp[i] ?? 0) < (b.mmp[i] ?? 0)) return false;
  }
  // Same X.Y.Z → pre-release < stable < higher pre-release-string.
  if (a.pre && !b.pre) return false;
  if (!a.pre && b.pre) return true;
  if (a.pre && b.pre) return a.pre > b.pre;
  return false;
}

export const aggregateNotificationsOp = defineOperation({
  name: "notifications.aggregate",
  // Open to every authenticated actor — the AppShell renders for
  // human + system; AI actors don't render UI but the read is
  // harmless and keeps the schema simple.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: notificationsRow,
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM site_memory_proposals WHERE status = 'pending') AS pending_proposals,
        (SELECT count(*)::int FROM deploy_runs
           WHERE status = 'failed' AND started_at > now() - interval '7 days') AS failed_deploys,
        (SELECT count(*)::int FROM chat_sessions
           WHERE last_active_at < now() - interval '14 days'
             AND archived_at IS NULL
             AND published_at IS NULL) AS stale_branches
    `)) as unknown as {
      pending_proposals: number | string;
      failed_deploys: number | string;
      stale_branches: number | string;
    }[];
    const r = rows[0] ?? { pending_proposals: 0, failed_deploys: 0, stale_branches: 0 };
    const toInt = (v: number | string): number =>
      typeof v === "string" ? Number.parseInt(v, 10) : v;
    const pendingProposals = toInt(r.pending_proposals);
    const failedDeploys = toInt(r.failed_deploys);
    const staleBranches = toInt(r.stale_branches);

    // P20 — release-check piggybacks on this op so the bell renders
    // upgrade availability without adding a second poll.
    const release = await checkLatestRelease();
    const upgradeAvailable =
      release.latestVersion !== null && isNewerVersion(release.latestVersion, CAELO_VERSION);

    return ok({
      pendingProposals,
      failedDeploys,
      staleBranches,
      upgradeAvailable,
      latestVersion: release.latestVersion,
      releaseUrl: release.releaseUrl,
      // Bell badge count includes "1" for the upgrade tile so the
      // operator notices a new release the same way they notice a
      // pending proposal.
      total: pendingProposals + failedDeploys + staleBranches + (upgradeAvailable ? 1 : 0),
    });
  },
});
