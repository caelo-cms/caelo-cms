// SPDX-License-Identifier: MPL-2.0

/**
 * End-to-end preview rendering: seeded template + 2 modules → composed HTML
 * containing the slot fill, module CSS in `<style data-source="modules">`,
 * module JS in `<script defer data-source="modules">`. Exercises the same op
 * the SvelteKit preview endpoint will call.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let restoreSiteBaseUrl: (() => Promise<void>) | null = null;
let restoreSiteLanguage: (() => Promise<void>) | null = null;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "content-preview-test",
};

const aiCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000232a1",
  actorKind: "ai",
  requestId: "content-preview-test-ai",
};

const TPL_SLUG = "p3-preview-tpl";
const MOD_SLUGS = ["p3-preview-mod-a", "p3-preview-mod-b"] as const;
const PAGE_SLUG = "p3-preview-page";
/** Set by the compose test; the site-language test re-renders it. */
let previewPageId = "";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      for (const slug of MOD_SLUGS) await tx`DELETE FROM modules WHERE slug = ${slug}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  // site_defaults.updated_by + audit_events.actor_id FK into actors.
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name)
               VALUES (${aiCtx.actorId}::uuid, 'ai', 'content-preview test ai')
               ON CONFLICT (id) DO NOTHING`;
    });
  } finally {
    await sql.end();
  }
  // #551 — canonicals need a configured base URL (no localhost default).
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL!, "https://example.com");
  restoreSiteLanguage = await pinSiteLanguage(ADMIN_URL!, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await restoreSiteBaseUrl?.();
  await restoreSiteLanguage?.();
  await adapter.close();
});

describe("pages.render_preview", () => {
  it("composes the template HTML with two modules in slot order, plus stamped CSS/JS", async () => {
    const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
      slug: TPL_SLUG,
      displayName: "Preview T",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "body{font-family:sans-serif}",
    });
    if (!tpl.ok) throw new Error("tpl seed");
    const templateId = (tpl.value as { templateId: string }).templateId;
    await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });

    const m1 = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: MOD_SLUGS[0],
      displayName: "A",
      html: "<p>HELLO_A</p>",
      css: ".a{color:red}",
      js: "window.A=1;",
    });
    if (!m1.ok) throw new Error("m1 seed");
    const m2 = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: MOD_SLUGS[1],
      displayName: "B",
      html: "<p>HELLO_B</p>",
      css: ".b{color:blue}",
      js: "window.B=1;",
    });
    if (!m2.ok) throw new Error("m2 seed");

    const pg = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUG,
      title: "P",
      templateId,
    });
    if (!pg.ok) throw new Error("page seed");
    const pageId = (pg.value as { pageId: string }).pageId;
    previewPageId = pageId;
    await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [
        {
          blockName: "content",
          moduleIds: [
            (m1.value as { moduleId: string }).moduleId,
            (m2.value as { moduleId: string }).moduleId,
          ],
        },
      ],
    });

    const r = await execute(registry, adapter, systemCtx, "pages.render_preview", { pageId });
    if (!r.ok) console.error("render_preview error:", r.error);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { html, replacedSlots, missingSlots } = r.value as {
      html: string;
      replacedSlots: string[];
      missingSlots: string[];
    };
    expect(replacedSlots).toEqual(["content"]);
    // P6.7.6 — site-default layout adds header/footer slots that this
    // page leaves empty; they show up as missing (no layout_modules
    // attached). That's expected behaviour, not a regression.
    //
    // issue #156 — `unknown-css-var:*` markers are filtered here: this
    // test pins SLOT accounting, not CSS health. Until migration 0104
    // (#157, PR #168) lands, the seeded layout legitimately triggers
    // unknown-css-var:--color-bg/--color-fg — the scanner catching our
    // own seed bug is correct behaviour, asserted in its own suite.
    const slotMarkers = missingSlots.filter((m) => !m.startsWith("unknown-css-var:"));
    expect(slotMarkers.sort()).toEqual(["footer", "header"]);
    expect(html).toContain("HELLO_A");
    expect(html).toContain("HELLO_B");
    expect(html.indexOf("HELLO_A")).toBeLessThan(html.indexOf("HELLO_B"));
    expect(html).toContain(`<style data-source="modules">`);
    expect(html).toContain(".a{color:red}");
    expect(html).toContain(".b{color:blue}");
    expect(html).toContain(`<script defer data-source="modules">`);
    expect(html).toContain("window.A=1;");
    expect(html).toContain("window.B=1;");
  });

  // Migration 0232 — the site language has no `en` default. Unset, the
  // preview must not invent one: no `lang` on <html> (the template's
  // bare <html> stays bare) and `site-language-unset` on the
  // missing-content surface. The AI then sets it through set_identity.
  it("an unset site language renders no lang and flags it; the AI's set_identity fills it", async () => {
    expect(previewPageId).not.toBe("");
    const render = async () => {
      const r = await execute(registry, adapter, systemCtx, "pages.render_preview", {
        pageId: previewPageId,
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value as { html: string; missingSlots: string[] };
    };
    const siteLanguage = async () => {
      const r = await execute(registry, adapter, systemCtx, "site_defaults.get", {});
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return (r.value as { defaults: { siteLanguage: string | null } }).defaults.siteLanguage;
    };

    const restore = await pinSiteLanguage(ADMIN_URL!, null);
    try {
      expect(await siteLanguage()).toBeNull();
      const unset = await render();
      expect(unset.missingSlots).toContain("site-language-unset");
      expect(unset.html).not.toMatch(/<html[^>]*\slang=/);
    } finally {
      await restore();
    }

    const set = await execute(registry, adapter, aiCtx, "site_defaults.set_identity", {
      siteLanguage: "de",
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    expect(await siteLanguage()).toBe("de");
    const filled = await render();
    expect(filled.missingSlots).not.toContain("site-language-unset");
    expect(filled.html).toContain('<html lang="de"');
  });
});
