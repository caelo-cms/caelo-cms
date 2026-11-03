// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1390 — a draft overlay reads the draft head, never the branch's
 * pending history.
 *
 * The branch view of an entity is its newest pending snapshot, and the
 * draft head (`draft_pending_entities`, #1268) keeps exactly that row per
 * pending entity: `headOverlaySql` (admin-core `draft.ts`) reads it. A
 * read that instead joins `site_snapshots` on the pending predicate and
 * keeps the newest row with `DISTINCT ON` walks every pending snapshot of
 * the branch — on the shared draft every write of every chat since the
 * last Stage. On searchVIU production (2026-11-03) such reads, issued by a
 * plugin's change consumer after every agent write, starved the
 * db-f1-micro's CPU.
 *
 * This static scan fails on the pending predicate (`pendingSnapshotSql` or
 * a literal `staged_at IS NULL`) in source outside {@link ALLOWED}: the
 * files that need the pending history itself, not a branch view of it.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ROOTS = ["packages", "apps/admin/src"].map((r) => resolve(REPO_ROOT, r));

/** Files that read the pending history itself, and why each must. */
const ALLOWED: Record<string, string> = {
  "packages/admin-core/src/draft.ts":
    "defines the predicate and the head; the selection/undo helpers walk pending headers by design.",
  "packages/admin-core/src/ops/chat/publish.ts":
    "Stage/Publish merges every pending snapshot in its window and marks it staged.",
  "packages/admin-core/src/ops/chat/draft-ops.ts":
    "undo and discard act on pending headers, not on a branch view.",
  "packages/admin-core/src/ops/quality/classify_stage.ts":
    "classifies the pending headers a Stage contains.",
  "packages/admin-core/src/lock-takeover.ts":
    "a takeover moves an entity's pending snapshot rows to the new holder (FOR UPDATE on the rows).",
  "packages/admin-core/src/locks.ts":
    "the stale-change check compares one entity's pending writers by time.",
  "packages/admin-core/src/links/migrate-load.ts":
    "the link migration rewrites pending snapshots in place and keeps each row's writing task.",
  "packages/admin-core/src/ops/subagents/runs.ts":
    "GC keeps a subagent session while any pending header still names it (an existence check).",
};

function isSource(path: string): boolean {
  if (!path.endsWith(".ts") || path.endsWith(".d.ts")) return false;
  if (/\.(test|bench)\.ts$/.test(path) || /\/__tests__\//.test(path)) return false;
  return /\/src\//.test(path) || path.includes("/apps/admin/src/");
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "build" || name.startsWith(".")) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (isSource(path)) out.push(path);
  }
  return out;
}

const PENDING_PREDICATE = /pendingSnapshotSql\s*\(|staged_at\s+IS\s+NULL/i;

describe("#1390 — draft overlays read the head, not the pending history", () => {
  const files = ROOTS.flatMap((r) => sources(r)).map((p) => relative(REPO_ROOT, p));

  it("uses the pending predicate only where the history itself is read", () => {
    const offenders = files.filter(
      (f) => !(f in ALLOWED) && PENDING_PREDICATE.test(readFileSync(resolve(REPO_ROOT, f), "utf8")),
    );
    // Read the branch view through headOverlaySql (draft.ts) instead; add
    // a file to ALLOWED only when it needs the pending history itself.
    expect(offenders).toEqual([]);
  });

  it("keeps the allow-list current", () => {
    const stale = Object.keys(ALLOWED).filter(
      (f) =>
        !files.includes(f) || !PENDING_PREDICATE.test(readFileSync(resolve(REPO_ROOT, f), "utf8")),
    );
    expect(stale).toEqual([]);
  });
});
