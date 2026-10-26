// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout D) — the link-resolve composition point, end to end
 * against a real Postgres with international-site answering it.
 *
 * One English page carries an internal link in every place a link can
 * live — module HTML `href`, a `link` field, a list entry, rich text —
 * and the layout carries a menu module with a links list. All of them were written as
 * paths and stored as page references (rollout C). Its German version
 * (create_variant copies the references verbatim) must link to the
 * GERMAN pages, identically in the editor preview (which live-edit
 * renders through) and in the static build; the English page keeps its
 * English links. A link to a page without a German version is flagged in
 * the preview (`link-variant-missing:page/<id>:de`) and refuses the
 * build — never shipped as a link into English.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  localBuildPluginServices,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { type DeployTarget, generateSite, pageOutputPath } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t724d",
};
const PFX = "t724d";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;
const buildRoots: string[] = [];

const ids = {
  enAbout: "",
  enPricing: "",
  enSolo: "",
  enLinks: "",
  deUeber: "",
  dePreise: "",
  deLinks: "",
};

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe(`DELETE FROM redirects WHERE from_path LIKE '%${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM layout_modules WHERE layout_id IN (SELECT id FROM layouts WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(
      `DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE '%${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM modules WHERE slug LIKE '%${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${PFX}-%'`);
  });
}

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS_CTX, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function op<T>(operationName: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

async function preview(pageId: string): Promise<{ html: string; missingSlots: string[] }> {
  const r = await sysOp<{ html: string; missingSlots: string[] }>("pages.render_preview", {
    pageId,
  });
  return { ...r, html: unstamp(r.html) };
}

let navModuleId = "";

const menuEntries = (items: { label: string; href: string }[]) =>
  items.map(({ label, href }, i) => ({
    id: `00000000-0000-4000-9000-${String(i + 1).padStart(12, "0")}`,
    node: "link",
    values: { label, link: { href } },
  }));

/**
 * The layout menu's entries: a chrome module whose links list renders
 * from its default, and its German chrome variant (a menu is translatable
 * site chrome, so the German pages need one) with the same links.
 */
async function setNav(items: { label: string; href: string }[]): Promise<void> {
  await setMenuModule(items);
  if (germanChrome) {
    await op("set_chrome_variants", {
      variants: [
        {
          targetKey: `layout:${menuLayoutId}:header:0`,
          localeCode: "de",
          values: { menu: menuEntries(items) },
        },
      ],
    });
  }
}

/** Set once the locales exist (the plugin keeps chrome variants per locale). */
let germanChrome = false;
let menuLayoutId = "";

async function setMenuModule(items: { label: string; href: string }[]): Promise<void> {
  const fields = [
    {
      name: "menu",
      kind: "list",
      listType: "links",
      label: "Main menu",
      default: menuEntries(items),
    },
  ];
  if (navModuleId) {
    await sysOp("modules.update", { moduleId: navModuleId, fields });
    return;
  }
  navModuleId = (
    await sysOp<{ moduleId: string }>("modules.create", {
      slug: `${PFX}-main-menu`,
      displayName: "Main menu",
      html: '<nav><ul>{{#menu}}<li><a href="{{link}}">{{label}}</a></li>{{/menu}}</ul></nav>',
      css: "",
      js: "",
      fields,
    })
  ).moduleId;
}

const unstamp = (html: string) => html.replace(/ data-caelo-list-item="[^"]*"/g, "");

function stagingTarget(): DeployTarget {
  return {
    id: "00000000-0000-0000-0000-0000000000d4",
    name: "staging",
    env: "staging",
    outDir: "out",
    baseUrl: "https://example.com",
    robotsDefault: "noindex",
    pageUrlStyle: "directory",
  };
}

/** Run a staging build of `pageIds`; returns the build dir. */
async function build(pageIds: string[], runId: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "caelo-link-resolve-"));
  buildRoots.push(root);
  await adapter.withAdminTransaction(SYS_CTX, (tx) =>
    generateSite({
      publishAt: new Date().toISOString(),
      tx,
      adapter,
      plugins: localBuildPluginServices,
      target: stagingTarget(),
      runId,
      repoRoot: root,
      changedPageIds: pageIds,
    }),
  );
  return join(root, "out", "builds", runId);
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  restoreBase = await pinSiteBaseUrl(ADMIN_URL, "https://example.com");
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "en");
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));

  const { layoutId } = await sysOp<{ layoutId: string }>("layouts.create", {
    slug: `${PFX}-layout`,
    displayName: "T724D layout",
    html: '<body><caelo-slot name="header"></caelo-slot><caelo-slot name="content"></caelo-slot></body>',
    css: "",
    blocks: [
      { name: "header", displayName: "Header", position: 0 },
      { name: "content", displayName: "Content", position: 1 },
    ],
  });
  const { templateId } = await sysOp<{ templateId: string }>("templates.create", {
    slug: `${PFX}-tpl`,
    displayName: "T724D",
    html: '<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
    css: "",
    layoutId,
  });
  await sysOp("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });

  const page = async (slug: string) =>
    (
      await sysOp<{ pageId: string }>("pages.create", {
        slug: `${PFX}-${slug}`,
        title: slug,
        templateId,
      })
    ).pageId;
  ids.enAbout = await page("about");
  ids.enPricing = await page("pricing");
  ids.enSolo = await page("solo");

  // Every place a link can live, written as paths (canonicalised to
  // references by the write path, rollout C).
  const links = await sysOp<{ pageId: string }>("pages.build_page", {
    page: { slug: `${PFX}-links`, title: "Links", templateId, status: "draft" },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} links body`,
        description: "Links in every shape.",
        kind: "content",
        html:
          `<div><a class="h" href="/${PFX}-about">About</a><a class="f" href="{{cta_href}}">CTA</a>` +
          '{{#nav}}<a class="l" href="{{link}}">{{label}}</a>{{/nav}}<div class="r">{{body}}</div></div>',
        fields: [
          { name: "cta_href", kind: "link", label: "CTA link" },
          { name: "nav", kind: "list", listType: "links", label: "More" },
          { name: "body", kind: "richtext", label: "Body" },
        ],
        content: {
          source: "inline",
          values: {
            cta_href: `/${PFX}-pricing#plans`,
            nav: [
              {
                id: "00000000-0000-4000-9000-000000000101",
                node: "link",
                values: { label: "Pricing", link: { href: `/${PFX}-pricing` } },
              },
            ],
            body: `<p>Read <a href="/${PFX}-about?ref=body">about us</a></p>`,
          },
        },
      },
    ],
  });
  ids.enLinks = links.pageId;

  // The layout's menu: a chrome module with a links list.
  await setNav([{ label: "About", href: `/${PFX}-about` }]);
  await sysOp("layout_modules.set", { layoutId, blockName: "header", moduleIds: [navModuleId] });
  menuLayoutId = layoutId;

  await op("set_locales", {
    locales: [
      { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
    ],
  });
  germanChrome = true;
  await setNav([{ label: "About", href: `/${PFX}-about` }]);
  const variant = async (sourcePageId: string, slug: string) =>
    (
      await op<{ pageId: string }>("create_variant", {
        sourcePageId,
        localeCode: "de",
        slug: `${PFX}-${slug}`,
      })
    ).pageId;
  ids.deUeber = await variant(ids.enAbout, "ueber");
  ids.dePreise = await variant(ids.enPricing, "preise");
  ids.deLinks = await variant(ids.enLinks, "verweise");
  for (const id of Object.values(ids)) {
    await sysOp("pages.set_status", { pageId: id, status: "published" });
  }
}, 60_000);

