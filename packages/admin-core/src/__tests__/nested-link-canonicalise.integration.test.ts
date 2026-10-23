// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1028 — an internal link inside a rich-text value is stored as a
 * page reference on every content write, whatever else the write carries.
 *
 * The searchVIU report: a `module-list` article body whose entries were
 * minted by `build_page` as detached entries and attached with
 * `set_page_module_content`. One entry (only a rich-text field) kept the
 * literal `/de/ratgeber/schema-markup-ki` and rendered it without the
 * site's trailing slash; a sibling entry rendered its link canonically.
 *
 * Root cause: `canonicaliseInstanceValues` skipped the write when a cheap
 * probe said "no link here". The probe read every value as a whole-value
 * URL field, and that reading never looks inside HTML — so a write whose
 * only links sat in rich text skipped canonicalisation entirely. The
 * sibling entry also carried a whole-value link (a `url` field), which
 * made the probe ask for the lookup, and then the real run (with the real
 * field kinds) converted its rich text too. Nesting was incidental.
 *
 * Covered here, against a real Postgres (CLAUDE.md §6):
 *   - build_page detached entries (rich text only) store references and
 *     render the canonical `/<path>/`, identical to a sibling with a url
 *     field;
 *   - the searchVIU shape: detached entries attached afterwards through
 *     set_page_module_content;
 *   - set_content_instance_values and set_values_many on a nested instance;
 *   - existing literal data: the references check flags the literal in the
 *     nested entry with a fix that converts it, and the fix converts it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { buildPageTool } from "../ai/tools/build-page.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { setPageModuleContentTool } from "../ai/tools/set-page-module-content.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "i1028-nested-link-canonicalise",
};

const PFX = `i1028-${Date.now().toString(36)}`;
const TARGET_SLUG = `${PFX}-schema-markup-ki`;
const TARGET_PATH = `/${TARGET_SLUG}`;
const ENTRY_TYPE = `${PFX}-baustein`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let targetId = "";

const toolCtx = () => ({ adapter, registry }) as ToolContext;

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

async function run<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYSTEM, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function storedValues(instanceId: string): Promise<Record<string, unknown>> {
  const rows = await asSystem(
    (tx) => tx`SELECT "values" FROM content_instances WHERE id = ${instanceId}::uuid`,
  );
  const v = (rows as { values: unknown }[])[0]?.values;
  return (typeof v === "string" ? JSON.parse(v) : v) as Record<string, unknown>;
}

async function renderPage(pageId: string): Promise<string> {
  return (await run<{ html: string }>("pages.render_preview", { pageId })).html;
}

/** The rich-text-only entry ("Ratgeber: Hinweis-Box"). */
function boxEntry(ref: string, displayName: string, linkHref: string) {
  return {
    ref,
    displayName,
    description: "Note box inside an article body.",
    kind: "content" as const,
    type: ENTRY_TYPE,
    html: '<div class="rg-box">{{inhalt_html}}</div>',
    fields: [{ name: "inhalt_html", kind: "richtext", label: "Inhalt" }],
    content: {
      source: "inline" as const,
      values: { inhalt_html: `<p>Der <a href="${linkHref}">Test</a> umfasst 40 Seiten.</p>` },
    },
  };
}

/** The entry with a whole-value link next to its rich text ("Produkt-Hinweis"). */
function productEntry(ref: string, displayName: string) {
  return {
    ref,
    displayName,
    description: "Product note with a call-to-action link.",
    kind: "content" as const,
    type: ENTRY_TYPE,
    html: '<aside>{{text_html}}<a class="tlink" href="{{cta_href}}">Demo</a></aside>',
    fields: [
      { name: "text_html", kind: "richtext", label: "Text" },
      { name: "cta_href", kind: "url", label: "CTA link" },
    ],
    content: {
      source: "inline" as const,
      values: {
        text_html: `<p>Mehr dazu auf der Seite <a href="${TARGET_PATH}">KI-Sichtbarkeit</a>.</p>`,
        cta_href: TARGET_PATH,
      },
    },
  };
}

