// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the automatic redeploy picks its path through the quality
 * gate: when main still renders what the last checked Stage saw, only
 * content changed and production is rebuilt directly (still subject to
 * deploy.trigger's production gate); otherwise it Stages and queues an
 * automatic-publish quality check of the touched pages instead of
 * shipping unchecked. The
 * audit → publish half lives in admin-core's
 * quality-production-gate.integration.test.ts. Real Postgres + real
 * self-hosted builds into a tmpdir.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AI_STAGE_LOCK_KEY,
  registerAdminOps,
  setDeployBridge,
  stageChatSessions,
} from "@caelo-cms/admin-core";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { redeployThroughQualityGate } from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue553-redeploy",
};
const PFX = "qr553-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prevOutputRoot: string | undefined;
let prevServeCheck: string | undefined;
let prevBase: string | null = null;
let prevLang: string | null = null;
let homeId: string;
let cardModuleId: string;

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
    await tx`DELETE FROM ai_stage_holds`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home'`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
  });
}

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function runsByTarget(): Promise<{ target: string; status: string; error: string | null }[]> {
  return withSql(
    async (tx) =>
      (await tx`
        SELECT t.name AS target, r.status, r.error_message AS error
        FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
        ORDER BY r.started_at`) as unknown as {
        target: string;
        status: string;
        error: string | null;
      }[],
  );
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await wipe();
  testRoot = await mkdtemp(join(tmpdir(), "caelo-quality-redeploy-"));
  prevOutputRoot = process.env.CAELO_OUTPUT_ROOT;
  prevServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_OUTPUT_ROOT = testRoot;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  await withSql(async (tx) => {
    const rows =
      (await tx`SELECT site_base_url, site_language FROM site_defaults WHERE id = 1`) as unknown as {
        site_base_url: string | null;
        site_language: string | null;
      }[];
    prevBase = rows[0]?.site_base_url ?? null;
    prevLang = rows[0]?.site_language ?? null;
    await tx`UPDATE site_defaults SET site_base_url = 'https://example.com', site_language = 'en' WHERE id = 1`;
  });

  const { templateId } = await op<{ templateId: string }>("templates.create", {
    slug: `${PFX}tpl`,
    displayName: "T",
    html: `<!doctype html><html lang="en"><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  await op("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { moduleId } = await op<{ moduleId: string }>("modules.create", {
    slug: `${PFX}card`,
    displayName: "Card",
    html: "<p>v0</p>",
  });
  cardModuleId = moduleId;
  const { pageId } = await op<{ pageId: string }>("pages.create", {
    slug: "home",
    title: "Home",
    templateId,
    status: "published",
  });
  homeId = pageId;
  await op("pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [moduleId] }],
  });
});

afterAll(async () => {
  if (prevOutputRoot === undefined) delete process.env.CAELO_OUTPUT_ROOT;
  else process.env.CAELO_OUTPUT_ROOT = prevOutputRoot;
  if (prevServeCheck === undefined) delete process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  else process.env.CAELO_SKIP_STAGING_SERVE_CHECK = prevServeCheck;
  await wipe();
  await withSql(async (tx) => {
    await tx`UPDATE site_defaults SET site_base_url = ${prevBase}, site_language = ${prevLang} WHERE id = 1`;
  });
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

async function auditRun(id: string): Promise<{ status: string; auto_publish: boolean }> {
  const rows = await withSql(
    async (tx) =>
      (await tx`SELECT status, auto_publish FROM quality_audit_runs WHERE id = ${id}::uuid`) as unknown as {
        status: string;
        auto_publish: boolean;
      }[],
  );
  const row = rows[0];
  if (!row) throw new Error(`audit run ${id} missing`);
  return row;
}

describe("redeployThroughQualityGate", () => {
  it("nothing staged yet: Stages and queues an automatic-publish check, never builds production", async () => {
    const r = await redeployThroughQualityGate({ adapter, registry }, [homeId]);
    if (r.path !== "staged-for-audit" || !r.auditRunId) throw new Error(JSON.stringify(r));
    expect(await auditRun(r.auditRunId)).toEqual({ status: "queued", auto_publish: true });
    const runs = await runsByTarget();
    expect(runs.map((x) => `${x.target}:${x.status}`)).toEqual(["staging:succeeded"]);
    // The audit worker's verdict (faked here): the Stage is clean.
    await withSql(async (tx) => {
      await tx`UPDATE quality_audit_runs SET status = 'passed', started_at = now(), finished_at = now()
               WHERE id = ${r.auditRunId}::uuid`;
    });
  });

  it("content-only changes since the checked Stage rebuild production directly", async () => {
    await op("pages.update", { pageId: homeId, title: "Home, renamed" });
    expect(await redeployThroughQualityGate({ adapter, registry }, [homeId])).toEqual({
      path: "production",
      ok: true,
    });
    expect((await runsByTarget()).at(-1)).toMatchObject({
      target: "production",
      status: "succeeded",
    });
  });

  it("module code changes Stage again and audit the pages placing the module", async () => {
    await op("modules.update", { moduleId: cardModuleId, html: "<p>v1</p>" });
    const r = await redeployThroughQualityGate({ adapter, registry }, []);
    if (r.path !== "staged-for-audit" || !r.auditRunId) throw new Error(JSON.stringify(r));
    const target = await withSql(
      async (tx) =>
        (await tx`SELECT target_page_ids::text[] AS ids FROM quality_audit_runs WHERE id = ${r.auditRunId}::uuid`) as unknown as {
          ids: string[];
        }[],
    );
    expect(target[0]?.ids).toEqual([homeId]);
    expect((await runsByTarget()).filter((x) => x.target === "production")).toHaveLength(1);
  });
});

/** Mark every queued/running audit as a clean pass (the audit worker's verdict, faked). */
async function passAllAudits(): Promise<void> {
  await withSql(async (tx) => {
    await tx`UPDATE quality_audit_runs SET status = 'passed', started_at = now(), finished_at = now()
             WHERE status IN ('queued', 'running')`;
  });
}

describe("issue #620 Part B — an AI-initiated Stage never auto-publishes", () => {
  const HUMAN: ExecutionContext = { ...SYS, actorKind: "human", requestId: "issue620-human" };

  it("blocks the direct production rebuild and the audit-gated automatic publish until a human Publish live", async () => {
    await passAllAudits();
    // The AI works in the shared draft and Stages its own change.
    const chat = await op<{ chatSessionId: string; chatBranchId: string }>("chat.create_session", {
      title: `${PFX}ai stage`,
    });
    const ai: ExecutionContext = {
      ...SYS,
      actorKind: "ai",
      requestId: "issue620-ai",
      chatBranchId: chat.chatBranchId,
      chatTaskId: chat.chatSessionId,
    };
    const edit = await execute(registry, adapter, ai, "pages.update", {
      pageId: homeId,
      title: "Home, staged by the AI",
    });
    expect(edit.ok).toBe(true);
    const staged = await stageChatSessions({ registry, adapter }, ai, [chat.chatSessionId]);
    if (!staged.ok) throw new Error(JSON.stringify(staged.error));
    const holds = await withSql(
      async (tx) =>
        (await tx`SELECT count(*)::int AS n FROM ai_stage_holds WHERE released_at IS NULL`) as unknown as {
          n: number;
        }[],
    );
    expect(holds[0]?.n).toBe(1);
    // A clean audit of the AI's Stage — the gate itself would be open.
    await passAllAudits();

    // 1) The auto-redeploy's direct path (main renders what the clean Stage
    //    saw) refuses and records why.
    const direct = await redeployThroughQualityGate({ adapter, registry }, [homeId]);
    expect(direct).toEqual({ path: "production", ok: false });
    const lastRun = (await runsByTarget()).at(-1);
    expect(lastRun).toMatchObject({ target: "production", status: "failed" });
    expect(lastRun?.error).toContain("AI staged");

    // 2) The audit-gated path: a rendering change makes the redeploy Stage
    //    and queue an automatic publish; even with a clean audit the settle
    //    step stops instead of promoting.
    await op("modules.update", { moduleId: cardModuleId, html: "<p>v2</p>" });
    const auto = await redeployThroughQualityGate({ adapter, registry }, []);
    if (auto.path !== "staged-for-audit" || !auto.auditRunId) throw new Error(JSON.stringify(auto));
    await passAllAudits();
    const settled = await op<{
      settled: { auditRunId: string; outcome: string; message: string | null }[];
    }>("quality_audits.settle_auto_publish", {});
    const mine = settled.settled.find((x) => x.auditRunId === auto.auditRunId);
    expect(mine?.outcome).toBe("blocked");
    expect(mine?.message).toContain("AI staged");
    expect(
      (await runsByTarget()).filter((r) => r.target === "production" && r.status === "succeeded"),
    ).toHaveLength(1);

    // 3) A human Publish live ships it and releases the hold; automatic
    //    rebuilds work again afterwards.
    const promoted = await execute(registry, adapter, HUMAN, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
    });
    if (!promoted.ok) throw new Error(JSON.stringify(promoted.error));
    const open = await withSql(
      async (tx) =>
        (await tx`SELECT count(*)::int AS n FROM ai_stage_holds WHERE released_at IS NULL`) as unknown as {
          n: number;
        }[],
    );
    expect(open[0]?.n).toBe(0);
    await op("pages.update", { pageId: homeId, title: "Home, after the human publish" });
    expect(await redeployThroughQualityGate({ adapter, registry }, [homeId])).toEqual({
      path: "production",
      ok: true,
    });
  });
});

/** Release every open hold so a test starts from "no AI Stage waiting". */
async function releaseAllHolds(): Promise<void> {
  await withSql(async (tx) => {
    await tx`UPDATE ai_stage_holds SET released_at = now() WHERE released_at IS NULL`;
  });
}

async function openHoldIds(): Promise<string[]> {
  const rows = await withSql(
    async (tx) =>
      (await tx`SELECT id::text AS id FROM ai_stage_holds WHERE released_at IS NULL`) as unknown as {
        id: string;
      }[],
  );
  return rows.map((r) => r.id);
}

/** Wait until another session queues behind an advisory lock. */
async function waitForAdvisoryWaiter(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const rows = await withSql(
      async (tx) =>
        (await tx`SELECT count(*)::int AS n FROM pg_locks
                  WHERE locktype = 'advisory' AND NOT granted`) as unknown as { n: number }[],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await Bun.sleep(50);
  }
  throw new Error(
    "nothing ever waited on the AI-stage advisory lock — the build did not serialize",
  );
}

/**
 * Hold the AI-stage advisory lock in a transaction of its own until
 * `release()` — the shape of an AI merge in flight (shared, with the hold
 * row it will commit) or of a running automatic production publish
 * (exclusive).
 */
function holdAiStageLock(
  mode: "shared" | "exclusive",
  withHold: boolean,
): { isLocked: Promise<void>; release: () => Promise<void> } {
  const sql = new SQL(ADMIN_URL as string);
  let open!: () => void;
  const released = new Promise<void>((r) => {
    open = r;
  });
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => {
    locked = r;
  });
  const done = sql
    .begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      if (mode === "shared") {
        await tx`SELECT pg_advisory_xact_lock_shared(hashtext(${AI_STAGE_LOCK_KEY}))`;
      } else {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${AI_STAGE_LOCK_KEY}))`;
      }
      if (withHold) {
        await tx`INSERT INTO ai_stage_holds (chat_session_ids, actor_id)
                 VALUES ('{}'::uuid[], ${SYS.actorId}::uuid)`;
      }
      locked();
      await released;
    })
    .finally(() => sql.end());
  return {
    isLocked,
    release: async () => {
      open();
      await done;
    },
  };
}

