// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1517 — a draft write never reaches the live site by accident.
 *
 * Redirects are live state: a write to the `redirects` table is pushed to
 * the hosting provider right after its commit (#1157), with no Stage and no
 * Publish live in between. So every code path that writes a redirect row,
 * runs a redirect op, or asks for the provider sync is an exact, reviewed
 * list here, each with the reason it may. A new caller (a content op that
 * grows a side effect, a plugin operation, a worker) fails this test until
 * someone decides it belongs, the same way
 * scripts/no-automatic-production-deploy.test.ts pins the production build.
 *
 * Page writes reach the table through one gateway, `applyPathMoveEffects`
 * (plus the dead-URL 301 of `pages.delete` and the approved URL migration),
 * and the gateway leaves out every page only a chat's branch holds
 * (`branchOnlyPageIds`): such a page was never served, so its moves must not
 * delete a live rule, write a 301 or repoint chains. The integration suite
 * (draft-no-live-writes.integration.test.ts) proves it end to end.
 *
 * Pure static scan over the workspace sources (tests, e2e suites and build
 * output excluded), in the style of no-automatic-production-deploy.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

const REDIRECT_OPS = "create|create_many|delete|delete_many|execute_proposal|sync_provider";

/** Every way a source can change the redirects table or push it live. */
const LIVE_REDIRECT_WRITE: readonly RegExp[] = [
  // SQL on the table itself.
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+redirects\b/i,
  // The provider push, and marking a target behind (which makes it push).
  /\b(requestRedirectSync|markRedirectsBehind)\s*\(/,
  // A redirect op's handler run on the caller's transaction.
  /\b(createRedirectOp|createRedirectsManyOp|deleteRedirectOp|deleteRedirectsManyOp)\.handler\b/,
  // A redirect op run through the Query API or a plugin's broker.
  new RegExp(`\\bexecute\\s*\\([^;]{0,400}?["'\`]redirects\\.(${REDIRECT_OPS})["'\`]`),
  new RegExp(`\\.call(?:<[^;]*?>)?\\s*\\(\\s*["'\`]redirects\\.(${REDIRECT_OPS})["'\`]`),
  // The page-move gateway and the Publish live take-over.
  /\b(applyPathMoveEffects|takeOverRedirectsOnFirstPublishedPages)\s*\(/,
];

/** Every source that may write live redirects, and why it may. */
const ALLOWED_WRITERS: Record<string, string> = {
  "packages/admin-core/src/ops/redirects.ts":
    "the redirects.* ops: writing a rule IS their purpose (routine, §11.A)",
  "packages/admin-core/src/ops/redirects_pending.ts":
    "redirects.execute_proposal: an external target the Owner approved",
  "packages/admin-core/src/deploy/redirect-sync.ts":
    "the sync model: requestRedirectSync / markRedirectsBehind and the push",
  "packages/admin-core/src/redirect-sync-worker.ts":
    "the post-commit runner and its retry: pushes what was saved",
  "apps/admin/src/routes/(authed)/settings/redirects/+page.server.ts":
    "Settings → Redirects: a human writing a rule or pressing Try again",
  "packages/admin-core/src/ai/tools/bulk-create-redirects.ts":
    "bulk_create_redirects: the AI writing a rule on purpose",
  "packages/admin-core/src/ai/tools/bulk-delete-redirects.ts":
    "bulk_delete_redirects: the AI deleting a rule on purpose",
  "packages/admin-core/src/ops/content/path-moves.ts":
    "the page-move gateway (main-line pages only, #1517) and the Publish live take-over",
  "packages/admin-core/src/ops/content/pages.ts":
    "pages.update slug change (through the gateway) and pages.delete's dead-URL 301 (never for a branch-only page)",
  "packages/admin-core/src/ops/content/current-path.ts":
    "pages.refresh_current_path and the merge's recompose, through the gateway",
  "packages/admin-core/src/ops/content/page-moves.ts":
    "move_pages on the main line, through the gateway",
  "packages/admin-core/src/ops/snapshots/revert_page.ts":
    "a page revert restores its URL, through the gateway",
  "packages/admin-core/src/ops/snapshots/revert_site.ts":
    "a site revert (approval-gated) restores URLs, through the gateway",
  "packages/admin-core/src/ops/content/url_migrations.ts":
    "an approved URL migration: the Owner's click moves live URLs with their 301s",
  "packages/admin-core/src/ops/deploy-trigger.ts":
    "a production build: first-published pages take their URL over; the build's own sync",
  "packages/admin-core/src/ops/deploy-promote.ts":
    "Publish live: first-published pages take their URL over; the release's own sync",
  "packages/admin-core/src/ops/deploy-rollback.ts":
    "rollback: the restored build gets the table pushed (no row written)",
  "packages/admin-core/src/plugin-data/build.ts":
    "the plugin-data build re-releases the live build and pushes the table (no row written)",
  "packages/plugins/international-site/src/index.ts":
    "set_locales (approval-gated): the /<default locale> → / root redirect",
};

/** The only sources that may run the page-move gateway (it filters drafts). */
const GATEWAY_CALLERS = [
  "packages/admin-core/src/ops/content/current-path.ts",
  "packages/admin-core/src/ops/content/page-moves.ts",
  "packages/admin-core/src/ops/content/pages.ts",
  "packages/admin-core/src/ops/content/path-moves.ts",
  "packages/admin-core/src/ops/snapshots/revert_page.ts",
  "packages/admin-core/src/ops/snapshots/revert_site.ts",
];

const SOURCE_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".svelte-kit",
  "__tests__",
  "e2e",
  "e2e-livedit",
]);

function isSource(file: string): boolean {
  if (!/\.(ts|svelte)$/.test(file) || file.endsWith(".d.ts")) return false;
  return !/\.(test|bench|browser)\.ts$/.test(file);
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (isSource(path)) out.push(path);
  }
  return out;
}

