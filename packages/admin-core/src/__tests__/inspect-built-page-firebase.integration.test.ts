// SPDX-License-Identifier: MPL-2.0

/**
 * #1088 / #1330 — inspect_built_page on a gcp-firebase install. A staged
 * run is read from its staging slot (the private staging bucket the
 * staging gateway serves), and the result names the staging host. Real
 * Postgres (§6); only the staging bucket is faked.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { inspectBuiltPageTool } from "../ai/tools/inspect-built-page.js";
import { setStagingBucketForTests } from "../deploy/staging-slots.js";
import { registerAdminOps } from "../register.js";
import { type FakeStagingBucket, fakeStagingBucket } from "./fixtures/fake-staging-bucket.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "inspect-built-firebase-int",
};
const PFX = "ibpfb";
const STAGING_HOST = "staging.example.test";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId: string;
const toolCtx = () => ({ adapter, registry }) as ToolContext;
const realProvider = process.env.CAELO_PROVIDER;
let slots: FakeStagingBucket;

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

/** A succeeded staging run; `stagingLocation` null models a run staged before #1330. */
async function stagingRun(stagingLocation: string | null, minutesAgo: number): Promise<string> {
  return withSql(async (tx) => {
    const rows = (await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, publish_summary)
      SELECT id, ${SYSTEM.actorId}::uuid, 'succeeded',
             now() - make_interval(mins => ${minutesAgo}), now(),
             jsonb_strip_nulls(jsonb_build_object('location', 'x', 'stagingLocation', ${stagingLocation}::text))
      FROM deploy_targets WHERE name = 'staging'
      RETURNING id::text AS id
    `) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) throw new Error("deploy run seed");
    return id;
  });
}

/** Put a build of `runId` with `files` into a slot of the fake staging bucket. */
function fillSlot(location: string, runId: string, files: Record<string, string>): void {
  slots.objects.set(
    `${location}.manifest.json`,
    Buffer.from(
      JSON.stringify({
        version: 1,
        runId,
        pageUrlStyle: "directory",
        files: Object.fromEntries(
          Object.keys(files).map((p) => [p, { type: "text/html; charset=utf-8", hash: p }]),
        ),
      }),
    ),
  );
  for (const [path, body] of Object.entries(files)) {
    slots.objects.set(`${location}/${path}`, Buffer.from(body));
  }
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
  slots = fakeStagingBucket();
  setStagingBucketForTests(slots.bucket);
  await withSql((tx) => tx`UPDATE staging_access SET staging_host = ${STAGING_HOST} WHERE id = 1`);
});

afterAll(async () => {
  setStagingBucketForTests(null);
  await withSql((tx) => tx`UPDATE staging_access SET staging_host = NULL WHERE id = 1`);
  if (realProvider === undefined) delete process.env.CAELO_PROVIDER;
  else process.env.CAELO_PROVIDER = realProvider;
  await wipe();
  await adapter.close();
});

describe("inspect_built_page on gcp-firebase (#1088, #1330)", () => {
  it("reads the newest staged build from its staging slot, shown under the staging host", async () => {
    const runId = await stagingRun("_slots/a", 0);
    fillSlot("_slots/a", runId, {
      [`${PFX}-page/index.html`]: "<html><head><meta name=description content=built></head></html>",
    });
    const r = await inspectBuiltPageTool.handler(SYSTEM, { pageId, target: "staging" }, toolCtx());
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content) as { html: string; location: string; runId: string };
    expect(body.html).toContain("content=built");
    expect(body.location).toStartWith(`https://${STAGING_HOST}/${PFX}-page/index.html`);
  });

  it("names Stage again when the run was staged before the slots", async () => {
    const runId = await stagingRun(null, 5);
    const r = await inspectBuiltPageTool.handler(
      SYSTEM,
      { pageId, target: "staging", runId },
      toolCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/no staging slot.*Run Stage again/);
    expect(r.content).not.toMatch(/CAELO_STATIC_BUCKET/);
  });

  it("explains a page the slot does not have, and a slot a later Stage replaced", async () => {
    const runId = await stagingRun("_slots/b", 10);
    fillSlot("_slots/b", runId, { "index.html": "<html></html>" });
    const missing = await inspectBuiltPageTool.handler(
      SYSTEM,
      { pageId, target: "staging", runId },
      toolCtx(),
    );
    expect(missing.ok).toBe(false);
    expect(missing.content).toMatch(/Page not in staging build/);
    fillSlot("_slots/b", "0b7c0d6e-9999-4999-8999-999999999999", { "index.html": "x" });
    const replaced = await inspectBuiltPageTool.handler(
      SYSTEM,
      { pageId, target: "staging", runId },
      toolCtx(),
    );
    expect(replaced.ok).toBe(false);
    expect(replaced.content).toMatch(/later Stage replaced it/);
  });
});
