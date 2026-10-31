// SPDX-License-Identifier: MPL-2.0

/**
 * A slug change moves a page's public URL, so `pages.update` must ALWAYS keep
 * the old URL alive (301) — for the singular path AND the `pages.update_many`
 * bulk path, in one transaction. Links on the site follow the page because
 * they are page references (epic #724); nothing rewrites them.
 *
 * Regression cover for the bug this file was written against: the redirect
 * logic used to live in the `change_page_slug` TOOL as a chain of
 * separate execute() calls, so `pages.update_many` — the path the AI is
 * explicitly steered to for multi-page edits — wrote the slug and produced ZERO
 * redirects, silently stranding every inbound link. The bulk case below is the
 * test that would have caught it.
 *
 * Real Postgres per CLAUDE.md §6 (no mocked PG for Query API tests). Driven with
 * a `system` actor so the AI cold-start gate doesn't interfere; the handler
 * chain is identical.
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
  requestId: "slug-redirect-int",
};

const PFX = "slugredir";
const TPL_SLUG = `${PFX}-tpl`;

let templateId: string;

/**
 * Redirect rows currently pointing out of `fromPath`.
 *
 * `SET LOCAL caelo.actor_kind` is not optional: RLS is FORCEd on every table
 * and the policy keys off that setting, so a raw read without it returns zero
 * rows and reads as "no redirect was created" — a false green (or here, a
 * false red) rather than an error.
 */
async function redirectsFrom(
  fromPath: string,
): Promise<{ to_path: string; status_code: number }[]> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx`
        SELECT to_path, status_code FROM redirects WHERE from_path = ${fromPath}
      `) as unknown as { to_path: string; status_code: number }[];
    });
  } finally {
    await sql.end();
  }
}

async function makePage(slug: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug,
    title: `T ${slug}`,
    templateId,
  });
  if (!r.ok) throw new Error(`page seed ${slug}`);
  return (r.value as { pageId: string }).pageId;
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM redirects WHERE from_path LIKE ${`/${PFX}-%`} OR to_path LIKE ${`/${PFX}-%`}`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    pageType: "home",
    slug: TPL_SLUG,
    displayName: "Slug T",
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

describe("pages.update — a slug change always creates the 301", () => {
  it("singular slug change creates a 301 from the old path", async () => {
    const pageId = await makePage(`${PFX}-single-old`);
    const r = await execute(registry, adapter, SYSTEM, "pages.update", {
      pageId,
      slug: `${PFX}-single-new`,
    });
    expect(r.ok).toBe(true);

    const reds = await redirectsFrom(`/${PFX}-single-old`);
    expect(reds).toHaveLength(1);
    expect(reds[0]?.to_path).toBe(`/${PFX}-single-new`);
    expect(Number(reds[0]?.status_code)).toBe(301);
  });

  it("redirectFromOld='skip' suppresses the 301 (explicit opt-out only)", async () => {
    const pageId = await makePage(`${PFX}-skip-old`);
    const r = await execute(registry, adapter, SYSTEM, "pages.update", {
      pageId,
      slug: `${PFX}-skip-new`,
      redirectFromOld: "skip",
    });
    expect(r.ok).toBe(true);
    expect(await redirectsFrom(`/${PFX}-skip-old`)).toHaveLength(0);
  });

  it("a non-slug edit (title only) creates NO redirect", async () => {
    const pageId = await makePage(`${PFX}-title-only`);
    const r = await execute(registry, adapter, SYSTEM, "pages.update", {
      pageId,
      title: "Retitled",
    });
    expect(r.ok).toBe(true);
    expect(await redirectsFrom(`/${PFX}-title-only`)).toHaveLength(0);
  });

  it("re-setting the SAME slug is a no-op — no self-redirect", async () => {
    const slug = `${PFX}-same`;
    const pageId = await makePage(slug);
    const r = await execute(registry, adapter, SYSTEM, "pages.update", { pageId, slug });
    expect(r.ok).toBe(true);
    expect(await redirectsFrom(`/${slug}`)).toHaveLength(0);
  });
});

describe("pages.update_many — bulk slug changes create per-page 301s (the regression)", () => {
  it("every slug in the batch gets its own 301", async () => {
    const a = await makePage(`${PFX}-bulk-a-old`);
    const b = await makePage(`${PFX}-bulk-b-old`);

    const r = await execute(registry, adapter, SYSTEM, "pages.update_many", {
      updates: [
        { pageId: a, slug: `${PFX}-bulk-a-new` },
        { pageId: b, slug: `${PFX}-bulk-b-new` },
      ],
    });
    expect(r.ok).toBe(true);
    expect((r.value as { updated: number }).updated).toBe(2);

    // Before the fix this was [] for both — the bulk path wrote the slug and
    // silently shipped no redirect at all.
    const ra = await redirectsFrom(`/${PFX}-bulk-a-old`);
    const rb = await redirectsFrom(`/${PFX}-bulk-b-old`);
    expect(ra).toHaveLength(1);
    expect(ra[0]?.to_path).toBe(`/${PFX}-bulk-a-new`);
    expect(Number(ra[0]?.status_code)).toBe(301);
    expect(rb).toHaveLength(1);
    expect(rb[0]?.to_path).toBe(`/${PFX}-bulk-b-new`);
  });

  it("a mixed batch redirects only the pages whose slug actually moved", async () => {
    const moved = await makePage(`${PFX}-mixed-moved-old`);
    const renamed = await makePage(`${PFX}-mixed-renamed`);

    const r = await execute(registry, adapter, SYSTEM, "pages.update_many", {
      updates: [
        { pageId: moved, slug: `${PFX}-mixed-moved-new` },
        { pageId: renamed, title: "Just a new title" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(await redirectsFrom(`/${PFX}-mixed-moved-old`)).toHaveLength(1);
    expect(await redirectsFrom(`/${PFX}-mixed-renamed`)).toHaveLength(0);
  });
});

describe("pages.update — links follow a slug change", () => {
  // Since #724 a link stores a reference to the page, so the read shows
  // the new path without any text rewrite.
  it("a module link that pointed at the old URL shows the new one", async () => {
    const pageId = await makePage(`${PFX}-nav-old`);
    const seeded = await execute(registry, adapter, SYSTEM, "modules.create", {
      slug: `${PFX}-menu`,
      displayName: "Main",
      // External: this file seeds no homepage for "/" to name (#724).
      html: `<nav><a href="https://example.com/">Home</a><a href="/${PFX}-nav-old">Target</a>{{note}}</nav>`,
      // Declared fields: the extractor would otherwise lift the links out.
      fields: [{ name: "note", kind: "text", label: "Note" }],
    });
    if (!seeded.ok) throw new Error("seed module");
    const moduleId = (seeded.value as { moduleId: string }).moduleId;

    const r = await execute(registry, adapter, SYSTEM, "pages.update", {
      pageId,
      slug: `${PFX}-nav-new`,
    });
    expect(r.ok).toBe(true);

    const got = await execute(registry, adapter, SYSTEM, "modules.get", { moduleId });
    if (!got.ok) throw new Error("get module");
    const html = (got.value as { module: { html: string } }).module.html;
    expect(html).toContain(`<a href="/${PFX}-nav-new">Target</a>`);
    // Untouched links stay untouched.
    expect(html).toContain('<a href="https://example.com/">Home</a>');
  });
});
