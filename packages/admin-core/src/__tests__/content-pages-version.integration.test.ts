// SPDX-License-Identifier: MPL-2.0

/**
 * Optimistic concurrency on pages.
 *   - Loading a page returns its current version.
 *   - pages.update + pages.set_modules accept expectedVersion; on match they
 *     bump the row's version atomically.
 *   - On mismatch they return Err HandlerError with a "conflict" message and
 *     leave the page untouched.
 *   - When expectedVersion is omitted, the op behaves as before (last write
 *     wins) — preserves the old call sites until they migrate.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "content-pages-version-test",
};

const TPL_SLUG = "p3-version-tpl";
const PAGE_SLUG = "p3-version-page";
const MOD_SLUG = "p3-version-mod";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

let templateId = "";
let moduleId = "";

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "T",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error("tpl seed");
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, systemCtx, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });

  const m = await execute(registry, adapter, systemCtx, "modules.create", {
    slug: MOD_SLUG,
    displayName: "M",
    html: "<p>x</p>",
  });
  if (!m.ok) throw new Error("module seed");
  moduleId = (m.value as { moduleId: string }).moduleId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("pages optimistic concurrency", () => {
  it("a fresh page starts at version 0; pages.update bumps to 1", async () => {
    const create = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUG,
      title: "Initial",
      templateId,
    });
    if (!create.ok) throw new Error("page seed");
    const pageId = (create.value as { pageId: string }).pageId;

    const before = await execute(registry, adapter, systemCtx, "pages.get", { pageId });
    if (!before.ok) return;
    expect((before.value as { page: { version: number } }).page.version).toBe(0);

    const upd = await execute(registry, adapter, systemCtx, "pages.update", {
      pageId,
      expectedVersion: 0,
      title: "Renamed",
    });
    expect(upd.ok).toBe(true);

    const after = await execute(registry, adapter, systemCtx, "pages.get", { pageId });
    if (!after.ok) return;
    const page = (after.value as { page: { version: number; title: string } }).page;
    expect(page.version).toBe(1);
    expect(page.title).toBe("Renamed");
  });

  it("pages.update with a stale expectedVersion is rejected and leaves the row alone", async () => {
    const list = await execute(registry, adapter, systemCtx, "pages.list", {});
    if (!list.ok) return;
    const page = (
      list.value as { pages: { id: string; slug: string; title: string; version: number }[] }
    ).pages.find((p) => p.slug === PAGE_SLUG);
    expect(page).toBeTruthy();
    if (!page) return;

    const stale = await execute(registry, adapter, systemCtx, "pages.update", {
      pageId: page.id,
      expectedVersion: 0, // current is 1 from previous test
      title: "Should not land",
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect((stale.error as { message: string }).message).toMatch(/conflict/);

    const reload = await execute(registry, adapter, systemCtx, "pages.get", { pageId: page.id });
    if (!reload.ok) return;
    const reloaded = (reload.value as { page: { title: string; version: number } }).page;
    expect(reloaded.title).toBe("Renamed");
    expect(reloaded.version).toBe(1);
  });

  it("pages.set_modules bumps version too and respects expectedVersion", async () => {
    const list = await execute(registry, adapter, systemCtx, "pages.list", {});
    if (!list.ok) return;
    const page = (
      list.value as { pages: { id: string; slug: string; version: number }[] }
    ).pages.find((p) => p.slug === PAGE_SLUG);
    if (!page) return;
    const v = page.version;

    const ok1 = await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId: page.id,
      expectedVersion: v,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    expect(ok1.ok).toBe(true);

    const after = await execute(registry, adapter, systemCtx, "pages.get", { pageId: page.id });
    if (!after.ok) return;
    expect((after.value as { page: { version: number } }).page.version).toBe(v + 1);

    // Stale set_modules now fails.
    const stale = await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId: page.id,
      expectedVersion: v, // already bumped
      blocks: [],
    });
    expect(stale.ok).toBe(false);
  });

  it("expectedVersion is optional — omitting it preserves last-write-wins", async () => {
    const list = await execute(registry, adapter, systemCtx, "pages.list", {});
    if (!list.ok) return;
    const page = (list.value as { pages: { id: string; slug: string }[] }).pages.find(
      (p) => p.slug === PAGE_SLUG,
    );
    if (!page) return;

    const r = await execute(registry, adapter, systemCtx, "pages.update", {
      pageId: page.id,
      title: "No-token write",
    });
    expect(r.ok).toBe(true);
  });
});