afterAll(async () => {
  for (const root of buildRoots) rmSync(root, { recursive: true, force: true });
  await cleanup();
  await restoreBase?.();
  await restoreLanguage?.();
  await adapter.close();
});

/** What the German links page must link to, wherever the link lives. */
function expectGermanLinks(stamped: string): void {
  const html = unstamp(stamped);
  expect(html).toContain(`<a class="h" href="/de/${PFX}-ueber/">About</a>`);
  expect(html).toContain(`<a class="f" href="/de/${PFX}-preise/#plans">CTA</a>`);
  expect(html).toContain(`<a class="l" href="/de/${PFX}-preise/">Pricing</a>`);
  expect(html).toContain(`<a href="/de/${PFX}-ueber/?ref=body">about us</a>`);
  expect(html).toContain(`<li><a href="/de/${PFX}-ueber/">About</a></li>`);
  expect(html).not.toContain("caelo:page/");
}

/** And the English page keeps its English links. */
function expectEnglishLinks(stamped: string): void {
  const html = unstamp(stamped);
  expect(html).toContain(`<a class="h" href="/${PFX}-about/">About</a>`);
  expect(html).toContain(`<a class="f" href="/${PFX}-pricing/#plans">CTA</a>`);
  expect(html).toContain(`<a class="l" href="/${PFX}-pricing/">Pricing</a>`);
  expect(html).toContain(`<a href="/${PFX}-about/?ref=body">about us</a>`);
  expect(html).toContain(`<li><a href="/${PFX}-about/">About</a></li>`);
  expect(html).not.toContain("caelo:page/");
}