const ALL_SOURCES = SOURCE_ROOTS.flatMap((root) => sources(resolve(REPO_ROOT, root))).map(
  (path) => ({ path: relative(REPO_ROOT, path), text: readFileSync(path, "utf8") }),
);

const writes = (text: string) => LIVE_REDIRECT_WRITE.some((re) => re.test(text));

describe("no draft write reaches live redirects by accident (#1517)", () => {
  it("scans the real workspace", () => {
    expect(ALL_SOURCES.length).toBeGreaterThan(500);
    expect(ALL_SOURCES.some((s) => s.path === "packages/admin-core/src/ops/redirects.ts")).toBe(
      true,
    );
  });

  it("only the reviewed sources write redirect rows, run redirect ops or push the table", () => {
    const writers = ALL_SOURCES.filter((s) => writes(s.text))
      .map((s) => s.path)
      .sort();
    expect(writers).toEqual(Object.keys(ALLOWED_WRITERS).sort());
  });

  it("only the reviewed page ops run the page-move gateway", () => {
    const callers = ALL_SOURCES.filter((s) => /\bapplyPathMoveEffects\s*\(/.test(s.text))
      .map((s) => s.path)
      .sort();
    expect(callers).toEqual([...GATEWAY_CALLERS].sort());
  });

  it("the gateway leaves out pages only a chat's branch holds", () => {
    const gateway =
      ALL_SOURCES.find((s) => s.path === "packages/admin-core/src/ops/content/path-moves.ts")
        ?.text ?? "";
    const body = gateway.slice(gateway.indexOf("export async function applyPathMoveEffects"));
    expect(body).toMatch(/await mainLineMoves\(/);
    expect(gateway).toMatch(/chat_branch_id IS NOT NULL/);
  });

  it("would catch a new caller of every kind", () => {
    for (const text of [
      "await tx.execute(sql`DELETE FROM redirects WHERE from_path = ${p}`);",
      "await tx.execute(sql`insert into redirects (from_path) values (${p})`);",
      "await requestRedirectSync(tx, ctx);",
      "await createRedirectOp.handler(ctx, input, tx);",
      'await execute(registry, adapter, { actorId, actorKind: "system" }, "redirects.create_many", {});',
      'await cms.call<{ id: string }>("redirects.delete_many", { fromPaths });',
      "await applyPathMoveEffects(ctx, tx, moves, 'auto');",
    ]) {
      expect(writes(text)).toBe(true);
    }
    // Reads, op definitions and audit names are not writes.
    for (const text of [
      "SELECT from_path FROM redirects WHERE from_path = ANY(${paths})",
      'export const createRedirectOp = defineOperation({ name: "redirects.create",',
      'operation: "redirects.create_many",',
      'await execute(registry, adapter, ctx, "redirects.page_conflicts", lookup);',
    ]) {
      expect(writes(text)).toBe(false);
    }
  });
});
