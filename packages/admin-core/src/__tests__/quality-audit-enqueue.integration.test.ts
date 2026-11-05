// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1319 — a succeeded Stage always has its quality audit, and a
 * build that has none (staged before the fix) has a recovery keyed by its
 * run id. Real Postgres + real self-hosted builds.
 *
 * Before: the Stage queued the audit in a separate call after the build
 * was recorded; when that call was lost (pool exhaustion, an admin
 * timeout) the run was `succeeded` with no audit row, get_quality_audit
 * answered "is being queued" forever and Publish live stayed blocked.
 * Now deploy.start_trigger plans the audit row on the run before anything
 * is built (where a refusal is still harmless), and deploy.finish_trigger
 * writes exactly that row in the transaction that marks the run
 * succeeded: both commit, or neither, and the write cannot be refused
 * after the build is already visible on staging.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const OWNER_ID = crypto.randomUUID();
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "qe-1319" };
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "qe-1319" };
const AI: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "ai", requestId: "qe-1319" };
const PFX = "qe1319-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prevSkip: string | undefined;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLang: (() => Promise<void>) | null = null;
let homeId: string;

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
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home'`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM user_roles WHERE user_id = ${OWNER_ID}::uuid`;
    await tx`DELETE FROM users WHERE id = ${OWNER_ID}::uuid`;
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

interface AuditRow {
  status: string;
  chat_session_id: string | null;
  staged_by: string | null;
  target_page_ids: string[];
}

async function auditsOf(deployRunId: string): Promise<AuditRow[]> {
  return withSql(
    async (tx) =>
      (await tx`
        SELECT status, chat_session_id::text AS chat_session_id, staged_by,
               target_page_ids::text[] AS target_page_ids
        FROM quality_audit_runs WHERE deploy_run_id = ${deployRunId}::uuid`) as unknown as AuditRow[],
  );
}

/** The newest staging run of the suite (the one a failed build left too). */
async function lastStagingRun(): Promise<{ id: string; status: string; error_message: string }> {
  return withSql(async (tx) => {
    const rows = (await tx`
      SELECT r.id::text AS id, r.status, r.error_message
      FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE t.name = 'staging' ORDER BY r.started_at DESC LIMIT 1`) as unknown as {
      id: string;
      status: string;
      error_message: string;
    }[];
    const row = rows[0];
    if (!row) throw new Error("no staging run");
    return row;
  });
}

async function plannedAuditOf(runId: string): Promise<Record<string, unknown> | null> {
  return withSql(async (tx) => {
    const rows = (await tx`
      SELECT planned_audit FROM deploy_runs WHERE id = ${runId}::uuid`) as unknown as {
      planned_audit: Record<string, unknown> | null;
    }[];
    return rows[0]?.planned_audit ?? null;
  });
}

async function stagingRunCount(): Promise<number> {
  return withSql(async (tx) => {
    const rows = (await tx`
      SELECT count(*)::int AS n FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE t.name = 'staging'`) as unknown as { n: number }[];
    return rows[0]?.n ?? 0;
  });
}

async function stage(qualityAudit?: unknown): Promise<string> {
  const built = await op<{ runId: string }>(SYS, "deploy.trigger", {
    targetName: "staging",
    repoRoot: testRoot,
    ...(qualityAudit === undefined ? {} : { qualityAudit }),
  });
  return built.runId;
}

async function newChat(title: string): Promise<string> {
  return (
    await op<{ chatSessionId: string }>(OWNER, "chat.create_session", {
      isolation: "experiment",
      title: `${PFX}${title}`,
    })
  ).chatSessionId;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await wipe();
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 'qe owner')
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
  });
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLang = await pinSiteLanguage(ADMIN_URL as string, "en");
  testRoot = await mkdtemp(join(tmpdir(), "caelo-quality-enqueue-"));
  prevSkip = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";

  const { templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
    pageType: "home",
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
  await op(SYS, "pages_seo.autofill", { pageId: homeId, metaDescription: "Home of #1319." });
});