describe("#724 D — internal links go to the rendering page's language", () => {
  it("stores the copied links as references to the ENGLISH pages (nothing rewritten per language)", async () => {
    const rows = await sqlSystem(
      (tx) => tx`
        SELECT ci."values"::text AS v FROM page_modules pm
        JOIN content_instances ci ON ci.id = pm.content_instance_id
        WHERE pm.page_id = ${ids.deLinks}::uuid`,
    );
    const stored = (rows as { v: string }[]).map((r) => r.v).join("");
    expect(stored).toContain(`caelo:page/${ids.enPricing}#plans`);
    expect(stored).toContain(`caelo:page/${ids.enAbout}?ref=body`);
  });

  it("preview: HTML href, link field, list entries, rich text and the chrome menu resolve per language", async () => {
    const de = await preview(ids.deLinks);
    expect(de.missingSlots.filter((m) => m.startsWith("link-"))).toEqual([]);
    expectGermanLinks(de.html);
    const en = await preview(ids.enLinks);
    expect(en.missingSlots.filter((m) => m.startsWith("link-"))).toEqual([]);
    expectEnglishLinks(en.html);
  }, 60_000);

  it("static build: the same links as the preview, per language", async () => {
    const dir = await build([ids.enLinks, ids.deLinks], `${PFX}-run1`);
    expectGermanLinks(await readFile(join(dir, pageOutputPath(`/de/${PFX}-verweise`)), "utf8"));
    expectEnglishLinks(await readFile(join(dir, pageOutputPath(`/${PFX}-links`)), "utf8"));
  }, 120_000);

  it("a link to a page with no German version is flagged in the preview and refuses the build", async () => {
    await setNav([
      { label: "About", href: `/${PFX}-about` },
      { label: "Solo", href: `/${PFX}-solo` },
    ]);
    try {
      const marker = `link-variant-missing:page/${ids.enSolo}:de`;
      const de = await preview(ids.deLinks);
      expect(de.missingSlots).toContain(marker);
      // Not shipped as a link into English.
      expect(de.html).not.toContain(`href="/${PFX}-solo/"`);
      // The English page links to its own language's page, unflagged.
      const en = await preview(ids.enLinks);
      expect(en.missingSlots.filter((m) => m.startsWith("link-"))).toEqual([]);
      expect(en.html).toContain(`<li><a href="/${PFX}-solo/">Solo</a></li>`);

      await expect(build([ids.deLinks], `${PFX}-run2`)).rejects.toThrow(marker);
    } finally {
      await setNav([{ label: "About", href: `/${PFX}-about` }]);
    }
  }, 120_000);
});

describe("#724 D — links.canonicalise_values (plugin write-path building block)", () => {
  const call = (actorKind: ExecutionContext["actorKind"], input: unknown) =>
    execute(registry, adapter, { ...SYS_CTX, actorKind }, "links.canonicalise_values", input);
  const fields = [{ name: "cta_href", kind: "url" }];

  it("canonicalises a path to a page reference", async () => {
    const r = await call("system", { fields, values: { cta_href: `/${PFX}-about#team` } });
    expect(r.ok && r.value).toEqual({ values: { cta_href: `caelo:page/${ids.enAbout}#team` } });
  });

  it("refuses a path that names no page with an actionable message", async () => {
    const r = await call("system", { fields, values: { cta_href: `/${PFX}-nowhere` } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("HandlerError");
    expect((r.error as { message: string }).message).toContain(`/${PFX}-nowhere`);
  });

  it("is not callable by the AI or a human directly", async () => {
    for (const actorKind of ["ai", "human"] as const) {
      const r = await call(actorKind, { fields, values: { cta_href: `/${PFX}-about` } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("ActorScopeRejected");
    }
  });

  it("caps the number of value keys", async () => {
    const values = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`k${i}`, "x"]));
    const r = await call("system", { fields: [], values });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("ValidationFailed");
  });
});
