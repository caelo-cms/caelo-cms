// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1154 — one path to live. Nothing reaches production except through
 * a human Publish live (or an Owner-initiated production build). Two guards
 * hold that:
 *
 * - the ops: `deploy.trigger` / `deploy.promote` refuse every non-human
 *   production request (covered by deploy.integration.test.ts);
 * - this test: the code that may start a build or a publish at all is an
 *   exact, reviewed list. Every entry is a human's request (a form action, an
 *   approved proposal applied as its approver, a publish-anyway decision) or
 *   builds staging only. A new caller — a background worker, a scheduler
 *   tick, a plugin hook — fails here until someone decides it belongs, and
 *   the op-level refusal still stops it from building production.
 *
 * And the automatic redeploy's trigger does not come back: no admin source
 * polls `audit_events` on a timer.
 *
 * Pure static scan over the workspace sources (tests, e2e suites and build
 * output excluded), in the style of scripts/codeql-workflow.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * A call that starts a build or a publish: the op name followed by its input
 * object (`execute(…, "deploy.trigger", { … })`), or the op's handler run
 * directly. A bare "deploy.trigger" is also a permission name, so the string
 * alone does not count.
 */
const DEPLOY_CALL =
  /["'`]deploy\.(trigger|promote)["'`]\s*,\s*\{|\b(triggerDeployOp|promoteDeployOp)\.handler\b/;

/** Every source that may start a build or a publish, and why it may. */
const ALLOWED_CALLERS: Record<string, string> = {
  "apps/admin/src/routes/(authed)/settings/deployments/+page.server.ts":
    "Settings → Deployments form actions: the Owner's own production build / promote",
  "apps/admin/src/routes/(authed)/content/pages/+page.server.ts":
    "the pages list's Stage / Publish live buttons (a human request)",
  "apps/admin/src/routes/(authed)/edit/+page.server.ts":
    "the editor toolbar's Stage / Publish live (a human request)",
  "packages/admin-core/src/ops/deploy_pending.ts":
    "deploy.execute_proposal: an approved propose_deploy_promote, applied as the approving human",
  "packages/admin-core/src/ops/quality/gate.ts":
    "quality_audits.publish_anyway: a human's recorded decision to publish over a failed check",
  "packages/admin-core/src/stage/stage-chats.ts": "the Stage flow: builds staging only",
  "packages/admin-core/src/ai/tools/deploy-staging.ts":
    "the AI's deploy_staging tool: staging only (refuses production before calling)",
};

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

describe("no automatic caller starts a production build (#1154)", () => {
  it("scans the real workspace", () => {
    // A walker that silently stopped would pass vacuously.
    expect(ALL_SOURCES.length).toBeGreaterThan(500);
    expect(ALL_SOURCES.some((s) => s.path === "packages/admin-core/src/ops/deploy.ts")).toBe(true);
  });

  it("only the reviewed, human-driven or staging-only sources start a build or a publish", () => {
    const callers = ALL_SOURCES.filter(
      (s) => s.path !== "packages/admin-core/src/ops/deploy.ts" && DEPLOY_CALL.test(s.text),
    )
      .map((s) => s.path)
      .sort();
    expect(callers).toEqual(Object.keys(ALLOWED_CALLERS).sort());
  });

  it("would catch a worker that builds production", () => {
    const worker = `setInterval(() => execute(registry, adapter, SYSTEM, "deploy.trigger", { targetName: "production" }), 1000);`;
    expect(DEPLOY_CALL.test(worker)).toBe(true);
    expect(DEPLOY_CALL.test(`await promoteDeployOp.handler(ctx, input, tx);`)).toBe(true);
    // Permission checks name the same string and are not calls.
    expect(DEPLOY_CALL.test(`requirePermission(locals, "deploy.trigger");`)).toBe(false);
  });

  it("no background worker the admin starts calls the deploy ops", () => {
    const hooks = ALL_SOURCES.find((s) => s.path === "apps/admin/src/hooks.server.ts");
    expect(hooks).toBeDefined();
    expect(DEPLOY_CALL.test(hooks?.text ?? "")).toBe(false);
    const workers = ALL_SOURCES.filter((s) => /setInterval\s*\(/.test(s.text));
    expect(workers.length).toBeGreaterThan(5);
    const deploying = workers.filter((s) => DEPLOY_CALL.test(s.text)).map((s) => s.path);
    expect(deploying).toEqual([]);
  });

  it("no source polls audit_events on a timer (the automatic redeploy's trigger)", () => {
    const polling = ALL_SOURCES.filter(
      (s) => /setInterval\s*\(/.test(s.text) && /\bFROM\s+audit_events\b/i.test(s.text),
    ).map((s) => s.path);
    expect(polling).toEqual([]);
  });

  it("the redeploy orchestrator package is gone", () => {
    expect(ALL_SOURCES.some((s) => s.path.startsWith("packages/redeploy-orchestrator/"))).toBe(
      false,
    );
  });
});
