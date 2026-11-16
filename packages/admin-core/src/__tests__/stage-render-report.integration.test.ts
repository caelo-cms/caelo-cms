// SPDX-License-Identifier: MPL-2.0

/**
 * #1604 — a Stage never fails because of the site's content.
 *
 * Seen on viu.one (v0.12.6, 2026-11-12): modules written under an older
 * release show a link's text with `{{cta.label}}`, a path a link field does
 * not answer since #1504. The Stage stopped in the generator, and the AI
 * got no report to repair.
 *
 * End to end (real generator, real Postgres): the Stage succeeds, staging
 * shows the spot as the editor preview does, the run records it, the
 * Stage's audit reports it per page, and Publish live refuses the build
 * whatever the audit says — with a passed audit, and over a failed one
 * with publish anyway. A production build of the same content is refused.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { pageOutputPath } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import type { RenderReport } from "../deploy/render-failures.js";
import { setDeployBridge } from "../ops/deploy.js";
import { claimedRenderSources } from "../quality/audit-job.js";
import type { ClaimedAuditRun } from "../quality/audit-run.js";
import { createRenderCheck } from "../quality/checks/render.js";
import { registerAdminOps } from "../register.js";
import { stageChatSessions } from "../stage/stage-chats.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1604",
};
const OWNER_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t1604-owner" };
const PFX = "t1604";
const EXTERNAL = "https://app.example.org/trial";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prevSkipServeCheck: string | undefined;
let prevOutputRoot: string | undefined;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;
let homeId = "";
let moduleId = "";

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  await sqlSystem(async (tx) => {
    await tx.unsafe("DELETE FROM quality_audit_runs");
    await tx.unsafe("DELETE FROM deploy_runs");
    await tx.unsafe(`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages)`);
    await tx.unsafe(`DELETE FROM page_modules`);
    await tx.unsafe(`DELETE FROM pages`);
    await tx.unsafe(`DELETE FROM content_instances`);
    await tx.unsafe(`DELETE FROM modules WHERE slug LIKE '%${PFX}%'`);
    await tx.unsafe(
      `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${PFX}-%'`);
  });
}

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function openChat(title: string): Promise<string> {
  const chat = await execute(registry, adapter, OWNER, "chat.create_session", { title });
  if (!chat.ok) throw new Error(JSON.stringify(chat.error));
  return (chat.value as { chatSessionId: string }).chatSessionId;
}

/** Set the staged build's newest audit to `status` (no Lighthouse runs here). */
async function setAudit(runId: string, status: "passed" | "errored"): Promise<string> {
  return sqlSystem(async (tx) => {
    await tx`
      INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
      SELECT ${runId}::uuid, ${SYSTEM_ACTOR_ID}::uuid, ${status},
             '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now()
      WHERE NOT EXISTS (SELECT 1 FROM quality_audit_runs WHERE deploy_run_id = ${runId}::uuid)`;
    const rows = (await tx`
      UPDATE quality_audit_runs
         SET status = ${status}, gate_rules = 2, finished_at = now(),
             error_code = ${status === "errored" ? "worker-crashed" : null},
             error_message = ${status === "errored" ? "t1604" : null}
       WHERE deploy_run_id = ${runId}::uuid
      RETURNING id::text AS id`) as { id: string }[];
    return rows[0]?.id as string;
  });
}

const publishLive = (publishAnyway?: { auditRunId: string; reason: string }) =>
  execute(registry, adapter, OWNER, "deploy.promote", {
    fromTarget: "staging",
    toTarget: "production",
    repoRoot: testRoot,
    ...(publishAnyway ? { publishAnyway } : {}),
  });

beforeAll(async () => {
  await cleanup();
  restoreBase = await pinSiteBaseUrl(ADMIN_URL, "https://example.com");
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-t1604-"));
  prevSkipServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  prevOutputRoot = process.env.CAELO_OUTPUT_ROOT;
  process.env.CAELO_OUTPUT_ROOT = testRoot;
  await sqlSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 't1604 owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
  });

  const { layoutId } = await sysOp<{ layoutId: string }>("layouts.create", {
    slug: `${PFX}-layout`,
    displayName: "T1604 layout",
    html: '<body><caelo-slot name="content"></caelo-slot></body>',
    css: "",
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { templateId } = await sysOp<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "T1604",
    html: '<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
    css: "",
    layoutId,
  });
  await sysOp("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  homeId = (
    await sysOp<{ pageId: string }>("pages.build_page", {
      page: { slug: "home", title: "Start", templateId, status: "draft" },
      modules: [
        {
          blockName: "content",
          displayName: `${PFX} hero`,
          description: "A call to action.",
          kind: "hero",
          html: '<a class="cta" href="{{cta.href}}">Start your trial</a>',
          fields: [{ name: "cta", kind: "link", label: "CTA link" }],
          content: { source: "inline", values: { cta: { href: EXTERNAL } } },
        },
      ],
    })
  ).pageId;
  const placed = await sqlSystem(
    async (tx) =>
      (await tx`SELECT module_id::text AS id FROM page_modules WHERE page_id = ${homeId}::uuid`) as {
        id: string;
      }[],
  );
  moduleId = placed[0]?.id as string;
  // The write tools refuse a path a link field cannot answer since #1504; a
  // module stored by an older release still has one (viu.one's modules).
  await sqlSystem(
    (tx) =>
      tx`UPDATE modules SET html = '<a class="cta" href="{{cta.href}}">{{cta.label}}</a>' WHERE id = ${moduleId}::uuid`,
  );
  await sysOp("pages.set_status", { pageId: homeId, status: "published" });
  await sysOp("pages_seo.autofill", { pageId: homeId, metaDescription: "A test page." });
}, 60_000);

