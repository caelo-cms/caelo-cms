// SPDX-License-Identifier: MPL-2.0

/**
 * #1447 — a redirect rule on a page's URL, in either spelling.
 *
 * Real Postgres (§6). A move takes the rule over whether it is stored as
 * `/x` or `/x/` (imported tables store the slash), and every write that
 * leaves the two side by side says so with the next step: the page tools
 * after creating or publishing, the redirect tool after writing the rule.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { bulkCreateRedirectsTool } from "../ai/tools/bulk-create-redirects.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { duplicatePageTool } from "../ai/tools/duplicate-page.js";
import { setPagesStatusManyTool } from "../ai/tools/set-pages-status-many.js";
import type { RedirectPageConflict } from "../ops/redirects.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "redirect-on-page-int",
};

const PFX = "shadow1447";
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId: string;

const tools = (): ToolContext => ({ adapter, registry }) as ToolContext;

async function q<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
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

async function makePage(slug: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug: `${PFX}-${slug}`,
    title: `Title ${slug}`,
    templateId,
    status: "draft",
  });
  if (!r.ok) throw new Error(`page ${slug}: ${JSON.stringify(r.error)}`);
  return (r.value as { pageId: string }).pageId;
}

async function addRule(fromPath: string, toPath = `/${PFX}-target`): Promise<void> {
  const r = await execute(registry, adapter, SYSTEM, "redirects.create_many", {
    redirects: [{ fromPath, toPath }],
    upsert: true,
  });
  if (!r.ok) throw new Error(`rule ${fromPath}: ${JSON.stringify(r.error)}`);
}

async function rulesFrom(prefix: string): Promise<string[]> {
  const rows = (await q(
    (tx) =>
      tx`SELECT from_path FROM redirects WHERE from_path LIKE ${`${prefix}%`} ORDER BY from_path`,
  )) as unknown as { from_path: string }[];
  return rows.map((r) => r.from_path);
}

async function conflicts(input: unknown): Promise<RedirectPageConflict[]> {
  const r = await execute(registry, adapter, SYSTEM, "redirects.page_conflicts", input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { conflicts: RedirectPageConflict[] }).conflicts;
}

async function wipe(): Promise<void> {
  await q(async (tx) => {
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`%${PFX}-%`} OR to_path LIKE ${`%${PFX}-%`}`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
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
    displayName: "Shadow T",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  if (!tpl.ok) throw new Error("tpl seed");
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("a move onto a URL takes the redirect rule over", () => {
  it.each(["", "/"])("in the spelling '%s' too", async (slash) => {
    const name = slash === "" ? "bare" : "slash";
    const onPath = `/${PFX}-moved-${name}`;
    await addRule(`${onPath}${slash}`);
    const page = await makePage(`before-${name}`);

    const moved = await execute(registry, adapter, SYSTEM, "pages.update", {
      pageId: page,
      slug: `${PFX}-moved-${name}`,
    });

    expect(moved.ok).toBe(true);
    expect(await rulesFrom(onPath)).toEqual([]);
  });
});

describe("redirects.page_conflicts", () => {
  it("finds a rule by page and by path, in either spelling, and only then", async () => {
    const page = await makePage("found");
    const clear = await makePage("clear");
    const path = `/${PFX}-found`;
    await addRule(`${path}/`);

    expect((await conflicts({ pageIds: [page] })).map((c) => [c.fromPath, c.pagePath])).toEqual([
      [`${path}/`, path],
    ]);
    expect((await conflicts({ paths: [path] })).map((c) => c.pageId)).toEqual([page]);
    expect((await conflicts({ paths: [`${path}/`] })).map((c) => c.pageId)).toEqual([page]);
    expect(await conflicts({ pageIds: [clear] })).toEqual([]);
    expect(await conflicts({ paths: [`/${PFX}-nothing-here`] })).toEqual([]);
  });

  it("refuses a call naming neither or both", async () => {
    const neither = await execute(registry, adapter, SYSTEM, "redirects.page_conflicts", {});
    const both = await execute(registry, adapter, SYSTEM, "redirects.page_conflicts", {
      pageIds: [],
      paths: [],
    });
    expect(neither.ok).toBe(false);
    expect(both.ok).toBe(false);
  });
});

describe("write tools name the rule and the next step", () => {
  it("set_pages_status_many on publish, not on draft", async () => {
    const page = await makePage("publish");
    const rule = `/${PFX}-publish/`;
    await addRule(rule);

    const published = await setPagesStatusManyTool.handler(
      SYSTEM,
      { pageIds: [page], status: "published" },
      tools(),
    );
    const drafted = await setPagesStatusManyTool.handler(
      SYSTEM,
      { pageIds: [page], status: "draft" },
      tools(),
    );

    expect(published.content).toContain(`${rule} -> /${PFX}-target (301)`);
    expect(published.content).toContain(`bulk_delete_redirects({ fromPaths: ["${rule}"] })`);
    expect(drafted.content).not.toContain("bulk_delete_redirects");
  });

  it("duplicate_page when the copy lands on a rule", async () => {
    const source = await makePage("source");
    await addRule(`/${PFX}-copy`);

    const r = await duplicatePageTool.handler(
      SYSTEM,
      { sourcePageId: source, newSlug: `${PFX}-copy` },
      tools(),
    );

    expect(r.content).toContain(`bulk_delete_redirects({ fromPaths: ["/${PFX}-copy"] })`);
  });

  it("bulk_create_redirects when a rule lands on a page", async () => {
    await makePage("existing");
    const r = await bulkCreateRedirectsTool.handler(
      SYSTEM,
      {
        items: [
          { fromPath: `/${PFX}-existing/`, toPath: `/${PFX}-elsewhere`, statusCode: 301 },
          { fromPath: `/${PFX}-free`, toPath: `/${PFX}-elsewhere`, statusCode: 301 },
        ],
        upsert: false,
      },
      tools(),
    );

    expect(r.content).toContain(`"Title existing" (/${PFX}-existing, draft)`);
    expect(r.content).toContain(`bulk_delete_redirects({ fromPaths: ["/${PFX}-existing/"] })`);
    expect(r.content).not.toContain(`/${PFX}-free ->`);
  });

  it("says nothing when no rule sits on a page", async () => {
    const r = await bulkCreateRedirectsTool.handler(
      SYSTEM,
      {
        items: [{ fromPath: `/${PFX}-nopage`, toPath: `/${PFX}-elsewhere`, statusCode: 301 }],
        upsert: false,
      },
      tools(),
    );
    expect(r.content).not.toContain("bulk_delete_redirects");
  });
});
