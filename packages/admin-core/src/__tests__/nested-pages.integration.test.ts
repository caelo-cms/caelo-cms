// SPDX-License-Identifier: MPL-2.0

/**
 * Nested page URLs (epic #690, migration 0263) against a real Postgres:
 *
 * - a page created under a parent composes "/<parent path>/<slug>";
 * - `pages.move_many` moves a page AND its subtree in one transaction:
 *   current_path, a 301 per moved URL, chain collapse, nav-menu and
 *   module link rewrites;
 * - a parent rename cascades to every descendant;
 * - structural refusals (cycle, depth > 6, homepage as parent / nested
 *   homepage, deleting a page with children) change nothing and name the
 *   next step;
 * - inside a chat a move is pending (pages.list shows the chat's paths,
 *   live paths stay) and goes live — with its 301s — at merge;
 * - revert_page restores the parent.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "nested-pages-int",
};

const PFX = "nest690";
let templateId: string;

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

async function pathOf(pageId: string): Promise<string> {
  const rows = (await q(
    (tx) => tx`SELECT current_path FROM pages WHERE id = ${pageId}::uuid`,
  )) as unknown as { current_path: string }[];
  return rows[0]?.current_path ?? "<missing>";
}

async function redirectTo(fromPath: string): Promise<string | null> {
  const rows = (await q(
    (tx) => tx`SELECT to_path FROM redirects WHERE from_path = ${fromPath}`,
  )) as unknown as { to_path: string }[];
  return rows[0]?.to_path ?? null;
}

async function makePage(
  slug: string,
  parentPageId?: string,
  ctx: ExecutionContext = SYSTEM,
): Promise<string> {
  const r = await execute(registry, adapter, ctx, "pages.create", {
    slug: `${PFX}-${slug}`,
    title: slug,
    templateId,
    ...(parentPageId ? { parentPageId } : {}),
  });
  if (!r.ok) throw new Error(`page ${slug}: ${JSON.stringify(r.error)}`);
  return (r.value as { pageId: string }).pageId;
}

async function move(
  moves: { pageId: string; parentPageId: string | null; newSlug?: string }[],
  ctx: ExecutionContext = SYSTEM,
) {
  return execute(registry, adapter, ctx, "pages.move_many", { moves });
}

function errMsg(r: { ok: boolean; error?: unknown }): string {
  return r.ok ? "" : String((r.error as { message?: string }).message ?? "");
}

async function wipe(): Promise<void> {
  await q(async (tx) => {
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`%${PFX}-%`} OR to_path LIKE ${`%${PFX}-%`}`;
    await tx`DELETE FROM structured_sets WHERE slug LIKE ${`${PFX}-%`}`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}-%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
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
    slug: `${PFX}-tpl`,
    displayName: "Nest T",
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

describe("nested page URLs — create + compose", () => {
  it("a page created under a parent composes the ancestor chain", async () => {
    const sec = await makePage("sec");
    const child = await makePage("child", sec);
    const grand = await makePage("grand", child);
    expect(await pathOf(child)).toBe(`/${PFX}-sec/${PFX}-child`);
    expect(await pathOf(grand)).toBe(`/${PFX}-sec/${PFX}-child/${PFX}-grand`);

    const listed = await execute(registry, adapter, SYSTEM, "pages.list", { underPageId: sec });
    if (!listed.ok) throw new Error("list");
    const rows = (
      listed.value as { pages: { id: string; depth: number; parentPageId: string | null }[] }
    ).pages;
    expect(rows.map((r) => r.id).sort()).toEqual([child, grand].sort());
    expect(rows.find((r) => r.id === grand)?.depth).toBe(3);
    expect(rows.find((r) => r.id === child)?.parentPageId).toBe(sec);
  });
});

describe("nested page URLs — pages.move_many", () => {
  it("moves a subtree with 301s, nav + module link rewrites, chain collapse", async () => {
    const target = await makePage("tgt");
    const page = await makePage("mv");
    const sub = await makePage("mv-sub", page);
    const oldPage = `/${PFX}-mv`;
    const oldSub = `/${PFX}-mv/${PFX}-mv-sub`;
    // An older redirect pointing at the page's current URL must not
    // become a chain.
    await q(
      (tx) => tx`INSERT INTO redirects (from_path, to_path, status_code, created_by)
      VALUES (${`/${PFX}-legacy`}, ${oldPage}, 301, ${SYSTEM.actorId}::uuid)`,
    );
    const nav = await execute(registry, adapter, SYSTEM, "structured_sets.set", {
      kind: "nav-menu",
      slug: `${PFX}-nav`,
      displayName: "Nav",
      items: [{ label: "Mv", href: oldPage, children: [{ label: "Sub", href: oldSub }] }],
    });
    expect(nav.ok).toBe(true);
    const mod = await execute(registry, adapter, SYSTEM, "modules.create", {
      slug: `${PFX}-links`,
      displayName: "Links",
      html: `<a href="${oldSub}">sub</a><a href="${oldPage}-x">look-alike</a>`,
      fields: [{ name: "body", kind: "text", label: "Body" } as never],
    });
    if (!mod.ok) throw new Error("module seed");
    const moduleId = (mod.value as { moduleId: string }).moduleId;

    const r = await move([{ pageId: page, parentPageId: target }]);
    expect(r.ok).toBe(true);
    const newPage = `/${PFX}-tgt/${PFX}-mv`;
    const newSub = `${newPage}/${PFX}-mv-sub`;
    expect(await pathOf(page)).toBe(newPage);
    expect(await pathOf(sub)).toBe(newSub);
    expect(await redirectTo(oldPage)).toBe(newPage);
    expect(await redirectTo(oldSub)).toBe(newSub);
    expect(await redirectTo(`/${PFX}-legacy`)).toBe(newPage);
    if (r.ok) {
      const moved = (r.value as { moved: { from: string; to: string }[] }).moved;
      expect(moved.map((m) => m.to).sort()).toEqual([newPage, newSub].sort());
    }

    const setRows = (await q(
      (tx) => tx`SELECT items FROM structured_sets WHERE slug = ${`${PFX}-nav`}`,
    )) as unknown as { items: unknown }[];
    const items = JSON.stringify(setRows[0]?.items);
    expect(items).toContain(newPage);
    expect(items).toContain(newSub);
    const html = (
      (await q((tx) => tx`SELECT html FROM modules WHERE id = ${moduleId}::uuid`)) as unknown as {
        html: string;
      }[]
    )[0]?.html;
    expect(html).toContain(`href="${newSub}"`);
    expect(html).toContain(`href="${oldPage}-x"`);

    // Moving back: the page reclaims its old URL — the redirect sitting
    // on it yields instead of shadowing the page.
    const back = await move([{ pageId: page, parentPageId: null }]);
    expect(back.ok).toBe(true);
    expect(await pathOf(page)).toBe(oldPage);
    expect(await redirectTo(oldPage)).toBeNull();
    expect(await redirectTo(newPage)).toBe(oldPage);
  });

  it("a parent rename cascades to every descendant", async () => {
    const p = await makePage("ren");
    const c = await makePage("ren-c", p);
    const r = await execute(registry, adapter, SYSTEM, "pages.update", {
      pageId: p,
      slug: `${PFX}-renamed`,
    });
    expect(r.ok).toBe(true);
    expect(await pathOf(c)).toBe(`/${PFX}-renamed/${PFX}-ren-c`);
    expect(await redirectTo(`/${PFX}-ren/${PFX}-ren-c`)).toBe(`/${PFX}-renamed/${PFX}-ren-c`);
  });

  it("refuses cycles, excess depth and a taken slug — changing nothing", async () => {
    const a = await makePage("cyc-a");
    const b = await makePage("cyc-b", a);
    const cyc = await move([{ pageId: a, parentPageId: b }]);
    expect(cyc.ok).toBe(false);
    expect(errMsg(cyc)).toMatch(/loop/);
    expect(await pathOf(a)).toBe(`/${PFX}-cyc-a`);

    let parent = await makePage("d1");
    for (let i = 2; i <= 6; i++) parent = await makePage(`d${i}`, parent);
    const tooDeep = await execute(registry, adapter, SYSTEM, "pages.create", {
      slug: `${PFX}-d7`,
      title: "d7",
      templateId,
      parentPageId: parent,
    });
    expect(tooDeep.ok).toBe(false);
    expect(errMsg(tooDeep)).toMatch(/at most 6 levels/);

    const taken = await move([{ pageId: b, parentPageId: null, newSlug: `${PFX}-cyc-a` }]);
    expect(taken.ok).toBe(false);
    expect(errMsg(taken)).toMatch(/newSlug/);
  });

  it("the plan dry run reports every URL a move would change", async () => {
    const p = await makePage("plan");
    await makePage("plan-c", p);
    const target = await makePage("plan-t");
    const r = await execute(registry, adapter, SYSTEM, "pages.plan_moves", {
      moves: [{ pageId: p, parentPageId: target }],
    });
    if (!r.ok) throw new Error("plan");
    const v = r.value as { ok: boolean; moved: unknown[] };
    expect(v.ok).toBe(true);
    expect(v.moved.length).toBe(2);
    expect(await pathOf(p)).toBe(`/${PFX}-plan`);
  });
});

describe("nested page URLs — homepage + delete rules", () => {
  it("the homepage can neither have nor be a parent", async () => {
    const homeRows = (await q(
      (tx) => tx`SELECT home_page_id::text AS id FROM site_defaults WHERE id = 1`,
    )) as unknown as { id: string | null }[];
    const home = homeRows[0]?.id ?? (await makePage("home-cand"));
    if (!homeRows[0]?.id) {
      const set = await execute(registry, adapter, SYSTEM, "pages.set_home_page", { pageId: home });
      expect(set.ok).toBe(true);
    }
    const p = await makePage("under-home");
    const asParent = await move([{ pageId: p, parentPageId: home }]);
    expect(asParent.ok).toBe(false);
    expect(errMsg(asParent)).toMatch(/cannot be a parent/);
    const asChild = await move([{ pageId: home, parentPageId: p }]);
    expect(asChild.ok).toBe(false);
    expect(errMsg(asChild)).toMatch(/homepage/);

    const nested = await makePage("nested-home", p);
    const designate = await execute(registry, adapter, SYSTEM, "pages.set_home_page", {
      pageId: nested,
    });
    expect(designate.ok).toBe(false);
    expect(errMsg(designate)).toMatch(/top-level/);
  });

  it("deleting a page with children is refused unless the caller decides", async () => {
    const p = await makePage("del");
    const c = await makePage("del-c", p);
    const refused = await execute(registry, adapter, SYSTEM, "pages.delete", { pageId: p });
    expect(refused.ok).toBe(false);
    expect(errMsg(refused)).toMatch(/move-up/);

    const up = await execute(registry, adapter, SYSTEM, "pages.delete", {
      pageId: p,
      children: "move-up",
    });
    expect(up.ok).toBe(true);
    expect(await pathOf(c)).toBe(`/${PFX}-del-c`);
    expect(await redirectTo(`/${PFX}-del/${PFX}-del-c`)).toBe(`/${PFX}-del-c`);

    // delete_many deleting a parent together with all its children needs
    // no decision.
    const p2 = await makePage("del2");
    const c2 = await makePage("del2-c", p2);
    const many = await execute(registry, adapter, SYSTEM, "pages.delete_many", {
      deletions: [{ pageId: p2 }, { pageId: c2 }],
    });
    if (!many.ok) throw new Error("delete_many");
    expect((many.value as { deleted: number }).deleted).toBe(2);
  });
});

describe("nested page URLs — chat branch + publish + revert", () => {
  it("a move in a chat is pending until merge, then goes live with 301s", async () => {
    const target = await makePage("br-t");
    const page = await makePage("br");
    const session = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      isolation: "experiment",
      title: `${PFX}-chat`,
    });
    if (!session.ok) throw new Error(`session ${JSON.stringify(session.error)}`);
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    const chatCtx: ExecutionContext = { ...SYSTEM, chatBranchId, chatTaskId: chatSessionId };

    const r = await move([{ pageId: page, parentPageId: target }], chatCtx);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as { pendingPublish: boolean }).pendingPublish).toBe(true);
    // Live URL unchanged; the chat sees the new one.
    expect(await pathOf(page)).toBe(`/${PFX}-br`);
    const listed = await execute(registry, adapter, chatCtx, "pages.list", {});
    if (!listed.ok) throw new Error("list");
    const inChat = (listed.value as { pages: { id: string; currentPath: string }[] }).pages.find(
      (p) => p.id === page,
    );
    expect(inChat?.currentPath).toBe(`/${PFX}-br-t/${PFX}-br`);

    const merged = await execute(registry, adapter, SYSTEM, "chat.merge_to_main", {
      chatSessionId,
    });
    expect(merged.ok).toBe(true);
    expect(await pathOf(page)).toBe(`/${PFX}-br-t/${PFX}-br`);
    expect(await redirectTo(`/${PFX}-br`)).toBe(`/${PFX}-br-t/${PFX}-br`);

    // revert_page to the pre-move snapshot restores the parent + URL.
    const snaps = (await q(
      (tx) => tx`
        SELECT ps.site_snapshot_id::text AS id
        FROM page_snapshots ps JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
        WHERE ps.page_id = ${page}::uuid AND ss.op_kind = 'pages.create'
        ORDER BY ss.created_at ASC LIMIT 1`,
    )) as unknown as { id: string }[];
    const createdSnap = snaps[0]?.id;
    if (!createdSnap) throw new Error("no create snapshot");
    const rev = await execute(registry, adapter, SYSTEM, "snapshots.revert_page", {
      snapshotId: createdSnap,
      pageId: page,
    });
    expect(rev.ok).toBe(true);
    expect(await pathOf(page)).toBe(`/${PFX}-br`);
  });
});