afterAll(async () => {
  if (prevSkip === undefined) delete process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  else process.env.CAELO_SKIP_STAGING_SERVE_CHECK = prevSkip;
  await wipe();
  await restoreBase?.();
  await restoreLang?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("a succeeded staging build always has its audit (#1319)", () => {
  it("a build outside a chat (Ops → Deploy, deploy_staging) queues its own audit", async () => {
    const runId = await stage();
    expect(await auditsOf(runId)).toEqual([
      { status: "queued", chat_session_id: null, staged_by: null, target_page_ids: [homeId] },
    ]);
  });

  it("a chat Stage's audit carries the chat and who staged it", async () => {
    const chatSessionId = await newChat("stage");
    const runId = await stage({
      chatSessionId,
      branch: {
        classification: { auditNeeded: false, reasons: [], skipped: ["field values: x"] },
        touchedPageIds: [homeId],
      },
      stagedBy: "live_edit_ai",
    });
    const [row] = await auditsOf(runId);
    expect(row).toMatchObject({
      status: "queued",
      chat_session_id: chatSessionId,
      staged_by: "live_edit_ai",
    });
  });

  it("an audit request that cannot be planned is refused before anything is built", async () => {
    const before = await stagingRunCount();
    const msg = await opErr(SYS, "deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
      qualityAudit: {
        chatSessionId: crypto.randomUUID(),
        branch: {
          classification: { auditNeeded: false, reasons: [], skipped: [] },
          touchedPageIds: [],
        },
      },
    });
    expect(msg).toContain("nothing was built");
    expect(await stagingRunCount()).toBe(before);
  });

  it("the audit is planned on the run before the build and only written when it succeeds", async () => {
    // The run's first step alone: the build would run next.
    const chatSessionId = await newChat("planned");
    const runId = crypto.randomUUID();
    const plan = await op<{ target: { id: string } }>(SYS, "deploy.start_trigger", {
      targetName: "staging",
      repoRoot: testRoot,
      runId,
      leaseTtlMs: 60_000,
      qualityAudit: {
        chatSessionId,
        branch: {
          classification: { auditNeeded: false, reasons: [], skipped: ["field values: x"] },
          touchedPageIds: [homeId],
        },
        stagedBy: "operator",
      },
    });
    expect(await plannedAuditOf(runId)).toMatchObject({
      chatSessionId,
      status: "queued",
      stagedBy: "operator",
    });
    expect(await auditsOf(runId)).toEqual([]);

    // The build is now visible on staging; the chat goes away meanwhile.
    // Recording the run still cannot fail on its audit row.
    await withSql((tx) => tx`DELETE FROM chat_sessions WHERE id = ${chatSessionId}::uuid`);
    // #1330 — a Stage holds the staging publish slot from before its upload.
    await op(SYS, "deploy.acquire_staging_publication", { runId, ttlMs: 60_000 });
    await op(SYS, "deploy.finish_trigger", {
      runId,
      targetId: plan.target.id,
      env: "staging",
      pageCount: 1,
      fileCount: 1,
      publishSummary: {},
      buildOrigin: "https://example.com",
      stagingLocation: "_slots/a",
      override: null,
      phaseTimings: [],
      qualityAudit: null,
      linkNotice: null,
    });
    expect(await plannedAuditOf(runId)).toBeNull();
    const written = await auditsOf(runId);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      status: "queued",
      chat_session_id: null,
      staged_by: "operator",
    });
  });

  it("a failed build drops its planned audit and has no audit row", async () => {
    const runId = crypto.randomUUID();
    await op(SYS, "deploy.start_trigger", {
      targetName: "staging",
      repoRoot: testRoot,
      runId,
      leaseTtlMs: 60_000,
    });
    expect(await plannedAuditOf(runId)).not.toBeNull();
    await op(SYS, "deploy.fail_run", { runId, message: "generator failed", phaseTimings: [] });
    expect(await plannedAuditOf(runId)).toBeNull();
    expect(await auditsOf(runId)).toEqual([]);

    // A real build that fails (its output root cannot be written) ends the
    // same way.
    await opErr(SYS, "deploy.trigger", {
      targetName: "staging",
      repoRoot: "/dev/null/caelo-cannot-write-here",
    });
    const run = await lastStagingRun();
    expect(run.status).toBe("failed");
    expect(await plannedAuditOf(run.id)).toBeNull();
    expect(await auditsOf(run.id)).toEqual([]);
  });

  it("only a staging build takes an audit request", async () => {
    const msg = await opErr(OWNER, "deploy.trigger", {
      targetName: "production",
      repoRoot: testRoot,
      qualityAudit: { chatSessionId: null, branch: null },
    });
    expect(msg).toContain("only staging builds are quality-audited");
  });
});

describe("a staged build without an audit is recovered by its run id (#1319)", () => {
  it("retry_quality_audit's op queues the check of the named, served build", async () => {
    const older = await stage();
    const runId = await stage();
    // An install's build staged before the fix, whose audit was lost.
    await withSql((tx) => tx`DELETE FROM quality_audit_runs WHERE deploy_run_id = ${runId}::uuid`);
    expect(
      (await op<{ gate: { state: string } }>(AI, "quality_audits.gate_status", {})).gate.state,
    ).toBe("missing");

    // An older build is no longer what Publish live would ship.
    expect(await opErr(AI, "quality_audits.retry", { deployRunId: older })).toContain(
      `call retry_quality_audit with deployRunId \\"${runId}\\"`,
    );
    expect(await opErr(AI, "quality_audits.retry", { deployRunId: crypto.randomUUID() })).toContain(
      "no build run",
    );

    const r = await op<{ status: string; deployRunId: string }>(AI, "quality_audits.retry", {
      deployRunId: runId,
    });
    expect(r).toMatchObject({ status: "queued", deployRunId: runId });
    expect((await auditsOf(runId)).map((a) => a.status)).toEqual(["queued"]);
    expect(
      (await op<{ gate: { state: string } }>(AI, "quality_audits.gate_status", {})).gate.state,
    ).toBe("running");
  });
});