const ARTICLE_FIELDS = [
  {
    name: "bausteine",
    kind: "module-list",
    label: "Bausteine",
    allowedModuleTypes: [ENTRY_TYPE],
  },
];
const ARTICLE_HTML = '<article class="rg">{{#bausteine}}_{{/bausteine}}</article>';

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const tpl = await run<{ templateId: string }>("templates.create", {
    slug: `${PFX}-tpl`,
    displayName: `${PFX} TPL`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  templateId = tpl.templateId;
  await run("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const target = await run<{ pageId: string }>("pages.build_page", {
    page: { slug: TARGET_SLUG, title: "Schema Markup", templateId, status: "published" },
    modules: [],
  });
  targetId = target.pageId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

/** The canonical href the publish target's `directory` URL style renders. */
const CANONICAL_HREF = `href="${TARGET_PATH}/"`;
const LITERAL_HREF = `href="${TARGET_PATH}"`;

describe("build_page detached entries (issue #1028)", () => {
  it("stores a rich-text-only entry's link as a page reference and renders it like its sibling", async () => {
    const r = await buildPageTool.handler(
      SYSTEM,
      {
        page: { slug: `${PFX}-geo-vs-seo`, title: "GEO vs SEO", templateId },
        modules: [
          // Written without the trailing slash, exactly as in the report.
          boxEntry("box", `${PFX} Hinweis-Box`, TARGET_PATH),
          productEntry("product", `${PFX} Produkt-Hinweis`),
          {
            blockName: "content",
            displayName: `${PFX} Ratgeber-Artikel Inhalt`,
            description: "Article body: a list of content blocks.",
            kind: "content",
            html: ARTICLE_HTML,
            fields: ARTICLE_FIELDS,
            content: {
              source: "inline",
              values: { bausteine: [{ $ref: "box" }, { $ref: "product" }] },
            },
          },
        ],
      },
      toolCtx(),
    );
    if (!r.ok) throw new Error(`build_page failed: ${r.content}`);
    const v = r.value as {
      pageId: string;
      detached: { ref: string; contentInstanceId: string }[];
    };
    const box = v.detached.find((d) => d.ref === "box");
    if (!box) throw new Error("box entry not minted");

    expect((await storedValues(box.contentInstanceId)).inhalt_html).toBe(
      `<p>Der <a href="caelo:page/${targetId}">Test</a> umfasst 40 Seiten.</p>`,
    );

    const html = await renderPage(v.pageId);
    expect(html).toContain(`<a ${CANONICAL_HREF}>Test</a>`);
    expect(html).toContain(`<a ${CANONICAL_HREF}>KI-Sichtbarkeit</a>`);
    expect(html).not.toContain(LITERAL_HREF);
  });

  it("the searchVIU shape: detached entries attached afterwards with set_page_module_content", async () => {
    // Page with an empty article body.
    const page = await buildPageTool.handler(
      SYSTEM,
      {
        page: { slug: `${PFX}-attached`, title: "Attached", templateId },
        modules: [
          {
            blockName: "content",
            displayName: `${PFX} Ratgeber-Artikel Inhalt 2`,
            description: "Article body: a list of content blocks.",
            kind: "content",
            html: ARTICLE_HTML,
            fields: ARTICLE_FIELDS,
            content: { source: "inline", values: { bausteine: [] } },
          },
        ],
      },
      toolCtx(),
    );
    if (!page.ok) throw new Error(`build_page (page) failed: ${page.content}`);
    const pageId = (page.value as { pageId: string }).pageId;

    // Entries minted detached in a second build_page call on the same page.
    const entries = await buildPageTool.handler(
      SYSTEM,
      {
        page: { pageId },
        modules: [
          boxEntry("box", `${PFX} Hinweis-Box 2`, `${TARGET_PATH}/`),
          productEntry("product", `${PFX} Produkt-Hinweis 2`),
        ],
      },
      toolCtx(),
    );
    if (!entries.ok) throw new Error(`build_page (entries) failed: ${entries.content}`);
    const detached = (
      entries.value as { detached: { ref: string; moduleId: string; contentInstanceId: string }[] }
    ).detached;
    const box = detached.find((d) => d.ref === "box");
    const product = detached.find((d) => d.ref === "product");
    if (!box || !product) throw new Error("entries not minted");

    const set = await setPageModuleContentTool.handler(
      SYSTEM,
      {
        pageId,
        blockName: "content",
        position: 0,
        contentValues: {
          bausteine: [
            { moduleId: box.moduleId, contentInstanceId: box.contentInstanceId },
            { moduleId: product.moduleId, contentInstanceId: product.contentInstanceId },
          ],
        },
      },
      toolCtx(),
    );
    if (!set.ok) throw new Error(`set_page_module_content failed: ${set.content}`);

    expect(String((await storedValues(box.contentInstanceId)).inhalt_html)).toContain(
      `href="caelo:page/${targetId}"`,
    );
    const html = await renderPage(pageId);
    expect(html).toContain(`<a ${CANONICAL_HREF}>Test</a>`);
    expect(html).toContain(`<a ${CANONICAL_HREF}>KI-Sichtbarkeit</a>`);
    expect(html).not.toContain(LITERAL_HREF);
  });
});

describe("value writes on a nested instance (issue #1028)", () => {
  let boxInstanceId = "";
  let pageId = "";

  beforeAll(async () => {
    const r = await buildPageTool.handler(
      SYSTEM,
      {
        page: { slug: `${PFX}-edits`, title: "Edits", templateId, status: "published" },
        modules: [
          {
            ...boxEntry("box", `${PFX} Hinweis-Box 3`, TARGET_PATH),
            content: { source: "inline", values: { inhalt_html: "<p>Noch kein Link.</p>" } },
          },
          {
            blockName: "content",
            displayName: `${PFX} Ratgeber-Artikel Inhalt 3`,
            description: "Article body: a list of content blocks.",
            kind: "content",
            html: ARTICLE_HTML,
            fields: ARTICLE_FIELDS,
            content: { source: "inline", values: { bausteine: [{ $ref: "box" }] } },
          },
        ],
      },
      toolCtx(),
    );
    if (!r.ok) throw new Error(`build_page failed: ${r.content}`);
    const v = r.value as { pageId: string; detached: { contentInstanceId: string }[] };
    pageId = v.pageId;
    boxInstanceId = v.detached[0]?.contentInstanceId ?? "";
  });

  it("set_content_instance_values stores the rich-text link as a reference", async () => {
    await run("content_instances.set_values", {
      id: boxInstanceId,
      values: { inhalt_html: `<p>Siehe <a href="${TARGET_PATH}">Test</a>.</p>` },
    });
    expect((await storedValues(boxInstanceId)).inhalt_html).toBe(
      `<p>Siehe <a href="caelo:page/${targetId}">Test</a>.</p>`,
    );
    expect(await renderPage(pageId)).toContain(`<a ${CANONICAL_HREF}>Test</a>`);
  });

  it("set_values_many stores the rich-text link as a reference", async () => {
    await run("content_instances.set_values_many", {
      items: [
        {
          id: boxInstanceId,
          values: { inhalt_html: `<p>Neu: <a href="${TARGET_PATH}/#ergebnis">Test</a>.</p>` },
        },
      ],
    });
    expect((await storedValues(boxInstanceId)).inhalt_html).toBe(
      `<p>Neu: <a href="caelo:page/${targetId}#ergebnis">Test</a>.</p>`,
    );
  });

  it("existing literal data: the references check flags the nested literal, and its fix converts it", async () => {
    // A literal stored before this fix (written straight to the row, as the
    // skipped canonicalisation left it).
    const literal = `<p>Der <a href="${TARGET_PATH}">Test</a>.</p>`;
    await asSystem(
      (tx) =>
        tx`UPDATE content_instances SET "values" = ${JSON.stringify({ inhalt_html: literal })}::text::jsonb WHERE id = ${boxInstanceId}::uuid`,
    );

    const check = await run<{
      issues: {
        problem: string;
        severity: string;
        place: { kind: string; nested?: boolean; contentInstanceId?: string };
        message: string;
        fix: { tool: string; hint: string };
      }[];
    }>("links.check_references", { for: "stage", pageId, problems: ["literal-link"] });
    const issue = check.issues.find((i) => i.place.contentInstanceId === boxInstanceId);
    if (!issue) throw new Error(`no literal-link issue: ${JSON.stringify(check.issues)}`);
    expect(issue.severity).toBe("warning");
    expect(issue.place.nested).toBe(true);
    expect(issue.fix.tool).toBe("set_content_instance_values");
    expect(issue.fix.hint).toContain(boxInstanceId);
    expect(issue.fix.hint).toContain("page reference");

    // The fix: save the field's current value unchanged.
    await run("content_instances.set_values", {
      id: boxInstanceId,
      values: { inhalt_html: literal },
    });
    expect((await storedValues(boxInstanceId)).inhalt_html).toBe(
      `<p>Der <a href="caelo:page/${targetId}">Test</a>.</p>`,
    );
    const after = await run<{ issues: { place: { contentInstanceId?: string } }[] }>(
      "links.check_references",
      { for: "stage", pageId, problems: ["literal-link"] },
    );
    expect(after.issues.some((i) => i.place.contentInstanceId === boxInstanceId)).toBe(false);
  });
});
