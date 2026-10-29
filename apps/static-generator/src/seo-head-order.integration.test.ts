// SPDX-License-Identifier: MPL-2.0

/**
 * #1017 regression: the SEO block (title, meta description, canonical,
 * JSON-LD) was appended just before `</head>`, after every inline style
 * the layout carries, so a page's `<title>` sat tens of kilobytes into the
 * document — past what byte-limited crawlers and link-preview fetchers
 * read. A built page now carries it right after charset + viewport.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { generateSite, pageOutputPath } from "./generate.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "seo-head-order-test",
};

const PFX = `sho-${Date.now().toString(36)}`;
const TPL_SLUG = `${PFX}-tpl`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let baseBefore: string | null = null;
let languageBefore: string | null = null;

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
    await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
  });
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const row = await asSystem(
    (tx) => tx`SELECT site_base_url, site_language FROM site_defaults WHERE id = 1`,
  );
  const settings = row[0] as { site_base_url: string | null; site_language: string | null };
  baseBefore = settings.site_base_url;
  languageBefore = settings.site_language;
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = 'https://order.example', site_language = 'en' WHERE id = 1`,
  );
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: TPL_SLUG,
    displayName: `${PFX} TPL`,
    html:
      '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<style>${"body{margin:0}".repeat(500)}</style><title>Layout default</title></head>` +
      '<body><svg><title>Icon</title></svg><caelo-slot name="content">_</caelo-slot></body></html>',
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  const blocks = await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  if (!blocks.ok) throw new Error(`template blocks seed failed: ${JSON.stringify(blocks.error)}`);
});

afterAll(async () => {
  await wipe();
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = ${baseBefore}, site_language = ${languageBefore} WHERE id = 1`,
  );
  await adapter.close();
});

describe("built page head order (#1017)", () => {
  it("puts the SEO block after charset + viewport, before the inline CSS", async () => {
    const r = await execute(registry, adapter, SYSTEM, "pages.build_page", {
      page: { slug: `${PFX}-page`, title: `${PFX} Order`, templateId },
      modules: [
        {
          blockName: "content",
          displayName: `${PFX} Body`,
          description: "Page body.",
          kind: "content",
          html: '<section class="b"><p>{{body_text}}</p></section>',
          fields: [{ name: "body_text", kind: "text", label: "Body" }],
          content: { source: "inline", values: { body_text: "Hello" } },
        },
      ],
    });
    if (!r.ok) throw new Error(`build_page failed: ${JSON.stringify(r.error)}`);
    const pageId = (r.value as { pageId: string }).pageId;

    const root = mkdtempSync(join(tmpdir(), "caelo-seo-order-"));
    const runId = `${PFX}-run`;
    await adapter.withAdminTransaction(SYSTEM, (tx) =>
      generateSite({
        publishAt: new Date().toISOString(),
        tx,
        plugins: localBuildPluginServices,
        target: {
          id: "00000000-0000-0000-0000-0000000000a8",
          name: "dev",
          env: "dev",
          outDir: "out",
          baseUrl: "https://order.example",
          robotsDefault: "noindex",
        },
        runId,
        repoRoot: root,
        changedPageIds: [pageId],
      }),
    );
    const rows = await asSystem(
      (tx) => tx`SELECT current_path FROM pages WHERE id = ${pageId}::uuid`,
    );
    const currentPath = (rows[0] as { current_path: string }).current_path;
    const html = await readFile(
      join(root, "out", "builds", runId, pageOutputPath(currentPath)),
      "utf8",
    );

    const head = html.slice(html.indexOf("<head>") + "<head>".length);
    expect(head).toStartWith('<meta charset="utf-8">');
    const title = html.indexOf(`<title>${PFX} Order</title>`);
    expect(title).toBeGreaterThan(html.indexOf('<meta name="viewport"'));
    expect(title).toBeLessThan(html.indexOf("<style"));
    const stylesheet = html.indexOf('rel="stylesheet"');
    if (stylesheet !== -1) expect(title).toBeLessThan(stylesheet);
    expect(html).not.toContain("Layout default");
    expect(html).toContain("<svg><title>Icon</title></svg>");
  });
});
