// SPDX-License-Identifier: MPL-2.0

/**
 * #1447 — a redirect rule on a page's URL, in either spelling.
 *
 * Real Postgres (§6). A move of a main-line page takes the rule over whether
 * it is stored as `/x` or `/x/` (imported tables store the slash), and every
 * write that leaves the two side by side says so with the next step: the
 * page tools after creating or publishing, the redirect tool after writing
 * the rule.
 *
 * #1517 — a page only a chat's branch holds moves without live effects (the
 * rule stays, no 301 from a URL that was never public), a page that was
 * never live is told that Publish live takes its URL over, and no write
 * leaves `/x` and `/x/` with different targets (the plan would refuse the
 * table and stop every sync).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { buildRedirectPlan, type ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { bulkCreateRedirectsTool } from "../ai/tools/bulk-create-redirects.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { duplicatePageTool } from "../ai/tools/duplicate-page.js";
import { setPagesStatusManyTool } from "../ai/tools/set-pages-status-many.js";
import type { RedirectPageConflict } from "../ops/content/redirect-page-conflicts.js";
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
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}-%`}`;
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

/** Mark `pageId` as shipped by a Publish live before. */
async function markLive(pageId: string): Promise<void> {
  await q((tx) => tx`UPDATE pages SET first_published_at = now() WHERE id = ${pageId}::uuid`);
}

/** A chat on the site draft, and the context its writes carry. */
async function openChat(title: string): Promise<ExecutionContext> {
  const session = await execute(registry, adapter, SYSTEM, "chat.create_session", {
    title: `${PFX}-${title}`,
  });
  if (!session.ok) throw new Error(JSON.stringify(session.error));
  const { chatSessionId, chatBranchId } = session.value as {
    chatSessionId: string;
    chatBranchId: string;
  };
  return { ...SYSTEM, chatBranchId, chatTaskId: chatSessionId };
}

