// SPDX-License-Identifier: MPL-2.0

/**
 * `deploy.publish_preview` against real Postgres: what the next Publish
 * live changes, read from the two builds' render fingerprints and the
 * snapshot headers staged between them (site_snapshots.staged_at,
 * migration 0705). And `deploy.promote` refusing a staged build other than
 * the one its review showed (`stagedRunId`).
 *
 * A section design or a section's content counts where it shows: on one
 * published page as a change of that page, on more as a site-wide part.
 *
 * The suite runs on deploy targets of its own, so the newest staged and
 * live builds are the ones it seeds, whatever other files leave behind.
 * Its builds and headers are dated days ahead: no other Stage falls into
 * their window.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { PublishPreview } from "../ops/deploy-publish-preview.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const OWNER_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "pp-test" };
const PFX = `pp-${Date.now()}-`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
/** P1 unchanged, P2 new, P3 removed, P4 edited in a staged chat, P5 a draft page edited. */
const page: Record<"p1" | "p2" | "p3" | "p4" | "p5", string> = {
  p1: "",
  p2: "",
  p3: "",
  p4: "",
  p5: "",
};
/** On P1 and P4: a site-wide part. */
let moduleCode = "";
/** On P1 only: its change is a change of P1. */
let moduleEdited = "";
/** A section with a text field, for the content cases. */
let tileModule = "";

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

/** A pair of deploy targets of this suite's own. */
async function targets(name: string): Promise<{ staging: string; production: string }> {
  return withSql(async (tx) => {
    const s = (await tx`INSERT INTO deploy_targets (name, env, out_dir)
      VALUES (${`${PFX}${name}-staging`}, 'staging', '/tmp/pp') RETURNING id::text AS id`) as {
      id: string;
    }[];
    const p = (await tx`INSERT INTO deploy_targets (name, env, out_dir)
      VALUES (${`${PFX}${name}-prod`}, 'production', '/tmp/pp') RETURNING id::text AS id`) as {
      id: string;
    }[];
    return { staging: s[0]?.id ?? "", production: p[0]?.id ?? "" };
  });
}

/** A succeeded build of `targetId`, started `days` from now, with a fingerprint. */
async function build(
  targetId: string,
  days: number,
  buildId: string,
  fingerprint: Record<string, string> | null,
): Promise<string> {
  return withSql(async (tx) => {
    const r =
      (await tx`INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id, render_fingerprint)
      VALUES (${targetId}::uuid, ${OWNER_ID}::uuid, 'succeeded',
              now() + ${Math.round(days * 24)}::int * interval '1 hour',
              now() + ${Math.round(days * 24)}::int * interval '1 hour', ${buildId},
              ${fingerprint === null ? null : JSON.stringify(fingerprint)}::text::jsonb)
      RETURNING id::text AS id`) as { id: string }[];
    return r[0]?.id ?? "";
  });
}

async function preview(name: string): Promise<PublishPreview> {
  return op<PublishPreview>(OWNER, "deploy.publish_preview", {
    fromTarget: `${PFX}${name}-staging`,
    toTarget: `${PFX}${name}-prod`,
  });
}

/** A chat write, stamped as merged by a Stage `days` from now. */
async function stagedChatWrite(
  days: number,
  write: (ctx: ExecutionContext) => Promise<void>,
): Promise<void> {
  const s = await op<{ chatSessionId: string; chatBranchId: string }>(
    OWNER,
    "chat.create_session",
    {
      title: `${PFX}chat`,
    },
  );
  const ctx = {
    ...OWNER,
    actorKind: "ai" as const,
    chatBranchId: s.chatBranchId,
    chatTaskId: s.chatSessionId,
  };
  await write(ctx);
  await withSql(async (tx) => {
    await tx`UPDATE site_snapshots SET staged_at = now() + ${Math.round(days * 24)}::int * interval '1 hour'
              WHERE chat_task_id = ${s.chatSessionId}::uuid AND staged_at IS NULL`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 'pp owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
  });
  ({ templateId } = await op<{ templateId: string }>(OWNER, "templates.create", {
    pageType: "home",
    slug: `${PFX}tpl`,
    displayName: "T",
    html: '<body><caelo-slot name="content">_</caelo-slot></body>',
  }));
  for (const key of ["p1", "p2", "p3", "p4", "p5"] as const) {
    page[key] = (
      await op<{ pageId: string }>(OWNER, "pages.create", {
        slug: `${PFX}${key}`,
        title: `Page ${key}`,
        templateId,
        status: key === "p5" ? "draft" : "published",
      })
    ).pageId;
  }
  moduleCode = (
    await op<{ moduleId: string }>(OWNER, "modules.create", {
      slug: `${PFX}hero`,
      displayName: `${PFX}Hero`,
      html: "<p>v0</p>",
    })
  ).moduleId;
  moduleEdited = (
    await op<{ moduleId: string }>(OWNER, "modules.create", {
      slug: `${PFX}card`,
      displayName: `${PFX}Card`,
      html: "<p>v0</p>",
    })
  ).moduleId;
  tileModule = await withSql(async (tx) => {
    const r = (await tx`
      INSERT INTO modules (slug, display_name, type, html, fields)
      VALUES (${`${PFX}tile`}, ${`${PFX}Tile`}, ${`${PFX}tile`}, '<h2>{{headline}}</h2>',
              '[{"name":"headline","kind":"text"}]'::jsonb)
      RETURNING id::text AS id`) as { id: string }[];
    return r[0]?.id ?? "";
  });
  await place(moduleCode, [page.p1, page.p4]);
  await place(moduleEdited, [page.p1]);
});