describe("issue #620 Part B — the hold check is serialized with AI merges (PR #624 review)", () => {
  it("an AI merge committing during an automatic production build can never land in it", async () => {
    await releaseAllHolds();
    await passAllAudits();
    // An AI merge is in flight: it holds the shared lock and has written
    // its hold, not yet committed.
    const merge = holdAiStageLock("shared", true);
    await merge.isLocked;
    const build = redeployThroughQualityGate({ adapter, registry }, [homeId]);
    // The automatic production build waits for the merge instead of
    // checking holds (none visible yet) and building main under it.
    await waitForAdvisoryWaiter();
    await merge.release();
    expect(await build).toEqual({ path: "production", ok: false });
    const lastRun = (await runsByTarget()).at(-1);
    expect(lastRun).toMatchObject({ target: "production", status: "failed" });
    expect(lastRun?.error).toContain("AI staged");
    await releaseAllHolds();
  });

  it("an AI Stage while an automatic production publish runs is refused, merges nothing, and goes through afterwards", async () => {
    await releaseAllHolds();
    const chat = await op<{ chatSessionId: string; chatBranchId: string }>("chat.create_session", {
      title: `${PFX}stage during publish`,
    });
    const ai: ExecutionContext = {
      ...SYS,
      actorKind: "ai",
      requestId: "issue620-ai-race",
      chatBranchId: chat.chatBranchId,
      chatTaskId: chat.chatSessionId,
    };
    const edit = await execute(registry, adapter, ai, "pages.update", {
      pageId: homeId,
      title: "Home, staged while publishing",
    });
    expect(edit.ok).toBe(true);
    const publishing = holdAiStageLock("exclusive", false);
    await publishing.isLocked;
    const refused = await stageChatSessions({ registry, adapter }, ai, [chat.chatSessionId]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.step).toBe("merge");
      expect(refused.error.message).toContain("automatic production publish is running");
    }
    const live = await withSql(
      async (tx) =>
        (await tx`SELECT title FROM pages WHERE id = ${homeId}::uuid`) as unknown as {
          title: string;
        }[],
    );
    expect(live[0]?.title).not.toBe("Home, staged while publishing");
    expect(await openHoldIds()).toEqual([]);
    await publishing.release();
    const staged = await stageChatSessions({ registry, adapter }, ai, [chat.chatSessionId]);
    if (!staged.ok) throw new Error(JSON.stringify(staged.error));
    expect(await openHoldIds()).toHaveLength(1);
    await releaseAllHolds();
  });

  it("a human Publish live releases exactly the holds its build covers, not one whose merge committed later", async () => {
    await releaseAllHolds();
    await passAllAudits();
    const human: ExecutionContext = { ...SYS, actorKind: "human", requestId: "issue620-exact" };
    // A human Stage: one staging build with its quality check.
    const chat = await op<{ chatSessionId: string }>("chat.create_session", {
      title: `${PFX}human stage`,
    });
    const staging = await stageChatSessions({ registry, adapter }, human, [chat.chatSessionId]);
    if (!staging.ok) throw new Error(JSON.stringify(staging.error));
    await passAllAudits();
    // A merge whose transaction STARTED before that build but committed
    // after it: the hold's created_at predates the build start, yet the
    // build never contained the merge.
    const late = await withSql(
      async (tx) =>
        (await tx`INSERT INTO ai_stage_holds (chat_session_ids, actor_id, created_at)
                  VALUES ('{}'::uuid[], ${SYS.actorId}::uuid, now() - interval '1 hour')
                  RETURNING id::text AS id`) as unknown as { id: string }[],
    );
    const promoted = await execute(registry, adapter, human, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
    });
    if (!promoted.ok) throw new Error(JSON.stringify(promoted.error));
    expect(await openHoldIds()).toEqual([late[0]?.id as string]);
    await releaseAllHolds();
  });
});