afterAll(async () => {
  if (prevSkipServeCheck === undefined) delete process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  else process.env.CAELO_SKIP_STAGING_SERVE_CHECK = prevSkipServeCheck;
  if (prevOutputRoot === undefined) delete process.env.CAELO_OUTPUT_ROOT;
  else process.env.CAELO_OUTPUT_ROOT = prevOutputRoot;
  await cleanup();
  await restoreBase?.();
  await restoreLanguage?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("#1604 — a Stage with content it cannot render", () => {
  let runId = "";
  let report: RenderReport | null = null;

  it("succeeds, ships the spot as the preview shows it and records it", async () => {
    const staged = await stageChatSessions({ registry, adapter }, OWNER, [
      await openChat("t1604 stage"),
    ]);
    if (!staged.ok) throw new Error(staged.error.message);
    runId = staged.value.runId;
    report = staged.value.renderReport;
    expect(report?.total).toBe(1);
    expect(report?.failures[0]).toMatchObject({
      pageId: homeId,
      reason: "field-path-unknown:cta.label",
      blockName: "content",
    });
    expect(report?.operatorText).toStartWith("Staged, but 1 spot could not be rendered");
    expect(report?.operatorText).toContain("the content of Start (/)");
    expect(report?.operatorText).not.toMatch(/field-path-unknown|update_modules_many|t1604-/);
    expect(report?.aiText).toContain("field-path-unknown:cta.label");
    expect(report?.aiText).toContain("update_modules_many");

    const target = await sqlSystem(
      async (tx) =>
        (await tx`SELECT out_dir FROM deploy_targets WHERE name = 'staging'`) as {
          out_dir: string;
        }[],
    );
    const html = await readFile(
      join(testRoot, target[0]?.out_dir ?? "", "builds", runId, pageOutputPath("/")),
      "utf8",
    );
    expect(html).toContain(`href="${EXTERNAL}"`);
    expect(html).toContain("{{cta.label}}");

    const stored = await sqlSystem(
      async (tx) =>
        (await tx`SELECT status, render_report FROM deploy_runs WHERE id = ${runId}::uuid`) as {
          status: string;
          render_report: RenderReport | null;
        }[],
    );
    expect(stored[0]?.status).toBe("succeeded");
    expect(stored[0]?.render_report?.operatorText).toBe(report?.operatorText as string);
  }, 120_000);

  it("its audit claims the recorded failures and reports them on the page", async () => {
    const queued = await sqlSystem(
      async (tx) =>
        (await tx`SELECT id::text AS id FROM quality_audit_runs
                  WHERE deploy_run_id = ${runId}::uuid AND status = 'queued'`) as { id: string }[],
    );
    const auditRunId = queued[0]?.id;
    if (!auditRunId) throw new Error("the Stage queued no audit");
    const claimed = await sysOp<{ state: string; run: ClaimedAuditRun | null }>(
      "quality_audits.claim",
      { auditRunId },
    );
    expect(claimed.state).toBe("claimed");
    const run = claimed.run as ClaimedAuditRun;
    expect(run.renderFailureCount).toBe(1);
    const findings = await createRenderCheck(claimedRenderSources(run)).run({
      pages: run.checkPages.map((p) => ({
        pageId: p.pageId,
        path: p.currentPath,
        url: `https://staging.example.test${p.currentPath}`,
        html: "",
      })),
      build: {
        baseUrl: "https://staging.example.test",
        probe: async () => ({ found: true, status: 200 }),
        text: async () => null,
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "render/field-path-unknown",
      severity: "error",
      pageId: homeId,
      fix: { tool: "update_modules_many" },
    });
  });

  it("Publish live refuses it with a passed audit, and publish anyway over a failed one", async () => {
    await setAudit(runId, "passed");
    const gate = await execute(registry, adapter, OWNER, "quality_audits.gate_status", {});
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    const view = (
      gate.value as {
        gate: { open: boolean; state: string; canPublishAnyway: boolean; renderReport: unknown };
      }
    ).gate;
    expect(view).toMatchObject({ open: false, state: "render", canPublishAnyway: false });
    expect(view.renderReport).not.toBeNull();

    const refused = await publishLive();
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      const message = (refused.error as { message: string }).message;
      expect(message).toContain("1 spot it could not render");
      expect(message).toContain("Stage again");
    }

    const auditRunId = await setAudit(runId, "errored");
    const anyway = await publishLive({ auditRunId, reason: "t1604 try anyway" });
    expect(anyway.ok).toBe(false);
    if (!anyway.ok) {
      expect((anyway.error as { message: string }).message).toContain(
        "publish anyway only applies to a FAILED quality check",
      );
    }
  });

  it("a production build of the same content is refused", async () => {
    const refused = await execute(registry, adapter, OWNER, "deploy.trigger", {
      targetName: "production",
      repoRoot: testRoot,
    });
    expect(refused.ok).toBe(false);
  }, 120_000);

  it("repaired and staged again, the gate no longer reads the old report", async () => {
    await sqlSystem(
      (tx) =>
        tx`UPDATE modules SET html = '<a class="cta" href="{{cta.href}}">Start your trial</a>' WHERE id = ${moduleId}::uuid`,
    );
    const staged = await stageChatSessions({ registry, adapter }, OWNER, [
      await openChat("t1604 repaired"),
    ]);
    if (!staged.ok) throw new Error(staged.error.message);
    expect(staged.value.renderReport).toBeNull();
    await setAudit(staged.value.runId, "passed");
    const gate = await execute(registry, adapter, OWNER, "quality_audits.gate_status", {});
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    expect((gate.value as { gate: { open: boolean; state: string } }).gate).toMatchObject({
      open: true,
      state: "clean",
    });
  }, 120_000);
});