/** A placement of `moduleId` on each page, each with its own content (unsynced); returns the instance ids. */
async function place(moduleId: string, pageIds: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const pageId of pageIds) ids.push(await placeShared(moduleId, [pageId], "unsynced"));
  return ids;
}

/** One content instance of `moduleId`, placed on every one of `pageIds`; returns its id. */
async function placeShared(
  moduleId: string,
  pageIds: readonly string[],
  syncMode: "synced" | "unsynced" = "synced",
): Promise<string> {
  return withSql(async (tx) => {
    const ci = (await tx`
      INSERT INTO content_instances (module_id, "values") VALUES (${moduleId}::uuid, '{"headline":"v0"}'::jsonb)
      RETURNING id::text AS id`) as { id: string }[];
    const id = ci[0]?.id ?? "";
    for (const pageId of pageIds) {
      await tx`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
               VALUES (${pageId}::uuid, 'content',
                       (SELECT count(*)::int FROM page_modules WHERE page_id = ${pageId}::uuid),
                       ${moduleId}::uuid, ${id}::uuid, ${syncMode})`;
    }
    return id;
  });
}

/**
 * Templates, their pages and modules survive the per-file reset
 * (seed-bearing tables): published pages left behind without a meta
 * description would make the next file's Stage refuse its build.
 */
