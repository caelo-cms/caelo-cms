// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 — layout/chrome modules must interpolate their field defaults
 * in the live-edit preview, exactly like page-content modules do.
 *
 * Step-13's browser walk caught a footer placed via `add_module_to_layout`
 * rendering raw template tokens in the preview iframe:
 *   {{#nav_links}} {{label}} {{/nav_links}}  {{copyright}}
 * Root cause: `pages.render_preview` loaded layout modules WITHOUT `m.fields`
 * and handed the composer field-less modules, so `applyFieldSubstitution`
 * had no defaults to substitute. (The static generator already loaded
 * fields — the preview op was the lone divergence.) A layout module has no
 * content_instance binding; its content lives in the authored field
 * `default`s, so the fix is to load + pass those fields.
 *
 * This test fails against the pre-fix preview op (raw `{{…}}` survive) and
 * passes after — the regression guard for the footer path.
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

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue106-layout-fields",
};

const PFX = "issue106-fields";
const TPL_SLUG = `${PFX}-tpl`;
const LAYOUT_SLUG = `${PFX}-layout`;
const FOOTER_MOD_SLUG = `${PFX}-footer`;
const PAGE_SLUG = `${PFX}-page`;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM layout_modules WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM layout_modules WHERE layout_id IN (SELECT id FROM layouts WHERE slug = ${LAYOUT_SLUG})`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}-%`}`;
      // templates.layout_id FK references layouts — drop templates first.
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
      await tx`DELETE FROM layouts WHERE slug = ${LAYOUT_SLUG}`;
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
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("pages.render_preview — layout module field interpolation (issue #106)", () => {
  it("interpolates a footer's link-list + scalar field defaults instead of shipping raw {{…}}", async () => {
    // Our own layout with content + footer slots (so we never touch the
    // shared site-default layout that other tests assert on).
    const layout = await execute(registry, adapter, systemCtx, "layouts.create", {
      slug: LAYOUT_SLUG,
      displayName: "Fields Layout",
      html: '<body><caelo-slot name="content"></caelo-slot><caelo-slot name="footer"></caelo-slot></body>',
      css: "",
      blocks: [
        { name: "content", displayName: "Content", position: 0 },
        { name: "footer", displayName: "Footer", position: 1 },
      ],
    });
    if (!layout.ok) throw new Error("layout seed");
    const layoutId = (layout.value as { layoutId: string }).layoutId;

    // Template bound to OUR layout (the page resolves its layout through
    // the template, so bind it here rather than touching site_defaults).
    const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
      slug: TPL_SLUG,
      displayName: "Fields T",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
      layoutId,
    });
    if (!tpl.ok) throw new Error("tpl seed");
    const templateId = (tpl.value as { templateId: string }).templateId;
    await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });

    // Footer module: a link-list nav + a scalar copyright, content carried
    // entirely in the field `default`s (a chrome module has no
    // content_instance). HTML uses the Mustache section + scalar grammar.
    const footer = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: FOOTER_MOD_SLUG,
      displayName: "Site footer",
      html:
        '<footer class="site-footer"><nav aria-label="Footer">' +
        '{{#nav_links}}<a href="{{href}}">{{label}}</a>{{/nav_links}}' +
        "</nav><p>{{copyright}}</p></footer>",
      css: "",
      js: "",
      fields: [
        {
          name: "nav_links",
          kind: "link-list",
          label: "Footer navigation",
          default: [
            { label: "Home", href: "/" },
            { label: "About", href: "/about" },
            { label: "Contact", href: "/contact" },
          ],
        },
        { name: "copyright", kind: "text", label: "Copyright", default: "© 2026 Caelo Test" },
      ],
    });
    if (!footer.ok) throw new Error(`footer module seed: ${JSON.stringify(footer.error)}`);
    const footerModuleId = (footer.value as { moduleId: string }).moduleId;

    await execute(registry, adapter, systemCtx, "layout_modules.set", {
      layoutId,
      blockName: "footer",
      moduleIds: [footerModuleId],
    });

    // Page on the template (the template carries our layout).
    const pg = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUG,
      title: "Fields P",
      templateId,
    });
    if (!pg.ok) throw new Error("page seed");
    const pageId = (pg.value as { pageId: string }).pageId;

    const r = await execute(registry, adapter, systemCtx, "pages.render_preview", { pageId });
    if (!r.ok) console.error("render_preview error:", r.error);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { html } = r.value as { html: string };

    // The link-list section expanded to one <a> per item, with both href
    // and label bound from the field default.
    expect(html).toContain('<a href="/">Home</a>');
    expect(html).toContain('<a href="/about">About</a>');
    expect(html).toContain('<a href="/contact">Contact</a>');
    // The scalar default substituted.
    expect(html).toContain("© 2026 Caelo Test");

    // The raw template tokens must be GONE — this is the exact regression
    // step 13 saw (raw {{#nav_links}} / {{label}} / {{copyright}} shipped
    // to the preview iframe).
    expect(html).not.toContain("{{#nav_links}}");
    expect(html).not.toContain("{{/nav_links}}");
    expect(html).not.toContain("{{label}}");
    expect(html).not.toContain("{{href}}");
    expect(html).not.toContain("{{copyright}}");
  });
});
