// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout G) — links follow renames and moves by reference.
 *
 * Authors write internal links as paths (`/about#team`); the write ops
 * store page references. A rename (`pages.update` slug) or a nested
 * subtree move (`pages.move_many`, epic #690) then:
 *
 * - rewrites NO stored text: module HTML and content values are
 *   byte-identical before and after;
 * - creates a 301 from every old URL (for links from outside the site);
 * - and the same stored references resolve to the NEW paths in the
 *   editor preview (`pages.render_preview`) and in the static build.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { type DeployTarget, generateSite, pageOutputPath } from "./generate.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "link-refs-moves-test",
};

const PFX = `lrm-${Date.now().toString(36)}`;
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let baseBefore: string | null = null;
let languageBefore: string | null = null;
const buildRoots: string[] = [];

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
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`/${PFX}%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`UPDATE pages SET parent_page_id = NULL WHERE slug LIKE ${`${PFX}%`}`;
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
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = 'https://moves.example', site_language = 'en' WHERE id = 1`,
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
  for (const root of buildRoots) rmSync(root, { recursive: true, force: true });
});

const TEXT = [{ name: "body_text", kind: "text", label: "Body" }];

/** A published page with one body module; `parentPageId` nests it (#690). */
async function buildPage(
  slug: string,
  opts: {
    parentPageId?: string;
    html?: string;
    values?: Record<string, unknown>;
    fields?: { name: string; kind: string; label: string }[];
  } = {},
): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.build_page", {
    page: {
      slug,
      title: `${PFX} ${slug}`,
      templateId,
      status: "published",
      ...(opts.parentPageId ? { parentPageId: opts.parentPageId } : {}),
    },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} ${slug} Body`,
        description: "Page body.",
        kind: "content",
        html: opts.html ?? "<p>{{body_text}}</p>",
        fields: opts.fields ?? TEXT,
        content: { source: "inline", values: opts.values ?? { body_text: slug } },
      },
    ],
  });
  if (!r.ok) throw new Error(`build_page ${slug}: ${JSON.stringify(r.error)}`);
  return (r.value as { pageId: string }).pageId;
}

/** Everything a move could have text-rewritten for one page's modules. */
async function storedLinkState(pageId: string): Promise<string> {
  const rows = await asSystem(
    (tx) => tx`
      SELECT m.html, ci."values"::text AS values
      FROM page_modules pm
      JOIN modules m ON m.id = pm.module_id
      LEFT JOIN content_instances ci ON ci.id = pm.content_instance_id
      WHERE pm.page_id = ${pageId}::uuid
      ORDER BY m.slug`,
  );
  return JSON.stringify(rows);
}

async function redirectTo(fromPath: string): Promise<{ to: string; status: number } | null> {
  const rows = (await asSystem(
    (tx) => tx`SELECT to_path, status_code FROM redirects WHERE from_path = ${fromPath}`,
  )) as { to_path: string; status_code: number | string }[];
  const r = rows[0];
  return r ? { to: r.to_path, status: Number(r.status_code) } : null;
}

async function previewHtml(pageId: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.render_preview", { pageId });
  if (!r.ok) throw new Error(`render_preview: ${JSON.stringify(r.error)}`);
  const v = r.value as { html: string; missingSlots: string[] };
  expect(v.missingSlots.filter((m) => m.startsWith("link-"))).toEqual([]);
  return v.html;
}

async function buildHtml(pageId: string, pagePath: string, runId: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "caelo-link-refs-moves-"));
  buildRoots.push(root);
  const target: DeployTarget = {
    id: "00000000-0000-0000-0000-0000000000b9",
    name: "staging",
    env: "staging",
    outDir: "out",
    baseUrl: "https://moves.example",
    robotsDefault: "noindex",
    pageUrlStyle: "directory",
  };
  await adapter.withAdminTransaction(SYSTEM, (tx) =>
    generateSite({
      tx,
      adapter,
      plugins: localBuildPluginServices,
      target,
      runId,
      repoRoot: root,
      changedPageIds: [pageId],
    }),
  );
  return readFile(join(root, "out", "builds", runId, pageOutputPath(pagePath)), "utf8");
}

const LINKS_FIELDS = [
  { name: "cta_href", kind: "url", label: "CTA link" },
  { name: "more", kind: "link-list", label: "More links" },
];
const LINKS_HTML =
  '<nav><a href="{{cta_href}}">CTA</a>{{#more}}<a href="{{href}}">{{label}}</a>{{/more}}</nav>';

describe("links follow a rename by reference", () => {
  it("keeps stored text, creates the 301 and resolves to the new path in preview and build", async () => {
    const about = await buildPage(`${PFX}-about`);
    const oldPath = `/${PFX}-about`;
    // Written as paths, the way the AI and the operator write them.
    const linker = await buildPage(`${PFX}-linker`, {
      html: `<p><a href="${oldPath}#team">Team</a></p>${LINKS_HTML}`,
      values: { cta_href: oldPath, more: [{ label: "About", href: `${oldPath}#history` }] },
      fields: LINKS_FIELDS,
    });
    const before = await storedLinkState(linker);
    expect(before).toContain(`caelo:page/${about}`);
    expect(before).not.toContain(oldPath);

    const r = await execute(registry, adapter, SYSTEM, "pages.update", {
      pageId: about,
      slug: `${PFX}-about-us`,
    });
    expect(r.ok).toBe(true);
    const newPath = `/${PFX}-about-us`;

    // No text rewrite: the stored references are untouched.
    expect(await storedLinkState(linker)).toBe(before);
    // The 301 is for links from outside the site.
    expect(await redirectTo(oldPath)).toEqual({ to: newPath, status: 301 });

    for (const html of [
      await previewHtml(linker),
      await buildHtml(linker, `/${PFX}-linker`, `${PFX}-run-rename`),
    ]) {
      expect(html).toContain(`href="${newPath}/#team"`);
      expect(html).toContain(`<a href="${newPath}/">CTA</a>`);
      expect(html).toContain(`<a href="${newPath}/#history">About</a>`);
      // The new slug extends the old one, so match the old path exactly.
      expect(html).not.toContain(`href="${oldPath}/`);
      expect(html).not.toContain(`href="${oldPath}#`);
      expect(html).not.toContain("caelo:page/");
    }
  });
});

