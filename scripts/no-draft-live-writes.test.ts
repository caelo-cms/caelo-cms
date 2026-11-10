// SPDX-License-Identifier: MPL-2.0

/**
 * Issues #1517, #1550 — a draft write never reaches the live site.
 *
 * Redirects are draft state (#1550). A save — a rule in Settings →
 * Redirects, an AI tool, a page rename, move or delete, a URL migration, a
 * revert, a plugin — writes a pending change (`pending_redirects`, Draft or
 * Staged) through one writer, `writeRedirectChanges`, and leaves the live
 * table `redirects` alone. The live table changes in exactly four ways:
 *
 * - Publish live (`deploy.promote`) and an Owner's production build
 *   (`deploy.trigger`) release the Staged changes the build serves;
 * - Go live now (`redirects.go_live_now`), a human's click with the Publish
 *   live permission, or the approval of the AI's card for it;
 * - a rollback restores what the rolled-back releases replaced;
 * - the first Publish live of a page takes over a live rule on its URL.
 *
 * Each of those is one function in `redirects/release.ts`, the only source
 * that writes the live table, and this test pins who calls them. The push to
 * the hosting (`markRedirectsBehind`, `syncRedirects`) carries only the live
 * table, so it is pinned too but reviewed for "pushes what is live", not for
 * "decides what goes live". A new caller of any of it — a content op that
 * grows a side effect, a plugin operation, a worker, the scheduler tick —
 * fails here until someone decides it belongs, the same way
 * scripts/no-automatic-production-deploy.test.ts pins the production build
 * and Go live now's callers.
 *
 * Pure static scan over the workspace sources (tests, e2e suites and build
 * output excluded). The integration suites prove the behaviour end to end
 * (redirects-draft-state, redirects-publish-live, draft-no-live-writes).
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

const RELEASE = "packages/admin-core/src/redirects/release.ts";
const WRITER = "packages/admin-core/src/redirects/write.ts";

/** SQL that writes the live redirects table. */
const LIVE_TABLE_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+redirects\b/i;

