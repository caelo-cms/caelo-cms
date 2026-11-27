// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1750 — `list_unpublished_changes` after a chat staged a section
 * design's script, and two later Stages of other chats, before any Publish
 * live. Reported on 0.12.16: the chat's own part listed nothing of the
 * staged change ("split unstaged | staged" — the staged half stayed
 * empty), so the AI could not tell that its change was waiting for Publish
 * live.
 *
 * The flow runs on the real ops: the draft chats write, a Stage merges
 * them (`chat.merge_draft_to_main`) and records a staging build with main's
 * render fingerprint, as `deploy.trigger` does, and Publish live is a
 * production run whose build id is the staging run it copied. The builds
 * run on the seeded `staging` / `production` targets the tool reads (the
 * per-file reset empties `deploy_runs`).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, defineOperation, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { SQL } from "bun";
import { z } from "zod";
import { listUnpublishedChangesTool } from "../ai/tools/history-tools.js";
import { STAGED_HEADERS_LISTED } from "../ops/chat/stage.js";
import type { PublishPreview } from "../ops/deploy-publish-preview.js";
import { computeRenderFingerprint } from "../ops/quality/render-fingerprint.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const OWNER_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t1750" };
const SYS: ExecutionContext = { ...OWNER, actorKind: "system" };
const PFX = `t1750-${Date.now()}-`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

/** The fingerprint `deploy.trigger` records as a staging build starts. */
const fingerprintOp = defineOperation({
  name: "test.render_fingerprint",
  readScope: "site",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.record(z.string(), z.string()),
  handler: async (_ctx, _input, tx) => ok(await computeRenderFingerprint(tx)),
});

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

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

interface Chat {
  readonly id: string;
  readonly ctx: ExecutionContext;
}

async function chat(title: string): Promise<Chat> {
  const v = await op<{ chatSessionId: string; chatBranchId: string; branchKind: string }>(
    SYS,
    "chat.create_session",
    { title: `${PFX}${title}` },
  );
  if (v.branchKind !== "draft") throw new Error(`expected a draft chat, got ${v.branchKind}`);
  return {
    id: v.chatSessionId,
    ctx: {
      actorId: OWNER_ID,
      actorKind: "ai",
      requestId: `t1750-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

let stagingTarget = "";
let productionTarget = "";

/** A succeeded staging build of main as it is now (its fingerprint, as deploy.trigger records it). */
async function stagingBuild(): Promise<string> {
  const r = await adapter.runOperation(fingerprintOp, SYS, {});
  if (!r.ok) throw new Error(`fingerprint: ${JSON.stringify(r.error)}`);
  return withSql(async (tx) => {
    const rows = (await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id, render_fingerprint)
      VALUES (${stagingTarget}::uuid, ${OWNER_ID}::uuid, 'succeeded', clock_timestamp(), clock_timestamp(),
              'pending', ${JSON.stringify(r.value)}::text::jsonb)
      RETURNING id::text AS id`) as { id: string }[];
    const id = rows[0]?.id ?? "";
    await tx`UPDATE deploy_runs SET build_id = ${id} WHERE id = ${id}::uuid`;
    return id;
  });
}

/** Publish live of a staging build: a production run whose build id is that staging run. */
async function publishLive(stagingRunId: string): Promise<string> {
  return withSql(async (tx) => {
    const rows = (await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id)
      VALUES (${productionTarget}::uuid, ${OWNER_ID}::uuid, 'succeeded', clock_timestamp(), clock_timestamp(),
              ${stagingRunId})
      RETURNING id::text AS id`) as { id: string }[];
    return rows[0]?.id ?? "";
  });
}

/**
 * A production run whose build id is `buildId`: an Owner's direct
 * production build names itself, a rollback the run it restores.
 */
async function productionRun(buildId?: string): Promise<string> {
  return withSql(async (tx) => {
    const rows = (await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id)
      VALUES (${productionTarget}::uuid, ${OWNER_ID}::uuid, 'succeeded', clock_timestamp(), clock_timestamp(),
              ${buildId ?? "pending"})
      RETURNING id::text AS id`) as { id: string }[];
    const id = rows[0]?.id ?? "";
    if (buildId === undefined)
      await tx`UPDATE deploy_runs SET build_id = ${id} WHERE id = ${id}::uuid`;
    return id;
  });
}

/**
 * A plugin-data build on top of the live run (#1155): a production run of
 * its own kind whose build id is its own run id, as both publishers record it.
 */
