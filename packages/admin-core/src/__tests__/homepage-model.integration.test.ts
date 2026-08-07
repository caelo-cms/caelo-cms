// SPDX-License-Identifier: MPL-2.0

/**
 * 0184 — explicit HOMEPAGE model + build_page import-linkage & idempotency.
 *
 * Covers:
 *  (a) `pages.set_home_page` writes `site_defaults.home_page_id`;
 *      resolveCanonicalUrl with `isHomePage:true` returns the site root.
 *  (b) build_page with `importPageId` stamps `import_pages.accepted_page_id`;
 *      a SECOND build with the same importPageId REBUILDS the same page (no
 *      duplicate).
 *  (c) the duplicate-URL backstop rejects a second page resolving to `/`
 *      (root-equivalence of magic slugs / designated home_page_id).
 *  (d) a slug soft-deleted ON THE CURRENT CHAT BRANCH can be reclaimed (2b).
 *
 * Runs against a real Postgres in the compose stack (CLAUDE.md §6).
 * The designation is a site-wide singleton since #384; the suite saves
 * and restores the pre-test value.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, resolveCanonicalUrl } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYS = "00000000-0000-0000-0000-00000000ffff";
const sysCtx: ExecutionContext = {
  actorId: SYS,
  actorKind: "system",
  requestId: "homepage-model-test",
};

const TS = Date.now().toString(36);
const TPL_SLUG = `hp-tpl-${TS}`;
const PFX = `hp-${TS}`;

let templateId = "";
let runId = "";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
      await tx`DELETE FROM import_pages WHERE source_url LIKE ${`https://${PFX}%`}`;
      await tx`DELETE FROM import_runs WHERE source_url LIKE ${`https://${PFX}%`}`;
      await tx`UPDATE site_defaults SET home_page_id = NULL WHERE id = 1 AND home_page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const run = await tx`INSERT INTO import_runs (source_url, proposed_by, status)
               VALUES (${`https://${PFX}.example.com`}, ${SYS}::uuid, 'ready_for_review')
               RETURNING id::text AS id`;
      runId = (run as unknown as { id: string }[])[0]!.id;
    });
  } finally {
    await sql.end();
  }

  const tpl = await execute(registry, adapter, sysCtx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "HP TPL",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, sysCtx, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

async function insertImportPage(sourcePath: string, slug: string): Promise<string> {
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx`INSERT INTO import_pages (run_id, source_url, proposed_slug, proposed_title)
               VALUES (${runId}::uuid, ${`https://${PFX}${sourcePath}`}, ${slug}, 'Imported')
               RETURNING id::text AS id`;
    });
    return (rows as unknown as { id: string }[])[0]!.id;
  } finally {
    await sql.end();
  }
}

async function acceptedPageIdFor(importPageId: string): Promise<string | null> {
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx`SELECT accepted_page_id::text AS pid FROM import_pages WHERE id = ${importPageId}::uuid`;
    });
    return (rows as unknown as { pid: string | null }[])[0]?.pid ?? null;
  } finally {
    await sql.end();
  }
}

async function clearDesignation(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE site_defaults SET home_page_id = NULL WHERE id = 1`;
    });
  } finally {
    await sql.end();
  }
}

async function designatedHomePageId(): Promise<string | null> {
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx`SELECT home_page_id::text AS hid FROM site_defaults WHERE id = 1`;
    });
    return (rows as unknown as { hid: string | null }[])[0]?.hid ?? null;
  } finally {
    await sql.end();
  }
}

describe("0184 (a) set_home_page + resolver", () => {
  it("resolveCanonicalUrl(isHomePage:true) returns the site root regardless of slug", () => {
    // Non-magic slug: without the flag it is a normal page URL...
    expect(
      resolveCanonicalUrl({
        siteBaseUrl: "https://example.com",
        pagePath: "/welcome",
        override: null,
      }),
    ).toBe("https://example.com/welcome/");
    // ...with the explicit designation it collapses to the site root.
    expect(
      resolveCanonicalUrl({
        siteBaseUrl: "https://example.com",
        pagePath: "/",
        override: null,
      }),
    ).toBe("https://example.com/");
  });

  it("pages.set_home_page writes site_defaults.home_page_id", async () => {
    const created = await execute(registry, adapter, sysCtx, "pages.build_page", {
      page: { slug: `${PFX}-welcome`, title: "Welcome", templateId },
      modules: [],
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const pageId = (created.value as { pageId: string }).pageId;

    const set = await execute(registry, adapter, sysCtx, "pages.set_home_page", { pageId });
    expect(set.ok).toBe(true);
    expect(await designatedHomePageId()).toBe(pageId);

    // get_with_modules surfaces the flag so the page-context can show it.
    const got = await execute(registry, adapter, sysCtx, "pages.get_with_modules", { pageId });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    expect((got.value as { page: { isHomePage: boolean } }).page.isHomePage).toBe(true);
    // #384 — the designation is a site-wide singleton now; release it
    // immediately so parallel test files creating 'home'-slug pages
    // don't collide with this file's designation.
    await clearDesignation();
  });

  it("set_home_page fails loudly for an unknown page id", async () => {
    const set = await execute(registry, adapter, sysCtx, "pages.set_home_page", {
      pageId: "00000000-0000-0000-0000-0000000000bb",
    });
    expect(set.ok).toBe(false);
  });
});

describe("0184 (b) build_page import linkage + idempotency", () => {
  it("stamps accepted_page_id and a second build rebuilds the same page", async () => {
    const importPageId = await insertImportPage("/about", `${PFX}-about`);

    const first = await execute(registry, adapter, sysCtx, "pages.build_page", {
      page: { slug: `${PFX}-about`, title: "About", templateId, importPageId },
      modules: [],
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const firstPageId = (first.value as { pageId: string; createdPage: boolean }).pageId;
    expect((first.value as { createdPage: boolean }).createdPage).toBe(true);
    // Linkage stamped.
    expect(await acceptedPageIdFor(importPageId)).toBe(firstPageId);

    // Second build for the SAME importPageId must NOT create a duplicate.
    const second = await execute(registry, adapter, sysCtx, "pages.build_page", {
      page: {
        slug: `${PFX}-about-again`,
        title: "About v2",
        templateId,
        importPageId,
      },
      modules: [],
    });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    expect((second.value as { pageId: string }).pageId).toBe(firstPageId);
    expect((second.value as { createdPage: boolean }).createdPage).toBe(false);

    // Exactly one page carries this linkage.
    const sql = new SQL(ADMIN_URL!);
    try {
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return await tx`SELECT count(*)::int AS n FROM import_pages WHERE accepted_page_id = ${firstPageId}::uuid`;
      });
      expect((rows as unknown as { n: number }[])[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("rejects an unknown importPageId (fail loudly, nothing written)", async () => {
    const r = await execute(registry, adapter, sysCtx, "pages.build_page", {
      page: {
        slug: `${PFX}-orphan`,
        title: "Orphan",
        templateId,
        importPageId: "00000000-0000-0000-0000-0000000000aa",
      },
      modules: [],
    });
    expect(r.ok).toBe(false);
  });
});

describe("0184 (c) duplicate-URL backstop", () => {
  it("rejects a second page that also resolves to the site root", async () => {
    // #384 — slug uniqueness is global, so this test avoids minting a
    // bare 'home' row (parallel test files own that namespace). Instead
    // it designates a PFX-scoped page as the root and asserts that a
    // magic-slug create is rejected as root-equivalent.
    const first = await execute(registry, adapter, sysCtx, "pages.build_page", {
      page: { slug: `${PFX}-rootholder`, title: "Root", templateId },
      modules: [],
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const rootId = (first.value as { pageId: string }).pageId;
    const set = await execute(registry, adapter, sysCtx, "pages.set_home_page", {
      pageId: rootId,
    });
    expect(set.ok).toBe(true);
    try {
      // `index` is magic-slug root-equivalent — both map to `/`.
      const second = await execute(registry, adapter, sysCtx, "pages.build_page", {
        page: { slug: "index", title: "Index", templateId },
        modules: [],
      });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(JSON.stringify(second.error)).toContain("site root");
      }
    } finally {
      await clearDesignation();
    }
  });
});

describe("0184 (e) preview canonical honours the designation end-to-end", () => {
  /** Extract the pathname of the first attribute matched by `re`. */
  function pathnameOf(html: string, re: RegExp): string {
    const m = re.exec(html);
    if (!m?.[1]) throw new Error(`no match for ${re} in preview html`);
    return new URL(m[1]).pathname;
  }
  const CANONICAL = /<link rel="canonical" href="([^"]+)"/;

  it("a page designated home on a NON-magic slug canonicalizes at the site root", async () => {
    const slug = `${PFX}-lander`;
    const created = await execute(registry, adapter, sysCtx, "pages.build_page", {
      page: { slug, title: "Lander", templateId },
      modules: [],
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const pageId = (created.value as { pageId: string }).pageId;

    // Published to mirror the deploy-path filter.
    const pub = await execute(registry, adapter, sysCtx, "pages.set_status", {
      pageId,
      status: "published",
    });
    expect(pub.ok).toBe(true);

    // Designate it as the homepage despite its non-magic slug.
    const set = await execute(registry, adapter, sysCtx, "pages.set_home_page", { pageId });
    expect(set.ok).toBe(true);

    const preview = await execute(registry, adapter, sysCtx, "pages.render_preview", { pageId });
    await clearDesignation();
    if (!preview.ok) throw new Error(JSON.stringify(preview.error));
    const html = (preview.value as { html: string }).html;

    expect(pathnameOf(html, CANONICAL)).toBe("/");
  });

  it("a normal (non-designated) page keeps its slug path in canonical", async () => {
    const slug = `${PFX}-plain`;
    const created = await execute(registry, adapter, sysCtx, "pages.build_page", {
      page: { slug, title: "Plain", templateId },
      modules: [],
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const pageId = (created.value as { pageId: string }).pageId;
    const pub = await execute(registry, adapter, sysCtx, "pages.set_status", {
      pageId,
      status: "published",
    });
    expect(pub.ok).toBe(true);

    const preview = await execute(registry, adapter, sysCtx, "pages.render_preview", { pageId });
    if (!preview.ok) throw new Error(JSON.stringify(preview.error));
    const html = (preview.value as { html: string }).html;

    // Unaffected: directory style → `/<slug>/`.
    expect(pathnameOf(html, CANONICAL)).toBe(`/${slug}/`);
  });
});

describe("0184 (d) branch-aware slug reclaim (2b)", () => {
  it("a slug deleted on the current chat branch can be recreated", async () => {
    const session = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}-branch`,
    });
    if (!session.ok) throw new Error(JSON.stringify(session.error));
    const branchCtx: ExecutionContext = {
      ...sysCtx,
      requestId: "hp-branch",
      chatBranchId: (session.value as { chatBranchId: string }).chatBranchId,
    };
    const slug = `${PFX}-reclaim`;

    const created = await execute(registry, adapter, branchCtx, "pages.create", {
      slug,
      title: "Reclaim",
      templateId,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const pageId = (created.value as { pageId: string }).pageId;

    // Branched soft-delete: leaves the live row, marks the deletion only
    // in the branch snapshot overlay.
    const del = await execute(registry, adapter, branchCtx, "pages.delete", {
      pageId,
      disposition: "404",
    });
    expect(del.ok).toBe(true);

    // Same slug, same branch — must succeed now that the prior page is
    // branch-deleted (would have collided before 2b).
    const recreated = await execute(registry, adapter, branchCtx, "pages.create", {
      slug,
      title: "Reclaimed",
      templateId,
    });
    expect(recreated.ok).toBe(true);
  });
});
