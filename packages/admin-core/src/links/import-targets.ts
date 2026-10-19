// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — the pages an active site import has planned
 * but not rebuilt yet, as pending link targets.
 *
 * In the migrate flow the AI rebuilds a crawled site page by page. The
 * homepage links to /pricing long before /pricing is built, and rollout
 * C refuses a write that links to a page that does not exist. While an
 * import run is active on the writing chat's branch, a link to one of
 * that run's planned pages is therefore kept literal (never refused) and
 * recorded against the run in `import_run_links`. Finalising the run
 * (`imports.resolve_links` — the skill calls it at the end, and the
 * run's cleanup does too) converts those links to references once the
 * pages exist; what still matches no page is reported in the run report.
 *
 * "Planned" is what the crawl recorded for the run: each import page's
 * source path (and the URL it was requested under) plus its proposed
 * slug. A link to any other unknown path is still refused — a typo is not
 * a planned page.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { normaliseLinkPath, type PendingLinkTarget } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** The active import runs of one branch and the paths they plan. */
export interface ActiveImportTargets {
  /** Planned path → the runs that plan it (normally one). */
  readonly runsByPath: ReadonlyMap<string, readonly string[]>;
  /** The crawled sites' hosts: an absolute link to them means a planned page. */
  readonly sourceHosts: readonly string[];
}

function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return normaliseLinkPath(new URL(url).pathname);
  } catch {
    return null;
  }
}

/**
 * Load the planned pages of every import run that is still active
 * (neither completed nor failed) for a chat on `chatBranchId`. Null when
 * there is none — the common case, and then nothing changes for the
 * write.
 */
export async function loadActiveImportTargets(
  tx: TransactionRunner,
  chatBranchId: string,
): Promise<ActiveImportTargets | null> {
  const runs = (await tx.execute(sql`
    SELECT r.id::text AS id, r.source_url
      FROM import_runs r
      JOIN chat_sessions cs ON cs.id = r.chat_session_id
     WHERE cs.chat_branch_id = ${chatBranchId}::uuid
       AND r.status NOT IN ('completed', 'failed')
  `)) as unknown as { id: string; source_url: string }[];
  if (runs.length === 0) return null;
  const pages = (await tx.execute(sql`
    SELECT run_id::text AS run_id, source_url, requested_url, proposed_slug
      FROM import_pages
     WHERE run_id IN (${sql.join(
       runs.map((r) => sql`${r.id}::uuid`),
       sql`, `,
     )})
       AND rejected_at IS NULL
  `)) as unknown as {
    run_id: string;
    source_url: string;
    requested_url: string | null;
    proposed_slug: string;
  }[];
  const runsByPath = new Map<string, string[]>();
  const add = (path: string | null, runId: string): void => {
    if (path === null) return;
    const list = runsByPath.get(path) ?? [];
    if (!list.includes(runId)) list.push(runId);
    runsByPath.set(path, list);
  };
  for (const p of pages) {
    add(pathOf(p.source_url), p.run_id);
    add(pathOf(p.requested_url), p.run_id);
    const slug = p.proposed_slug.trim().replace(/^\/+/, "");
    if (slug.length > 0) add(normaliseLinkPath(`/${slug}`), p.run_id);
  }
  const sourceHosts: string[] = [];
  for (const r of runs) {
    try {
      sourceHosts.push(new URL(r.source_url).host.toLowerCase());
    } catch {
      // An unparsable source URL only means its absolute links stay literal.
    }
  }
  return { runsByPath, sourceHosts };
}

/**
 * Record links a write kept literal because they point at a planned
 * page. A link seen again is re-marked pending (a later write may have
 * re-introduced a literal the finalisation had already converted).
 */
export async function recordPendingImportLinks(
  tx: TransactionRunner,
  targets: ActiveImportTargets,
  pending: readonly PendingLinkTarget[],
): Promise<void> {
  for (const p of pending) {
    for (const runId of targets.runsByPath.get(p.path) ?? []) {
      await tx.execute(sql`
        INSERT INTO import_run_links (run_id, value, status, source, location)
        VALUES (${runId}::uuid, ${p.value}, 'pending', 'build', ${p.where})
        ON CONFLICT (run_id, value) DO UPDATE SET
          status = 'pending', source = 'build', location = EXCLUDED.location, updated_at = now()
      `);
    }
  }
}