describe("links follow a nested subtree move by reference (#690)", () => {
  it("keeps stored text, creates a 301 per moved URL and resolves the moved subtree", async () => {
    const section = await buildPage(`${PFX}-section`);
    const guide = await buildPage(`${PFX}-guide`);
    const step = await buildPage(`${PFX}-step`, { parentPageId: guide });
    const oldGuide = `/${PFX}-guide`;
    const oldStep = `${oldGuide}/${PFX}-step`;
    const linker = await buildPage(`${PFX}-index`, {
      html: `<p><a href="${oldStep}">Step</a></p>${LINKS_HTML}`,
      values: { cta_href: oldGuide, more: [{ label: "Step", href: oldStep }] },
      fields: LINKS_FIELDS,
    });
    const before = await storedLinkState(linker);
    expect(before).toContain(`caelo:page/${guide}`);
    expect(before).toContain(`caelo:page/${step}`);

    const r = await execute(registry, adapter, SYSTEM, "pages.move_many", {
      moves: [{ pageId: guide, parentPageId: section }],
    });
    expect(r.ok).toBe(true);
    const v = r.value as { moved: { from: string; to: string }[]; redirectsCreated: number };
    const newGuide = `/${PFX}-section/${PFX}-guide`;
    const newStep = `${newGuide}/${PFX}-step`;
    expect(v.moved.map((m) => m.to).sort()).toEqual([newGuide, newStep].sort());
    expect(v.redirectsCreated).toBe(2);
    // The op reports no rewrite counters any more: nothing is rewritten.
    expect(Object.keys(v).sort()).toEqual(["moved", "pendingPublish", "redirectsCreated"]);

    expect(await storedLinkState(linker)).toBe(before);
    expect(await redirectTo(oldGuide)).toEqual({ to: newGuide, status: 301 });
    expect(await redirectTo(oldStep)).toEqual({ to: newStep, status: 301 });

    for (const html of [
      await previewHtml(linker),
      await buildHtml(linker, `/${PFX}-index`, `${PFX}-run-move`),
    ]) {
      expect(html).toContain(`<a href="${newStep}/">Step</a></p>`);
      expect(html).toContain(`<a href="${newGuide}/">CTA</a>`);
      expect(html).toContain(`<a href="${newStep}/">Step</a></nav>`);
      expect(html).not.toContain(`href="${oldGuide}`);
      expect(html).not.toContain("caelo:page/");
    }
  });
});