/** The four live writers, all defined in redirects/release.ts. */
const LIVE_RELEASE_CALL =
  /\b(releaseRedirectChanges|takeOverRedirectsOnFirstPublishedPages|rollBackRedirectReleases)\s*\(/;

/** Every source that runs a live writer, and why it may. */
const LIVE_WRITERS: Record<string, string> = {
  [RELEASE]: "defines the release, the first-publish take-over and the rollback",
  "packages/admin-core/src/ops/deploy-promote.ts":
    "Publish live: releases the Staged changes it confirmed; first-published pages take their URL over",
  "packages/admin-core/src/ops/deploy-trigger.ts":
    "an Owner's production build: releases the Staged changes it serves; the take-over",
  "packages/admin-core/src/ops/deploy-rollback.ts":
    "a rollback: restores what the rolled-back releases replaced and re-stages their changes",
  "packages/admin-core/src/ops/redirects_release.ts":
    "Go live now: a human with the Publish live permission, or the approval of the AI's card",
};

/** Pushing the live table to the hosting (never a pending change). */
const PUSH_CALL = /\b(markRedirectsBehind|syncRedirects)\s*\(/;

/** Every source that pushes the live table, and why it may. */
const PUSHERS: Record<string, string> = {
  "packages/admin-core/src/deploy/redirect-sync.ts": "the sync model and the push itself",
  "packages/admin-core/src/redirect-sync-worker.ts":
    "the scheduler tick's retry of a failed push: the live table as it is",
  "packages/admin-core/src/ops/redirect_sync.ts": "Try again now: the live table as it is",
  "packages/admin-core/src/ops/deploy-promote.ts": "Publish live's own push",
  "packages/admin-core/src/ops/deploy-trigger.ts": "a production build's own push",
  "packages/admin-core/src/ops/deploy-rollback.ts": "the rolled-back build's push",
  "packages/admin-core/src/ops/redirects_release.ts": "Go live now's push",
  "packages/admin-core/src/plugin-data/build.ts":
    "the plugin-data build re-releases the live build and pushes the live table (no change applied)",
  "packages/admin-core/src/deploy/static-publisher.ts": "the publisher interface",
  "packages/admin-core/src/deploy/static-publisher-self-hosted.ts": "the provider push",
  "packages/admin-core/src/deploy/static-publisher-gcs.ts": "the provider push",
  "packages/admin-core/src/deploy/static-publisher-firebase.ts": "the provider push",
  "packages/admin-core/src/deploy/static-publisher-aws.ts": "the provider push (not implemented)",
  "packages/admin-core/src/deploy/static-publisher-azure.ts": "the provider push (not implemented)",
};

/**
 * The one writer of pending changes (and the page move's in-place
 * retarget, which keeps a change's state), and who saves through it.
 */
const PENDING_WRITE_CALL = /\b(writeRedirectChanges|retargetPendingRedirects)\s*\(/;

const PENDING_WRITERS: Record<string, string> = {
  [WRITER]: "defines the writer",
  "packages/admin-core/src/ops/redirects.ts":
    "the redirects.* ops: a rule saved on purpose (Draft or Staged; a plugin's always Staged)",
  "packages/admin-core/src/ops/redirects_pending.ts": "an approved external target, saved Staged",
  "packages/admin-core/src/ops/content/path-moves.ts":
    "the page-move gateway: a rename, move or revert stages its 301s",
  "packages/admin-core/src/ops/content/pages.ts": "pages.delete's dead-URL 301, Staged",
  "packages/admin-core/src/ops/content/url_migrations.ts": "an approved URL migration, Staged",
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

const matching = (re: RegExp) =>
  ALL_SOURCES.filter((s) => re.test(s.text))
    .map((s) => s.path)
    .sort();

const textOf = (path: string) => ALL_SOURCES.find((s) => s.path === path)?.text ?? "";

describe("no draft write reaches the live redirects (#1517, #1550)", () => {
  it("scans the real workspace", () => {
    expect(ALL_SOURCES.length).toBeGreaterThan(500);
    expect(ALL_SOURCES.some((s) => s.path === RELEASE)).toBe(true);
  });

  it("only redirects/release.ts writes the live table", () => {
    expect(matching(LIVE_TABLE_WRITE)).toEqual([RELEASE]);
  });

  it("only Publish live, a production build, a rollback and Go live now run the live writers", () => {
    expect(matching(LIVE_RELEASE_CALL)).toEqual(Object.keys(LIVE_WRITERS).sort());
  });

  it("the release applies Staged changes only, and only the confirmed revision", () => {
    const release = textOf(RELEASE);
    const body = release.slice(release.indexOf("export async function releaseRedirectChanges"));
    // Locked by id AND revision AND state: a change saved again after the
    // confirmation, or moved back to Draft, is not released.
    expect(body).toMatch(/l\.revision = p\.revision/);
    expect(body).toMatch(/p\.state = ANY/);
  });

  it("only the reviewed sources push the live table", () => {
    expect(matching(PUSH_CALL)).toEqual(Object.keys(PUSHERS).sort());
  });

  it("every save goes through the one pending writer", () => {
    expect(matching(PENDING_WRITE_CALL)).toEqual(Object.keys(PENDING_WRITERS).sort());
    // An automatic change (a page's) is always Staged: the writer refuses
    // anything else, so a page change cannot sit in Draft and miss its
    // Publish live.
    expect(textOf(WRITER)).toMatch(/opts\.origin !== "manual" && opts\.state !== "staged"/);
  });

  it("only the reviewed page ops run the page-move gateway", () => {
    expect(matching(/\bapplyPathMoveEffects\s*\(/)).toEqual([...GATEWAY_CALLERS].sort());
  });

  it("the gateway leaves out pages only a chat's branch holds and stages what it writes", () => {
    const gateway = textOf("packages/admin-core/src/ops/content/path-moves.ts");
    const body = gateway.slice(gateway.indexOf("export async function applyPathMoveEffects"));
    expect(body).toMatch(/await mainLineMoves\(/);
    expect(body).toMatch(/state: "staged"/);
    expect(gateway).toMatch(/chat_branch_id IS NOT NULL/);
  });

  it("would catch a new caller of every kind", () => {
    for (const [re, text] of [
      [LIVE_TABLE_WRITE, "await tx.execute(sql`DELETE FROM redirects WHERE from_path = ${p}`);"],
      [LIVE_TABLE_WRITE, "await tx.execute(sql`insert into redirects (from_path) values (${p})`);"],
      [LIVE_RELEASE_CALL, "await releaseRedirectChanges(tx, actor, refs, release, ['staged']);"],
      [LIVE_RELEASE_CALL, "await rollBackRedirectReleases(tx, ctx, args);"],
      [PUSH_CALL, "await markRedirectsBehind(tx);"],
      [PENDING_WRITE_CALL, "await writeRedirectChanges(tx, changes, opts);"],
      [PENDING_WRITE_CALL, "await retargetPendingRedirects(tx, retargets);"],
    ] as const) {
      expect(re.test(text)).toBe(true);
    }
    // Reads and the pending table are not live writes.
    for (const text of [
      "SELECT from_path FROM redirects WHERE from_path = ANY(${paths})",
      "DELETE FROM pending_redirects WHERE id = ${id}::uuid",
      "UPDATE redirect_pending_actions SET status = 'applied'",
      "INSERT INTO redirect_release_log (kind) VALUES ('release')",
    ]) {
      expect(LIVE_TABLE_WRITE.test(text)).toBe(false);
    }
  });
});
