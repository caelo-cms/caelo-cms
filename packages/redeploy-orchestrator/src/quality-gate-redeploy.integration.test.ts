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
import { registerAdminOps, setDeployBridge } from "@caelo-cms/admin-core";
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