async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM deploy_runs WHERE target_id IN (SELECT id FROM deploy_targets WHERE name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM deploy_targets WHERE name LIKE ${`${PFX}%`}`;
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

describe("deploy.publish_preview", () => {
  it("lists new, changed and removed pages, site-wide parts and settings", async () => {
    const t = await targets("main");
    const fp = (pages: string[], hero: string, base: string) => ({
      ...Object.fromEntries(pages.map((id) => [`page:${id}`, "tpl-hash"])),
      [`module:${moduleCode}`]: hero,
      "setting:site_base_url": base,
    });
    // Live: P1, P3, P4. Staged: P1, P2, P4 — with the hero's code and the base URL changed.
    const liveSource = await build(
      t.staging,
      10,
      "live-src",
      fp([page.p1, page.p3, page.p4], "a", "x"),
    );
    await build(t.production, 10.5, liveSource, null);
    // Between the builds a Stage merged an edit of P4, of the draft page P5
    // and of a module the fingerprint does not see (its fields, not its code).
    await stagedChatWrite(11, async (ctx) => {
      await op(ctx, "pages.update", { pageId: page.p4, title: "Page p4, edited" });
      await op(ctx, "pages.update", { pageId: page.p5, title: "Page p5, edited" });
      await op(ctx, "modules.update", { moduleId: moduleEdited, html: "<p>v1</p>" });
    });
    const staged = await build(t.staging, 12, "staged", fp([page.p1, page.p2, page.p4], "b", "y"));

    const p = await preview("main");
    expect(p.notice).toBeNull();
    expect(p.liveMatchesStaging).toBe(false);
    expect(p.staged?.runId).toBe(staged);
    expect(p.live?.stagedRunId).toBe(liveSource);
    expect(p.pages.new).toEqual({
      total: 1,
      items: [expect.objectContaining({ pageId: page.p2 })],
    });
    expect(p.pages.removed).toEqual({
      total: 1,
      items: [expect.objectContaining({ pageId: page.p3 })],
    });
    // P4 changed; P5 is a draft page, not in the staged build: not listed.
    // P1 changed through the Card, which shows only there.
    expect(p.pages.changed.items.map((i) => i.pageId)).toEqual([page.p1, page.p4]);
    // The Hero shows on two pages: site-wide, with a page to look at.
    expect(p.siteWide.map((s) => [s.title, s.what, s.change, s.samplePath])).toEqual([
      [`${PFX}Hero`, "Section design · on 2 pages", "changed", `/${PFX}p1`],
    ]);
    expect(p.settings).toEqual([{ key: "setting:site_base_url", title: "Site base URL" }]);
  });

  it("counts a section's content where it shows, and names unnamed shared content by its section", async () => {
    const t = await targets("content");
    const fp = { [`page:${page.p1}`]: "h", [`page:${page.p2}`]: "h" };
    const [own] = await place(tileModule, [page.p1]);
    const shared = await placeShared(tileModule, [page.p1, page.p2]);
    const [onDraft] = await place(tileModule, [page.p5]);
    const liveSource = await build(t.staging, 70, "live-src", fp);
    await build(t.production, 70.5, liveSource, null);
    await stagedChatWrite(71, async (ctx) => {
      for (const id of [own, shared, onDraft]) {
        await op(ctx, "content_instances.set_values", { id, values: { headline: "v1" } });
      }
    });
    await build(t.staging, 72, "staged", fp);

    const p = await preview("content");
    expect(p.notice).toBeNull();
    // The section's own text on P1: a change of P1. The content on the draft page P5: no visitor sees it.
    expect(p.pages.changed.items.map((i) => i.pageId)).toEqual([page.p1]);
    expect(p.siteWide.map((s) => [s.kind, s.title, s.what, s.samplePath])).toEqual([
      ["contentInstance", `${PFX}Tile`, "Shared content · on 2 pages", `/${PFX}p1`],
    ]);
  });

  it("says live already serves the staged build", async () => {
    const t = await targets("same");
    const staged = await build(t.staging, 20, "staged", { [`page:${page.p1}`]: "h" });
    await build(t.production, 20.5, staged, null);
    const p = await preview("same");
    expect(p.liveMatchesStaging).toBe(true);
    expect(p.pages.new.total + p.pages.changed.total + p.pages.removed.total).toBe(0);
  });

  it("lists every published page of the first Publish live as new", async () => {
    const t = await targets("first");
    await build(t.staging, 30, "staged", {
      [`page:${page.p1}`]: "h",
      [`page:${page.p2}`]: "h",
      "setting:site_base_url": "x",
    });
    const p = await preview("first");
    expect(p.live).toBeNull();
    expect(p.notice).toContain("first Publish live");
    expect(p.pages.new.total).toBe(2);
    expect(p.pages.new.items.map((i) => i.pageId).sort()).toEqual([page.p1, page.p2].sort());
  });

  it("says so instead of listing when live was built directly or the staged build is too old", async () => {
    const direct = await targets("direct");
    await build(direct.staging, 40, "staged", { [`page:${page.p1}`]: "h" });
    await build(direct.production, 40.5, "an-owners-production-build", null);
    const p = await preview("direct");
    expect(p.notice).toContain("built directly");
    expect(p.pages.changed.total + p.pages.new.total + p.pages.removed.total).toBe(0);

    const old = await targets("old");
    await build(old.staging, 50, "staged", null);
    expect((await preview("old")).notice).toContain("older Caelo version");
  });
});

describe("deploy.promote with the review's staged run", () => {
  it("refuses when staging was rebuilt after the review was opened", async () => {
    const t = await targets("bind");
    const reviewed = await build(t.staging, 60, "reviewed", { [`page:${page.p1}`]: "h" });
    await build(t.staging, 61, "rebuilt", { [`page:${page.p1}`]: "h2" });
    const r = await execute(registry, adapter, OWNER, "deploy.promote", {
      fromTarget: `${PFX}bind-staging`,
      toTarget: `${PFX}bind-prod`,
      stagedRunId: reviewed,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.error)).toContain(
      "staging was rebuilt after the Publish live review was opened",
    );
    // Nothing was started on the production target.
    const runs = await withSql(
      (tx) =>
        tx`SELECT count(*)::int AS n FROM deploy_runs WHERE target_id = ${t.production}::uuid` as unknown as Promise<
          { n: number }[]
        >,
    );
    expect(runs[0]?.n).toBe(0);
  });
});
