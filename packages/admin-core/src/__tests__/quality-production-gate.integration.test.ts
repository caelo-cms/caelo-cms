// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 PR 3 — production builds that bypass deploy.promote obey the
 * quality gate, the automatic redeploy publishes only through it, and the
 * Owner's quality view operations (baselines, revoke) and the seeded
 * fix-quality-findings skill. Real Postgres + real self-hosted builds;
 * Lighthouse faked (see quality-gate.integration.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { setDeployBridge } from "../ops/deploy.js";
import { drainAuditQueue } from "../quality/audit-worker.js";
import type { AuditJob } from "../quality/lighthouse-protocol.js";
import type { AuditJobResult } from "../quality/lighthouse-runner.js";
import type { FailingAudit } from "../quality/ratchet.js";
import { localBuildSource } from "../quality/staged-origin.js";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const OWNER_ID = crypto.randomUUID();
const EDITOR_ID = crypto.randomUUID();
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "qp-553" };
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "qp-553" };
const EDITOR: ExecutionContext = { actorId: EDITOR_ID, actorKind: "human", requestId: "qp-553" };
const PFX = "qp553-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prev: Record<string, string | undefined> = {};
let restoreBase: (() => Promise<void>) | null = null;
let restoreLang: (() => Promise<void>) | null = null;
let homeId: string;
let draftPageId: string;
let cardModuleId: string;
let mainTemplateId: string;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    let out: T | undefined;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      out = await fn(tx as unknown as SQL);
    });
    return out as T;
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM quality_pending_actions`;
    await tx`DELETE FROM quality_acceptances`;
    await tx`DELETE FROM quality_baselines`;
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home'`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM user_roles WHERE user_id IN (${OWNER_ID}::uuid, ${EDITOR_ID}::uuid)`;
    await tx`DELETE FROM users WHERE id IN (${OWNER_ID}::uuid, ${EDITOR_ID}::uuid)`;
  });
}

async function seedUser(id: string, role: "owner" | "editor"): Promise<void> {
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${id}::uuid, 'human', ${`qp ${role}`})
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${id}::uuid, ${`${id}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${id}::uuid, id FROM roles WHERE name = ${role}`;
  });
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function opErr(ctx: ExecutionContext, name: string, input: unknown): Promise<string> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (r.ok) throw new Error(`${name} unexpectedly succeeded`);
  return JSON.stringify(r.error);
}

const imageAlt: FailingAudit = {
  id: "image-alt",
  title: "Image elements do not have [alt] attributes",
  score: 0,
  categories: ["accessibility"],
};

function fakeLighthouse(failing: FailingAudit[], accessibility = 100) {
  return async (job: AuditJob): Promise<AuditJobResult> => ({
    ok: true,
    pages: job.pages.map((p) => ({
      pageId: p.pageId,
      url: p.url,
      measurement: {
        scores: { performance: 100, accessibility, "best-practices": 100, seo: 100 },
        failingAudits: failing,
      },
      performanceRuns: [100, 100, 100],
    })),
    pageErrors: [],
  });
}

const failingLighthouse = async (): Promise<AuditJobResult> => ({
  ok: false,
  failure: { code: "timeout", message: "Lighthouse audit exceeded 210 s and was stopped" },
});

async function audit(runJob: (job: AuditJob) => Promise<AuditJobResult>): Promise<void> {
  await drainAuditQueue({
    adapter,
    registry,
    runJob,
    env: {
      provider: "aws",
      loopbackSource: (run) =>
        localBuildSource(join(testRoot, "output", "staging", "builds", run.deployRunId)),
    },
  });
}

/** Stage outside a chat (as Ops / the automatic redeploy do) + queue its check. */
async function stage(autoPublish = false): Promise<string> {
  const built = await op<{ runId: string }>(SYS, "deploy.trigger", {
    targetName: "staging",
    repoRoot: testRoot,
  });
  await op(SYS, "quality_audits.enqueue", {
    deployRunId: built.runId,
    chatSessionId: null,
    branch: null,
    autoPublish,
  });
  return built.runId;
}

async function buildProduction(
  ctx: ExecutionContext,
  publishAnyway?: { reason: string },
): Promise<{ ok: boolean; message: string }> {
  const r = await execute(registry, adapter, ctx, "deploy.trigger", {
    targetName: "production",
    repoRoot: testRoot,
    ...(publishAnyway ? { publishAnyway } : {}),
  });
  return { ok: r.ok, message: r.ok ? "" : JSON.stringify(r.error) };
}

async function lastProductionRun(): Promise<{ status: string; error_message: string | null }> {
  return withSql(async (tx) => {
    const rows = (await tx`
      SELECT r.status, r.error_message FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE t.name = 'production' ORDER BY r.started_at DESC LIMIT 1`) as unknown as {
      status: string;
      error_message: string | null;
    }[];
    const row = rows[0];
    if (!row) throw new Error("no production run");
    return row;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await wipe();
  await seedUser(OWNER_ID, "owner");
  await seedUser(EDITOR_ID, "editor");
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLang = await pinSiteLanguage(ADMIN_URL as string, "en");
  testRoot = await mkdtemp(join(tmpdir(), "caelo-quality-prod-"));
  prev = {
    CAELO_SKIP_STAGING_SERVE_CHECK: process.env.CAELO_SKIP_STAGING_SERVE_CHECK,
    CAELO_OUTPUT_ROOT: process.env.CAELO_OUTPUT_ROOT,
  };
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  process.env.CAELO_OUTPUT_ROOT = testRoot;

  const { templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
    slug: `${PFX}tpl`,
    displayName: "T",
    html: `<!doctype html><html lang="en"><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { moduleId } = await op<{ moduleId: string }>(SYS, "modules.create", {
    slug: `${PFX}card`,
    displayName: "Card",
    html: "<p>v0</p>",
  });
  cardModuleId = moduleId;
  mainTemplateId = templateId;
  homeId = (
    await op<{ pageId: string }>(SYS, "pages.create", {
      slug: "home",
      title: "Home",
      templateId,
      status: "published",
    })
  ).pageId;
  await op(SYS, "pages.set_modules", {
    pageId: homeId,
    blocks: [{ blockName: "content", moduleIds: [moduleId] }],
  });
  // A draft that exists before any Stage; publishing it later is a new
  // page going live although it arrives through pages.update.
  draftPageId = (
    await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}draft`,
      title: "Draft",
      templateId,
      status: "draft",
    })
  ).pageId;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await wipe();
  await restoreBase?.();
  await restoreLang?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("direct production builds obey the quality gate", () => {
  it("nothing staged yet: refused with the next step, recorded as a failed run", async () => {
    const r = await buildProduction(OWNER);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Stage first");
    const run = await lastProductionRun();
    expect(run.status).toBe("failed");
    expect(run.error_message).toContain("Blocked by the quality gate");
  });

  it("a check still running or with problems: refused, publish anyway does not apply", async () => {
    await stage();
    expect((await buildProduction(OWNER)).message).toContain(
      "quality check of the staged build finishes",
    );
    await audit(fakeLighthouse([imageAlt]));
    const r = await buildProduction(OWNER, { reason: "ship it" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("image-alt");
  });

  it("a FAILED check: only a human with deploy.trigger may build, with a recorded reason", async () => {
    await stage();
    await audit(failingLighthouse);
    expect((await buildProduction(OWNER)).message).toContain("publish anyway");
    // The built-in editor role cannot deploy.
    expect((await buildProduction(EDITOR, { reason: "please" })).message).toContain(
      "deploy.trigger",
    );
    expect((await buildProduction(SYS, { reason: "worker" })).message).toContain("human decision");

    // A build that fails after the override was allowed records nothing:
    // the gate stays closed for the next attempt.
    const broken = await execute(registry, adapter, OWNER, "deploy.trigger", {
      targetName: "production",
      repoRoot: "/dev/null/caelo-cannot-write-here",
      publishAnyway: { reason: "first try" },
    });
    expect(broken.ok).toBe(false);
    expect(
      (await op<{ gate: { state: string } }>(SYS, "quality_audits.gate_status", {})).gate.state,
    ).toBe("errored");

    const ok = await buildProduction(OWNER, { reason: "checker down, launch today" });
    expect(ok).toEqual({ ok: true, message: "" });
    expect(existsSync(join(testRoot, "output", "production", "current", "index.html"))).toBe(true);
    const gate = await op<{ gate: { state: string; auditRunId: string } }>(
      SYS,
      "quality_audits.gate_status",
      {},
    );
    expect(gate.gate.state).toBe("overridden");
    const overrides = await op<{ runs: { publishOverride: { by: string; reason: string } }[] }>(
      SYS,
      "quality_audits.list",
      { publishOverrideOnly: true },
    );
    expect(overrides.runs[0]?.publishOverride).toMatchObject({
      by: OWNER_ID,
      reason: "checker down, launch today",
    });
  });

  it("an open gate builds production as before", async () => {
    await stage();
    await audit(fakeLighthouse([]));
    expect(await buildProduction(OWNER)).toEqual({ ok: true, message: "" });
  });

  it("rendering changed on main since the checked Stage: refused until it is staged again", async () => {
    await op(SYS, "modules.update", { moduleId: cardModuleId, html: "<p>v1</p>" });
    const r = await buildProduction(OWNER);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("module code: Card");
    expect(r.message).toContain("Stage again");
    await stage();
    await audit(fakeLighthouse([]));
    expect(await buildProduction(OWNER)).toEqual({ ok: true, message: "" });
  });
});

describe("the automatic redeploy publishes only through the gate", () => {
  const plan = (changedPageIds: string[] = []) =>
    op<{ auditNeeded: boolean; reasons: string[]; pageIds: string[] }>(
      SYS,
      "quality_audits.plan_auto_redeploy",
      { changedPageIds },
    );

  it("content-only changes since the checked Stage rebuild production directly", async () => {
    await op(SYS, "pages.update", { pageId: homeId, title: "Home, renamed" });
    expect(await plan([homeId])).toEqual({ auditNeeded: false, reasons: [], pageIds: [homeId] });
  });

  it("module code changes go through a Stage that audits the pages placing the module", async () => {
    await op(SYS, "modules.update", { moduleId: cardModuleId, html: "<p>v2</p>" });
    const p = await plan();
    expect(p.auditNeeded).toBe(true);
    expect(p.reasons).toEqual(["module code: Card"]);
    expect(p.pageIds).toEqual([homeId]);
    await stage();
    await audit(fakeLighthouse([]));
  });

  it("a draft published through pages.update is a new page going live", async () => {
    await op(SYS, "pages.update", { pageId: draftPageId, status: "published" });
    const p = await plan();
    expect(p.auditNeeded).toBe(true);
    expect(p.reasons).toHaveLength(1);
    expect(p.reasons[0]).toStartWith("new page:");
    expect(p.pageIds).toEqual([draftPageId]);
    await op(SYS, "pages.update", { pageId: draftPageId, status: "draft" });
    expect((await plan()).auditNeeded).toBe(false);
  });

  it("a live page moved to another template is audited", async () => {
    const { templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
      slug: `${PFX}tpl2`,
      displayName: "T2",
      html: `<!doctype html><html lang="en"><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
    });
    await op(SYS, "pages.update", { pageId: homeId, templateId });
    const p = await plan();
    expect(p.auditNeeded).toBe(true);
    expect(p.reasons.some((r) => r.startsWith("template:"))).toBe(true);
    expect(p.pageIds).toContain(homeId);
    await op(SYS, "pages.update", { pageId: homeId, templateId: mainTemplateId });
    await stage();
    await audit(fakeLighthouse([]));
  });

  it("a clean audit of an automatic Stage publishes exactly that build", async () => {
    const staged = await stage(true);
    await audit(fakeLighthouse([]));
    const runs = await op<{ runs: { autoPublish: { outcome: string } | null }[] }>(
      SYS,
      "quality_audits.list",
      { limit: 1 },
    );
    expect(runs.runs[0]?.autoPublish).toEqual({ outcome: "published", message: null });
    expect((await lastProductionRun()).status).toBe("succeeded");
    // Promote refuses a build that is no longer the newest Stage.
    await stage();
    expect(
      await opErr(OWNER, "deploy.promote", {
        fromTarget: "staging",
        toTarget: "production",
        repoRoot: testRoot,
        expectedSourceRunId: staged,
      }),
    ).toContain("a newer build was staged");
    await audit(fakeLighthouse([]));
  });

  it("problems stop it — recorded on the audit and as a failed production run", async () => {
    await stage(true);
    await audit(fakeLighthouse([imageAlt]));
    const runs = await op<{ runs: { autoPublish: { outcome: string; message: string } | null }[] }>(
      SYS,
      "quality_audits.list",
      { limit: 1 },
    );
    expect(runs.runs[0]?.autoPublish?.outcome).toBe("blocked");
    expect(runs.runs[0]?.autoPublish?.message).toContain("image-alt");
    const run = await lastProductionRun();
    expect(run).toMatchObject({ status: "failed" });
    expect(run.error_message).toContain("Automatic publish stopped by the quality gate");
  });

  it("an automatic audit interrupted by a restart is settled too", async () => {
    await stage(true);
    // The process that claimed it died: still `running` long after.
    await withSql(async (tx) => {
      await tx`UPDATE quality_audit_runs SET status = 'running', started_at = now() - interval '2 hours'
               WHERE status = 'queued'`;
    });
    await audit(fakeLighthouse([]));
    const runs = await op<{
      runs: { status: string; autoPublish: { outcome: string; message: string } | null }[];
    }>(SYS, "quality_audits.list", { limit: 1 });
    expect(runs.runs[0]?.status).toBe("errored");
    expect(runs.runs[0]?.autoPublish?.outcome).toBe("blocked");
    expect((await lastProductionRun()).error_message).toContain(
      "Automatic publish stopped by the quality gate",
    );
  });

  it("an automatic Stage cannot carry a chat", async () => {
    expect(
      await opErr(SYS, "quality_audits.enqueue", {
        deployRunId: crypto.randomUUID(),
        chatSessionId: crypto.randomUUID(),
        branch: {
          classification: { auditNeeded: true, reasons: [], skipped: [] },
          touchedPageIds: [],
        },
        autoPublish: true,
      }),
    ).toContain("ValidationFailed");
  });
});

