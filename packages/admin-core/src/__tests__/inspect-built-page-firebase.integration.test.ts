// SPDX-License-Identifier: MPL-2.0

/**
 * #1088 — inspect_built_page on a gcp-firebase install. #993 offered the
 * tool there (the install counts as GCP), but the handler only knew GCS
 * buckets and every call failed with "CAELO_STATIC_BUCKET /
 * CAELO_STAGING_BUCKET not set". Firebase builds live on Hosting channels:
 * the staged run is read from its preview channel, and the result names
 * the staging host, never the internal channel URL (#650). Real Postgres
 * (§6); only the channel's HTTP answer is faked.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { inspectBuiltPageTool } from "../ai/tools/inspect-built-page.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "inspect-built-firebase-int",
};
const PFX = "ibpfb";
const PREVIEW = "https://caelo-site--runid-abc123.web.app";
const STAGING_HOST = "https://staging.example.test";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId: string;
const toolCtx = () => ({ adapter, registry }) as ToolContext;
const realFetch = globalThis.fetch;
const realProvider = process.env.CAELO_PROVIDER;
const fetched: string[] = [];

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
  });
}

/** A succeeded staging run; `previewUrl` null models a run without a channel. */
async function stagingRun(previewUrl: string | null, minutesAgo: number): Promise<string> {
  return withSql(async (tx) => {
    const rows = (await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, publish_summary, site_url)
      SELECT id, ${SYSTEM.actorId}::uuid, 'succeeded',
             now() - make_interval(mins => ${minutesAgo}), now(),
             jsonb_strip_nulls(jsonb_build_object('location', 'x', 'previewUrl', ${previewUrl}::text)),
             ${STAGING_HOST}
      FROM deploy_targets WHERE name = 'staging'
      RETURNING id::text AS id
    `) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) throw new Error("deploy run seed");
    return id;
  });
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "T",
    html: `<body><caelo-slot name="content"></caelo-slot></body>`,
    css: "",
  });
  if (!tpl.ok) throw new Error("tpl");
  const pg = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug: `${PFX}-page`,
    title: "P",
    templateId: (tpl.value as { templateId: string }).templateId,
  });
  if (!pg.ok) throw new Error("page");
  pageId = (pg.value as { pageId: string }).pageId;

  process.env.CAELO_PROVIDER = "gcp-firebase";
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url instanceof Request ? url.url : url);
    fetched.push(href);
    if (href === `${PREVIEW}/${PFX}-page/index.html`) {
      return new Response("<html><head><meta name=description content=built></head></html>", {
        status: 200,
      });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (realProvider === undefined) delete process.env.CAELO_PROVIDER;
  else process.env.CAELO_PROVIDER = realProvider;
  await wipe();
  await adapter.close();
});

describe("inspect_built_page on gcp-firebase (#1088)", () => {
  it("reads the newest staged build from its preview channel, shown under the staging host", async () => {
    await stagingRun(PREVIEW, 0);
    const r = await inspectBuiltPageTool.handler(SYSTEM, { pageId, target: "staging" }, toolCtx());
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content) as { html: string; location: string; runId: string };
    expect(body.html).toContain("content=built");
    expect(body.location).toStartWith(`${STAGING_HOST}/${PFX}-page/index.html`);
    // #650 — the channel URL is read, never shown.
    expect(r.content).not.toContain("web.app");
    expect(fetched).toContain(`${PREVIEW}/${PFX}-page/index.html`);
  });

  it("names Stage again when the run has no preview channel", async () => {
    const runId = await stagingRun(null, 5);
    const r = await inspectBuiltPageTool.handler(
      SYSTEM,
      { pageId, target: "staging", runId },
      toolCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/no Firebase preview channel.*Run Stage again/);
    expect(r.content).not.toMatch(/CAELO_STATIC_BUCKET/);
  });

  it("explains a page the channel does not serve", async () => {
    const runId = await stagingRun("https://caelo-site--runid-old.web.app", 10);
    const r = await inspectBuiltPageTool.handler(
      SYSTEM,
      { pageId, target: "staging", runId },
      toolCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/Page not in staging build .* answered 404/);
    expect(r.content).not.toContain("web.app");
  });
});
