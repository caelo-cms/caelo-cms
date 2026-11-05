// SPDX-License-Identifier: MPL-2.0

/**
 * #1497 — the home and 404 designations are global, but a chat sets them:
 *
 *   - a chat designating an existing main page has nothing pending, so no
 *     merge would ever recompose the paths: `/` must serve the page after a
 *     Stage anyway;
 *   - a page only a branch holds must not reach the pointers main's build
 *     reads, or every other chat's Stage fails; its designation waits and
 *     goes live with the page, whose merge must not collide with the old
 *     home on `/`.
 *
 * The staging build runs for real; the suite has no serve layer, so a run
 * ends at the verification step, after the files are written.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

const SYSTEM_ACTOR = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = {
  actorId: SYSTEM_ACTOR,
  actorKind: "system",
  requestId: "designations-from-chat",
};
const PFX = "dfc-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let testRoot = "";
let restoreBaseUrl: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    })) as T;
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
  id: string;
  ctx: ExecutionContext;
}

async function chat(title: string, isolation?: "experiment"): Promise<Chat> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    title: `${PFX}${title}`,
    ...(isolation ? { isolation } : {}),
  });
  return {
    id: v.chatSessionId,
    ctx: {
      actorId: SYSTEM_ACTOR,
      actorKind: "ai",
      requestId: `dfc-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

/** A published page on main (or, with a chat context, on that branch). */
async function page(ctx: ExecutionContext, slug: string): Promise<string> {
  const { pageId } = await op<{ pageId: string }>(ctx, "pages.build_page", {
    page: {
      slug: `${PFX}${slug}`,
      title: slug,
      templateId,
      status: "published",
      metaDescription: `The ${slug} page.`,
    },
    modules: [],
  });
  return pageId;
}

/** A file of the newest staging build. */
async function builtFile(name: string): Promise<string> {
  const staging = join(testRoot, "output", "staging");
  const glob = new Bun.Glob(`**/${name}`);
  const hits: string[] = [];
  // Not the copy under a page's own directory: the file at the site root.
  for await (const f of glob.scan({ cwd: staging })) if (!f.includes(PFX)) hits.push(f);
  const newest = await Promise.all(
    hits.map(async (f) => ({ f, at: (await stat(join(staging, f))).mtimeMs })),
  );
  newest.sort((a, b) => b.at - a.at);
  const first = newest[0];
  if (!first) throw new Error(`no ${name} under ${staging}`);
  return readFile(join(staging, first.f), "utf8");
}

async function storedPath(pageId: string): Promise<string | undefined> {
  const rows = await asSystem(
    (tx) => tx`SELECT current_path FROM pages WHERE id = ${pageId}::uuid`,
  );
  return (rows as unknown as { current_path: string }[])[0]?.current_path;
}

async function wipe(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`UPDATE site_defaults SET home_page_id = NULL, not_found_page_id = NULL WHERE id = 1`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}tpl`}`;
  });
}