describe("the quality view: baselines and Owner revoke", () => {
  it("lists baselines below 100 and lets only the Owner revoke an acceptance", async () => {
    // Accept the current problems (an editor's in-chat card).
    const auditRunId = (
      await op<{ gate: { auditRunId: string } }>(SYS, "quality_audits.gate_status", {})
    ).gate.auditRunId;
    await stage();
    await audit(fakeLighthouse([imageAlt], 90));
    const current = (
      await op<{ gate: { auditRunId: string } }>(SYS, "quality_audits.gate_status", {})
    ).gate.auditRunId;
    expect(current).not.toBe(auditRunId);
    const proposal = await op<{ proposalId: string }>(
      { ...SYS, actorKind: "ai" },
      "quality_audits.propose_accept",
      {
        auditRunId: current,
        items: [
          { pagePath: "/", auditId: "image-alt" },
          { pagePath: "/", category: "accessibility" },
        ],
        reason: "decorative hero image",
      },
    );
    await op(EDITOR, "quality_audits.execute_proposal", { proposalId: proposal.proposalId });

    const below = await op<{
      baselines: { pagePath: string; category: string; baseline: number }[];
    }>(SYS, "quality_baselines.list", { belowTargetOnly: true });
    expect(below.baselines).toEqual([
      expect.objectContaining({ pagePath: "/", category: "accessibility", baseline: 90 }),
    ]);

    const acceptances = await op<{ acceptances: { id: string; kind: string }[] }>(
      SYS,
      "quality_acceptances.list",
      {},
    );
    const score = acceptances.acceptances.find((a) => a.kind === "score");
    if (!score) throw new Error("no score acceptance");
    expect(await opErr(EDITOR, "quality_acceptances.revoke", { acceptanceId: score.id })).toContain(
      "Owner decision",
    );
    expect(
      await opErr({ ...SYS, actorKind: "ai" }, "quality_acceptances.revoke", {
        acceptanceId: score.id,
      }),
    ).toContain("ActorScopeRejected");
    expect(
      await op(OWNER, "quality_acceptances.revoke", { acceptanceId: score.id, reason: "fix it" }),
    ).toEqual({ revoked: true });
    // The page is measured against 100 again and the drop blocks again.
    const after = await op<{ baselines: unknown[] }>(SYS, "quality_baselines.list", {
      belowTargetOnly: true,
    });
    expect(after.baselines).toEqual([]);
    const gate = await op<{ gate: { open: boolean; message: string } }>(
      SYS,
      "quality_audits.gate_status",
      {},
    );
    expect(gate.gate.open).toBe(false);
    expect(gate.gate.message).toContain("accessibility 90 < 100");
    expect(await opErr(OWNER, "quality_acceptances.revoke", { acceptanceId: score.id })).toContain(
      "already revoked",
    );
  });
});

describe("the fix-quality-findings skill", () => {
  it("is seeded active and only names tools that exist", async () => {
    const rows = await withSql(
      async (tx) =>
        (await tx`SELECT status, allowlisted_tools, activated_at FROM skills WHERE slug = 'fix-quality-findings'`) as unknown as {
          status: string;
          activated_at: Date | string | null;
          allowlisted_tools: string[] | string;
        }[],
    );
    const skill = rows[0];
    expect(skill?.status).toBe("active");
    // 0213: an active skill records when it became available.
    expect(skill?.activated_at).not.toBeNull();
    const tools =
      typeof skill?.allowlisted_tools === "string"
        ? (JSON.parse(skill.allowlisted_tools) as string[])
        : (skill?.allowlisted_tools ?? []);
    const live = new Set(
      createDefaultToolRegistry()
        .catalogue()
        .map((t) => t.name),
    );
    expect(tools.filter((t) => !live.has(t))).toEqual([]);
    expect(tools).toContain("get_quality_audit");
  });
});
