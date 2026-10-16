// SPDX-License-Identifier: MPL-2.0

/**
 * 0284 (#802) — explicit 404 page designation.
 *
 *  - `pages.set_not_found_page` writes `site_defaults.not_found_page_id`,
 *    `site_defaults.get` and `pages.get_with_modules` surface it, and
 *    `pageId: null` clears it.
 *  - unknown ids fail loudly; the homepage cannot be the 404 page, and
 *    `pages.set_home_page` refuses the 404 page.
 *
 * Runs against a real Postgres in the compose stack (CLAUDE.md §6). Both
 * designations are site-wide singletons; the suite saves and restores the
 * pre-test values.
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

const SYS = "00000000-0000-0000-0000-00000000ffff";
const sysCtx: ExecutionContext = { actorId: SYS, actorKind: "system", requestId: "nf-page-test" };
const aiCtx: ExecutionContext = { actorId: SYS, actorKind: "ai", requestId: "nf-page-test-ai" };

const TS = Date.now().toString(36);
const TPL_SLUG = `nf-tpl-${TS}`;
const PFX = `nf-${TS}`;

let templateId = "";
let saved: { home: string | null; notFound: string | null } = { home: null, notFound: null };

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function designations(): Promise<{ home: string | null; notFound: string | null }> {
  const rows = (await withSql(
    (tx) =>
      tx`SELECT home_page_id::text AS home, not_found_page_id::text AS not_found FROM site_defaults WHERE id = 1`,
  )) as unknown as { home: string | null; not_found: string | null }[];
  return { home: rows[0]?.home ?? null, notFound: rows[0]?.not_found ?? null };
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`UPDATE site_defaults SET not_found_page_id = NULL WHERE id = 1 AND not_found_page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`UPDATE site_defaults SET home_page_id = NULL WHERE id = 1 AND home_page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
    await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
  });
}

async function buildPage(suffix: string): Promise<string> {
  const created = await execute(registry, adapter, sysCtx, "pages.build_page", {
    page: { slug: `${PFX}-${suffix}`, title: suffix, templateId },
    modules: [],
  });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return (created.value as { pageId: string }).pageId;
}

beforeAll(async () => {
  await wipe();
  saved = await designations();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const tpl = await execute(registry, adapter, sysCtx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "NF TPL",
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
  await withSql(
    (tx) =>
      tx`UPDATE site_defaults SET home_page_id = ${saved.home}::uuid, not_found_page_id = ${saved.notFound}::uuid WHERE id = 1`,
  );
  await wipe();
  await adapter.close();
});

describe("0284 pages.set_not_found_page", () => {
  it("the AI designates a page, the read surfaces show it, null clears it", async () => {
    const pageId = await buildPage("missing");
    const set = await execute(registry, adapter, aiCtx, "pages.set_not_found_page", { pageId });
    expect(set.ok).toBe(true);
    expect((await designations()).notFound).toBe(pageId);

    const defaults = await execute(registry, adapter, sysCtx, "site_defaults.get", {});
    if (!defaults.ok) throw new Error(JSON.stringify(defaults.error));
    expect(
      (defaults.value as { defaults: { notFoundPageId: string | null } | null }).defaults
        ?.notFoundPageId,
    ).toBe(pageId);

    const got = await execute(registry, adapter, sysCtx, "pages.get_with_modules", { pageId });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    const page = (got.value as { page: { isNotFoundPage: boolean; isHomePage: boolean } }).page;
    expect(page.isNotFoundPage).toBe(true);
    expect(page.isHomePage).toBe(false);

    // set_home_page refuses the 404 page and names the next step.
    const home = await execute(registry, adapter, sysCtx, "pages.set_home_page", { pageId });
    expect(home.ok).toBe(false);
    if (!home.ok) expect(JSON.stringify(home.error)).toContain("set_not_found_page");

    const cleared = await execute(registry, adapter, aiCtx, "pages.set_not_found_page", {
      pageId: null,
    });
    expect(cleared.ok).toBe(true);
    expect((await designations()).notFound).toBeNull();
  });

  it("fails loudly for an unknown page id", async () => {
    const set = await execute(registry, adapter, sysCtx, "pages.set_not_found_page", {
      pageId: "00000000-0000-0000-0000-0000000000cc",
    });
    expect(set.ok).toBe(false);
  });

  it("refuses the homepage", async () => {
    const pageId = await buildPage("front");
    await withSql((tx) => tx`UPDATE site_defaults SET home_page_id = ${pageId}::uuid WHERE id = 1`);
    try {
      const set = await execute(registry, adapter, sysCtx, "pages.set_not_found_page", { pageId });
      expect(set.ok).toBe(false);
      if (!set.ok) expect(JSON.stringify(set.error)).toContain("homepage");
    } finally {
      await withSql(
        (tx) => tx`UPDATE site_defaults SET home_page_id = ${saved.home}::uuid WHERE id = 1`,
      );
    }
  });
});