async function seed(): Promise<void> {
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      pageType: "home",
      slug: `${PFX}tpl`,
      displayName: "T",
      html: `<!doctype html><html lang="en"><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
}

beforeAll(async () => {
  restoreBaseUrl = await pinSiteBaseUrl(ADMIN_URL, "https://example.com");
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-dfc-"));
});

beforeEach(async () => {
  await wipe();
  await seed();
});

afterEach(wipe);

afterAll(async () => {
  await restoreBaseUrl?.();
  await restoreLanguage?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

/** The build a Stage runs, on main as it is. Serve verification is not this suite's subject. */
async function buildStaging(): Promise<string> {
  const r = await execute(registry, adapter, SYS, "deploy.trigger", {
    targetName: "staging",
    repoRoot: testRoot,
  });
  if (r.ok) return "built";
  return "message" in r.error ? r.error.message : JSON.stringify(r.error);
}

const SERVE_LAYER_MISSING = "staging serve layer unreachable";

async function designations(): Promise<Record<string, string | null>> {
  const rows = await asSystem(
    (tx) => tx`SELECT home_page_id::text AS home, not_found_page_id::text AS not_found,
                      pending_home_page_id::text AS pending_home,
                      pending_not_found_page_id::text AS pending_not_found
               FROM site_defaults WHERE id = 1`,
  );
  return (rows as unknown as Record<string, string | null>[])[0] as Record<string, string | null>;
}

async function mainWithHome(): Promise<string> {
  const home = await page(SYS, "home-now");
  await op(SYS, "pages.set_home_page", { pageId: home });
  expect(await storedPath(home)).toBe("/");
  return home;
}

async function homeOf(ctx: ExecutionContext): Promise<string | null> {
  const v = await op<{ defaults: { homePageId: string | null } }>(ctx, "site_defaults.get", {});
  return v.defaults.homePageId;
}

describe("set_home_page from a chat", () => {
  it("an existing main page with no pending edit serves / after the next Stage", async () => {
    const oldHome = await mainWithHome();
    const next = await page(SYS, "next");
    const c = await chat("flip");
    await op(c.ctx, "pages.set_home_page", { pageId: next });

    // Nothing is pending on the branch, so the Stage merges nothing: the
    // stored paths have to agree with the pointer before it.
    const merged = await op<{ entityCount: number }>(SYS, "chat.merge_draft_to_main", {
      chatSessionIds: [c.id],
    });
    expect(merged.entityCount).toBe(0);
    expect(await storedPath(next)).toBe("/");
    expect(await storedPath(oldHome)).toBe(`/${PFX}home-now`);

    expect(await buildStaging()).toContain(SERVE_LAYER_MISSING);
    expect(await builtFile("index.html")).toContain("The next page.");
  });

  it("a page only the branch holds waits there, and main keeps its home for other Stages", async () => {
    const oldHome = await mainWithHome();
    const c = await chat("new-home", "experiment");
    const created = await page(c.ctx, "new-home");
    await op(c.ctx, "pages.set_home_page", { pageId: created });

    expect(await designations()).toMatchObject({ home: oldHome, pending_home: created });
    expect(await homeOf(c.ctx)).toBe(created);
    expect(await homeOf(SYS)).toBe(oldHome);
    expect(await storedPath(oldHome)).toBe("/");

    // Another write to the old home composes under main's designation, so
    // it keeps "/" and that Stage still has a root.
    await op(SYS, "pages.update", { pageId: oldHome, title: "Renamed" });
    await op(SYS, "pages.refresh_current_path", { pageId: oldHome });
    expect(await storedPath(oldHome)).toBe("/");
    expect(await buildStaging()).toContain(SERVE_LAYER_MISSING);
  });

  it("its merge takes the designation live and moves the old home off /", async () => {
    const oldHome = await mainWithHome();
    const c = await chat("merge-home", "experiment");
    const created = await page(c.ctx, "merged-home");
    await op(c.ctx, "pages.set_home_page", { pageId: created });

    const merged = await execute(registry, adapter, SYS, "chat.merge_to_main", {
      chatSessionId: c.id,
    });
    expect(merged.ok).toBe(true);
    expect(await designations()).toMatchObject({ home: created, pending_home: null });
    expect(await storedPath(created)).toBe("/");
    expect(await storedPath(oldHome)).toBe(`/${PFX}home-now`);
    const rules = await asSystem((tx) => tx`SELECT 1 FROM redirects WHERE from_path = '/'`);
    expect(rules).toHaveLength(0);
  });

  it("a later designation of a main page takes over and the branch page leaves /", async () => {
    const oldHome = await mainWithHome();
    const c = await chat("change-of-mind", "experiment");
    const created = await page(c.ctx, "first-idea");
    await op(c.ctx, "pages.set_home_page", { pageId: created });
    await op(SYS, "pages.set_home_page", { pageId: oldHome });

    expect(await designations()).toMatchObject({ home: oldHome, pending_home: null });
    expect(await storedPath(created)).toBe(`/${PFX}first-idea`);
    const merged = await execute(registry, adapter, SYS, "chat.merge_to_main", {
      chatSessionId: c.id,
    });
    expect(merged.ok).toBe(true);
    expect(await storedPath(oldHome)).toBe("/");
  });
});

describe("set_not_found_page from a chat", () => {
  it("a page only a branch holds does not fail another chat's Stage, and the 404 stays", async () => {
    await mainWithHome();
    const current = await page(SYS, "missing-now");
    await op(SYS, "pages.set_not_found_page", { pageId: current });
    const c = await chat("nf", "experiment");
    const created = await page(c.ctx, "missing-next");
    await op(c.ctx, "pages.set_not_found_page", { pageId: created });

    expect(await designations()).toMatchObject({
      not_found: current,
      pending_not_found: created,
    });
    const seen = await op<{ defaults: { notFoundPageId: string | null } }>(
      c.ctx,
      "site_defaults.get",
      {},
    );
    expect(seen.defaults.notFoundPageId).toBe(created);
    expect(await buildStaging()).toContain(SERVE_LAYER_MISSING);
    expect(await builtFile("404.html")).toContain("The missing-now page.");

    await op(SYS, "chat.merge_to_main", { chatSessionId: c.id });
    expect(await designations()).toMatchObject({ not_found: created, pending_not_found: null });
    expect(await buildStaging()).toContain(SERVE_LAYER_MISSING);
    expect(await builtFile("404.html")).toContain("The missing-next page.");
  });

  it("a branch cannot make its pending home page the 404 page, or the reverse", async () => {
    await mainWithHome();
    const c = await chat("nf-home", "experiment");
    const home = await page(c.ctx, "both-home");
    const missing = await page(c.ctx, "both-missing");
    await op(c.ctx, "pages.set_home_page", { pageId: home });
    await op(c.ctx, "pages.set_not_found_page", { pageId: missing });
    const a = await execute(registry, adapter, c.ctx, "pages.set_not_found_page", { pageId: home });
    const b = await execute(registry, adapter, c.ctx, "pages.set_home_page", { pageId: missing });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });

  it("clearing the designation clears a pending one too", async () => {
    await mainWithHome();
    const c = await chat("nf-clear", "experiment");
    await op(c.ctx, "pages.set_not_found_page", { pageId: await page(c.ctx, "gone-soon") });
    await op(c.ctx, "pages.set_not_found_page", { pageId: null });
    expect(await designations()).toMatchObject({ not_found: null, pending_not_found: null });
  });
});