async function pluginDataBuild(liveRunId: string): Promise<void> {
  await withSql(async (tx) => {
    const rows = (await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id, build_kind, base_run_id)
      VALUES (${productionTarget}::uuid, ${OWNER_ID}::uuid, 'succeeded', clock_timestamp(), clock_timestamp(),
              'pending', 'plugin_data', ${liveRunId}::uuid)
      RETURNING id::text AS id`) as { id: string }[];
    const id = rows[0]?.id ?? "";
    await tx`UPDATE deploy_runs SET build_id = ${id} WHERE id = ${id}::uuid`;
  });
}

/** A Stage of `chats`: merge their draft changes into main, then build staging. */
async function stage(...chats: Chat[]): Promise<string> {
  await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: chats.map((c) => c.id) });
  return stagingBuild();
}

async function preview(): Promise<PublishPreview> {
  return op<PublishPreview>(OWNER, "deploy.publish_preview", {});
}

async function unpublished(c: Chat): Promise<string> {
  const r = await listUnpublishedChangesTool.handler(c.ctx, {}, {
    adapter,
    registry,
    chatSessionId: c.id,
    chatBranchId: c.ctx.chatBranchId ?? undefined,
  } as never);
  expect(r.ok).toBe(true);
  return r.content;
}

let templateId = "";
const pages: Record<"en" | "de" | "other" | "mobile-en" | "mobile-de" | "mobile-fr", string> = {
  en: "",
  de: "",
  other: "",
  "mobile-en": "",
  "mobile-de": "",
  "mobile-fr": "",
};
/** "Tool-Renderer: Technologie-Erkennung" — on the en and de variant of one tool page. */
let detection = "";
/** "Tool-Renderer: Mobil-Test" — on three pages. */
let mobile = "";
/** A section design on one page only. */
let single = "";

async function place(moduleId: string, pageId: string): Promise<void> {
  await withSql(async (tx) => {
    const ci = (await tx`
      INSERT INTO content_instances (module_id, "values") VALUES (${moduleId}::uuid, '{}'::jsonb)
      RETURNING id::text AS id`) as { id: string }[];
    await tx`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
             VALUES (${pageId}::uuid, 'content',
                     (SELECT count(*)::int FROM page_modules WHERE page_id = ${pageId}::uuid),
                     ${moduleId}::uuid, ${ci[0]?.id}::uuid, 'unsynced')`;
  });
}

async function seedModule(slug: string, displayName: string): Promise<string> {
  return (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${PFX}${slug}`,
      displayName: `${PFX}${displayName}`,
      html: `<div class="${slug}"></div>`,
      js: `/* ${slug} v0 */`,
    })
  ).moduleId;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 't1750 owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
    const targets = (await tx`SELECT id::text AS id, name FROM deploy_targets
      WHERE name IN ('staging', 'production')`) as { id: string; name: string }[];
    stagingTarget = targets.find((t) => t.name === "staging")?.id ?? "";
    productionTarget = targets.find((t) => t.name === "production")?.id ?? "";
    if (!stagingTarget || !productionTarget) throw new Error("seeded deploy targets missing");
    await tx`DELETE FROM deploy_runs WHERE target_id IN (${stagingTarget}::uuid, ${productionTarget}::uuid)`;
  });
  ({ templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
    pageType: "home",
    slug: `${PFX}tpl`,
    displayName: "T",
    html: '<body><caelo-slot name="content">_</caelo-slot></body>',
  }));
  for (const key of Object.keys(pages) as (keyof typeof pages)[]) {
    pages[key] = (
      await op<{ pageId: string }>(SYS, "pages.create", {
        slug: `${PFX}${key}`,
        title: `Page ${key}`,
        templateId,
        status: "published",
      })
    ).pageId;
  }
  detection = await seedModule("detection", "Tool-Renderer: Technologie-Erkennung");
  mobile = await seedModule("mobile", "Tool-Renderer: Mobil-Test");
  single = await seedModule("single", "Single");
  await place(detection, pages.en);
  await place(detection, pages.de);
  for (const p of [pages["mobile-en"], pages["mobile-de"], pages["mobile-fr"]])
    await place(mobile, p);
  await place(single, pages.other);
});

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM deploy_runs WHERE actor_id = ${OWNER_ID}::uuid`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT p.id FROM pages p JOIN templates t ON t.id = p.template_id WHERE t.slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
  });
}

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("#1750 a staged section script before Publish live", () => {
  it("is named in the chat's own part and in what the next Publish live ships, after later Stages", async () => {
    const live = await stagingBuild();
    await publishLive(live);

    // The chat changes the renderer's script and stages it; it then edits
    // another renderer without staging that.
    const a = await chat("renderer");
    await op(a.ctx, "modules.update", { moduleId: detection, js: "/* detection v1 */" });
    await stage(a);
    await op(a.ctx, "modules.update", { moduleId: mobile, js: "/* mobile from A, unstaged */" });

    // Two later Stages of other chats.
    const b = await chat("other-1");
    await op(b.ctx, "modules.update", { moduleId: single, js: "/* single v1 */" });
    await stage(b);
    const c = await chat("other-2");
    await op(c.ctx, "pages.update", { pageId: pages.other, title: "Page other, edited" });
    const staged = await stage(c);

    const p = await preview();
    expect(p.notice).toBeNull();
    expect(p.staged?.runId).toBe(staged);
    expect(p.live?.stagedRunId).toBe(live);
    // The unstaged Mobil-Test edit is not in the staged build.
    expect(p.siteWide.map((s) => [s.title, s.what])).toEqual([
      [`${PFX}Tool-Renderer: Technologie-Erkennung`, "Section design · on 2 pages"],
    ]);
    expect(p.pages.changed.items.map((i) => i.pageId)).toEqual([pages.other]);

    const text = await unpublished(a);
    expect(text).toContain(`pending global module ${PFX}Tool-Renderer: Mobil-Test`);
    // The staged half names what this chat staged and live does not serve yet.
    expect(text).toContain(`staged global module ${PFX}Tool-Renderer: Technologie-Erkennung`);
    expect(text).toContain(
      `"${PFX}Tool-Renderer: Technologie-Erkennung" (Section design · on 2 pages)`,
    );
    // Another chat's staged change is not this chat's.
    expect(text).not.toContain(`staged global module ${PFX}Single`);

    // Publish live ships it: nothing of it is staged any more.
    await publishLive(staged);
    const after = await unpublished(a);
    expect(after).not.toContain("staged global module");
    expect(after).toContain(`pending global module ${PFX}Tool-Renderer: Mobil-Test`);
    expect(after).toContain("live already serves the staged build");
  });

  it("compares with the live site build when a plugin-data build ran on top of it", async () => {
    const before = await stagingBuild();
    const liveRun = await publishLive(before);
    await pluginDataBuild(liveRun);

    const d = await chat("after-plugin-data");
    await op(d.ctx, "modules.update", { moduleId: single, js: "/* single v2 */" });
    const staged = await stage(d);

    const p = await preview();
    // Not "built directly": live is the site build the plugin data was baked into.
    expect(p.notice).toBeNull();
    expect(p.staged?.runId).toBe(staged);
    expect(p.live?.runId).toBe(liveRun);
    expect(p.live?.stagedRunId).toBe(before);
    expect(p.pages.changed.items.map((i) => i.pageId)).toEqual([pages.other]);
    expect(await unpublished(d)).toContain(`staged global module ${PFX}Single`);
  });

  it("dates a rollback from the build it restored, and keeps staged draft changes of a chat that moved to its own branch", async () => {
    // An Owner's direct production build, a change staged after it, then a
    // rollback to the direct build: live serves the direct build's output.
    const direct = await productionRun();
    const f = await chat("rollback");
    await op(f.ctx, "modules.update", { moduleId: single, js: "/* after the direct build */" });
    await stage(f);
    await productionRun(direct);
    expect(await unpublished(f)).toContain(`staged global module ${PFX}Single`);

    // The chat starts an experiment on its own branch before Publish live.
    await op(SYS, "chat.isolate_session", { chatSessionId: f.id, reason: "experiment" });
    expect(await unpublished(f)).toContain(`staged global module ${PFX}Single`);
  });

  it("lists the newest staged changes and says when older ones are not listed", async () => {
    const e = await chat("many-stages");
    await op(e.ctx, "modules.update", {
      moduleId: single,
      js: "/* single, oldest of this Stage */",
    });
    for (let i = 0; i < STAGED_HEADERS_LISTED; i += 1) {
      await op(e.ctx, "modules.update", { moduleId: detection, js: `/* detection v${i + 2} */` });
    }
    await stage(e);
    const newest = await seedModule("newest", "Newest");
    await op(e.ctx, "modules.update", { moduleId: newest, js: "/* newest */" });
    await stage(e);

    const v = await op<{
      staged: { globals: { kind: string; entityId: string }[] };
      olderStagedNotListed: boolean;
    }>(SYS, "chat.list_pending_changes", { chatSessionId: e.id });
    // The newest staged headers: the later Stage's module and the renderer's
    // edits; the Single edit is older than the page the list reads.
    expect(v.olderStagedNotListed).toBe(true);
    expect(v.staged.globals.map((g) => g.entityId).sort()).toEqual([detection, newest].sort());
    expect(await unpublished(e)).toContain("older changes of this chat are not listed");
    // A page and one more: about a hundred writes through the real op.
  }, 180_000);
});
