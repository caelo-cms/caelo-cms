// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #690 — the static build of nested pages that share a slug.
 *
 * `/<a>/<x>` and `/<b>/<x>` are different pages with the SAME slug. The
 * build must emit each at its own composed path with its own content
 * and its own canonical — every per-page pass (SEO, plugin bakes) keys
 * by page id, never by slug.
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
  requestId: "nested-pages-build-test",
};

const PFX = `npb-${Date.now().toString(36)}`;
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
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
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
  // A build needs both (canonical origin, <html lang>); restored after.
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = 'https://nested.example', site_language = 'en' WHERE id = 1`,
  );
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: `${PFX}-tpl`,
    displayName: `${PFX} TPL`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await wipe();
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = ${baseBefore}, site_language = ${languageBefore} WHERE id = 1`,
  );
  await adapter.close();
});

async function buildPage(slug: string, text: string, parentPageId?: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.build_page", {
    page: {
      slug,
      title: `${PFX} ${text}`,
      templateId,
      status: "published",
      ...(parentPageId ? { parentPageId } : {}),
    },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} ${text} Body`,
        description: "Page body text.",
        kind: "content",
        html: '<p class="body">{{body_text}}</p>',
        fields: [{ name: "body_text", kind: "text", label: "Body" }],
        content: { source: "inline", values: { body_text: text } },
      },
    ],
  });
  if (!r.ok) throw new Error(`build_page ${slug}: ${JSON.stringify(r.error)}`);
  return (r.value as { pageId: string }).pageId;
}

describe("static build — nested pages sharing a slug", () => {
  it("emits each at its own path with its own content and canonical", async () => {
    const a = await buildPage(`${PFX}-a`, "Section A");
    const b = await buildPage(`${PFX}-b`, "Section B");
    const underA = await buildPage(`${PFX}-x`, "Child of A", a);
    const underB = await buildPage(`${PFX}-x`, "Child of B", b);

    const root = mkdtempSync(join(tmpdir(), "caelo-nested-pages-build-"));
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
          baseUrl: "https://nested.example",
          robotsDefault: "noindex",
        },
        runId,
        repoRoot: root,
        changedPageIds: [underA, underB],
      }),
    );
    const buildDir = join(root, "out", "builds", runId);
    for (const [text, parent] of [
      ["Child of A", `${PFX}-a`],
      ["Child of B", `${PFX}-b`],
    ] as const) {
      const path = `/${parent}/${PFX}-x`;
      const html = await readFile(join(buildDir, pageOutputPath(path)), "utf8");
      expect(html).toContain(`>${text}</p>`);
      expect(html).toContain(`https://nested.example${path}`);
    }
  });
});