describe("a page only a chat's branch holds moves without live effects (#1517)", () => {
  it("a slug change of a chat's new page leaves the rule on its new URL and writes no 301", async () => {
    const chat = await openChat("draft-rename");
    const created = await execute(registry, adapter, chat, "pages.create", {
      slug: `${PFX}-draft-before`,
      title: "Draft before",
      templateId,
      status: "draft",
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const page = (created.value as { pageId: string }).pageId;
    await addRule(`/${PFX}-draft-after/`);

    const renamed = await execute(registry, adapter, chat, "pages.update", {
      pageId: page,
      slug: `${PFX}-draft-after`,
    });
    if (!renamed.ok) throw new Error(JSON.stringify(renamed.error));
    const refreshed = await execute(registry, adapter, chat, "pages.refresh_current_path", {
      pageId: page,
    });
    if (!refreshed.ok) throw new Error(JSON.stringify(refreshed.error));

    expect(await rulesFrom(`/${PFX}-draft-after`)).toEqual([`/${PFX}-draft-after/`]);
    expect(await rulesFrom(`/${PFX}-draft-before`)).toEqual([]);
    const r = await execute(registry, adapter, chat, "redirects.page_conflicts", {
      pageIds: [page],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(
      (r.value as { conflicts: RedirectPageConflict[] }).conflicts.map((c) => [
        c.fromPath,
        c.pageLive,
      ]),
    ).toEqual([[`/${PFX}-draft-after/`, false]]);
  });
});

describe("one address, one rule: /x and /x/ never point two ways (#1517)", () => {
  const plan = async (prefix: string) => {
    const rows = (await q(
      (tx) => tx`
        SELECT from_path, to_path, status_code FROM redirects
        WHERE from_path LIKE ${`${prefix}%`} ORDER BY from_path`,
    )) as unknown as { from_path: string; to_path: string; status_code: number }[];
    return buildRedirectPlan({
      rows: rows.map((r) => ({
        fromPath: r.from_path,
        toPath: r.to_path,
        statusCode: r.status_code,
      })),
      pageUrlStyle: "directory",
      servedFiles: new Set(),
    });
  };

  it("create_many counts the other spelling as existing, and upsert replaces it", async () => {
    const path = `/${PFX}-spelled`;
    await addRule(`${path}/`, `/${PFX}-first`);

    const plain = await execute(registry, adapter, SYSTEM, "redirects.create_many", {
      redirects: [{ fromPath: path, toPath: `/${PFX}-second` }],
    });
    if (!plain.ok) throw new Error(JSON.stringify(plain.error));
    expect(plain.value).toEqual({ created: 0, updated: 0, skipped: 1 });
    expect(await rulesFrom(path)).toEqual([`${path}/`]);
    expect((await plan(path)).redirects.map((r) => r.location)).toEqual([`/${PFX}-first/`]);

    const upsert = await execute(registry, adapter, SYSTEM, "redirects.create_many", {
      redirects: [{ fromPath: path, toPath: `/${PFX}-second` }],
      upsert: true,
    });
    if (!upsert.ok) throw new Error(JSON.stringify(upsert.error));
    expect(upsert.value).toEqual({ created: 0, updated: 1, skipped: 0 });
    expect(await rulesFrom(path)).toEqual([`${path}/`]);
    expect((await plan(path)).redirects.map((r) => r.location)).toEqual([`/${PFX}-second/`]);
  });

  it("upsert folds both stored spellings into one row", async () => {
    const path = `/${PFX}-twice`;
    await addRule(path, `/${PFX}-first`);
    await q(
      (tx) => tx`
        INSERT INTO redirects (from_path, to_path, status_code, created_by)
        VALUES (${`${path}/`}, ${`/${PFX}-first`}, 301, ${SYSTEM.actorId}::uuid)`,
    );

    const r = await execute(registry, adapter, SYSTEM, "redirects.create_many", {
      redirects: [{ fromPath: `${path}/`, toPath: `/${PFX}-second` }],
      upsert: true,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(await rulesFrom(path)).toEqual([`${path}/`]);
    expect((await plan(path)).redirects.map((r) => r.location)).toEqual([`/${PFX}-second/`]);
  });

  it("redirects.create (a slug change's 301) replaces the other spelling", async () => {
    const path = `/${PFX}-single`;
    await addRule(`${path}/`, `/${PFX}-first`);

    const r = await execute(registry, adapter, SYSTEM, "redirects.create", {
      fromPath: path,
      toPath: `/${PFX}-second`,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(await rulesFrom(path)).toEqual([path]);
    expect((await plan(path)).redirects.map((r) => r.location)).toEqual([`/${PFX}-second/`]);
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

  it("names both rows when both spellings are stored", async () => {
    const page = await makePage("both");
    await addRule(`/${PFX}-both`);
    // Stored as an import leaves it: no op writes the second spelling.
    await q(
      (tx) => tx`
        INSERT INTO redirects (from_path, to_path, status_code, created_by)
        VALUES (${`/${PFX}-both/`}, ${`/${PFX}-target`}, 301, ${SYSTEM.actorId}::uuid)`,
    );
    expect((await conflicts({ pageIds: [page] })).map((c) => c.fromPath)).toEqual([
      `/${PFX}-both`,
      `/${PFX}-both/`,
    ]);
  });

  it("leaves the 404 page out: its own path is free for a rule", async () => {
    const page = await makePage("notfound");
    await addRule(`/${PFX}-notfound`);
    const set = await execute(registry, adapter, SYSTEM, "pages.set_not_found_page", {
      pageId: page,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    try {
      expect(await conflicts({ pageIds: [page] })).toEqual([]);
    } finally {
      await q((tx) => tx`UPDATE site_defaults SET not_found_page_id = NULL WHERE id = 1`);
    }
  });

  it("sees a chat's pending rename: the URL it is leaving, and the one it takes", async () => {
    const page = await makePage("branch-old");
    const session = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      title: `${PFX}-branch`,
    });
    if (!session.ok) throw new Error(JSON.stringify(session.error));
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    const chat: ExecutionContext = { ...SYSTEM, chatBranchId, chatTaskId: chatSessionId };
    const renamed = await execute(registry, adapter, chat, "pages.update", {
      pageId: page,
      slug: `${PFX}-branch-new`,
    });
    if (!renamed.ok) throw new Error(JSON.stringify(renamed.error));
    await addRule(`/${PFX}-branch-old`);
    await addRule(`/${PFX}-branch-new/`);

    const forChat = async (input: unknown) => {
      const r = await execute(registry, adapter, chat, "redirects.page_conflicts", input);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return (r.value as { conflicts: RedirectPageConflict[] }).conflicts.map((c) => c.fromPath);
    };
    expect(await forChat({ pageIds: [page] })).toEqual([`/${PFX}-branch-new/`]);
    expect(await forChat({ paths: [`/${PFX}-branch-new`] })).toEqual([`/${PFX}-branch-new/`]);
    expect(await forChat({ paths: [`/${PFX}-branch-old`] })).toEqual([]);
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
    await markLive(page);
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

  // #1517 — a copy is a new page: Publish live takes the URL over, and an
  // early delete would leave the live URL answering 404 until then.
  it("duplicate_page when the copy lands on a rule: Publish live takes it over", async () => {
    const source = await makePage("source");
    await addRule(`/${PFX}-copy`);

    const r = await duplicatePageTool.handler(
      SYSTEM,
      { sourcePageId: source, newSlug: `${PFX}-copy` },
      tools(),
    );

    expect(r.content).toContain(`/${PFX}-copy -> /${PFX}-target (301)`);
    expect(r.content).toContain("that Publish live deletes the rule");
    expect(r.content).toContain("Do not delete the rule before then");
    expect(r.content).not.toContain("bulk_delete_redirects");
  });

  it("bulk_create_redirects when a rule lands on a page", async () => {
    await markLive(await makePage("existing"));
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

  it("bulk_create_redirects on a never-live page's URL says Publish live takes it over", async () => {
    await makePage("fresh");
    const r = await bulkCreateRedirectsTool.handler(
      SYSTEM,
      {
        items: [{ fromPath: `/${PFX}-fresh`, toPath: `/${PFX}-elsewhere`, statusCode: 301 }],
        upsert: false,
      },
      tools(),
    );
    expect(r.content).toContain(`"Title fresh" (/${PFX}-fresh, draft), which was never live`);
    expect(r.content).toContain("that Publish live deletes the rule");
    expect(r.content).not.toContain("bulk_delete_redirects");
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
