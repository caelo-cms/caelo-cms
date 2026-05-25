// SPDX-License-Identifier: MPL-2.0

/**
 * Tier-2 integration coverage for the shared template engine (#71)
 * over the real `cms_admin` Postgres in the compose stack.
 *
 * No new Query API ops are introduced; the boundary that needs
 * coverage is the round-trip from `content_instances.values` jsonb
 * through `pages.render_preview` (which calls the engine via
 * `preview-render.ts`). The unit tests in
 * `packages/shared/src/template-engine.test.ts` pin the engine in
 * isolation; this file proves the jsonb adapter round-trip + the
 * preview op + the engine compose end-to-end.
 *
 * Plan §8.2 specifies four end-to-end scenarios plus an RLS sanity
 * check; each case below maps to one bullet.
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
  requestId: "preview-render-list-iteration-test",
};

const aiCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000fffe",
  actorKind: "ai",
  requestId: "preview-render-list-iteration-test-ai",
};

const TPL_SLUG = "issue71-list-iter-tpl";
const PAGE_SLUGS = {
  textList: "issue71-text-list-page",
  linkList: "issue71-link-list-page",
  moduleList: "issue71-module-list-page",
  missingInstance: "issue71-missing-instance-page",
} as const;
const MOD_SLUGS = {
  tags: "issue71-mod-tags",
  nav: "issue71-mod-nav",
  cards: "issue71-mod-cards",
  card: "issue71-mod-card",
  missingParent: "issue71-mod-missing-parent",
} as const;

interface SeedIds {
  templateId: string;
  tagsModuleId: string;
  navModuleId: string;
  cardsModuleId: string;
  cardModuleId: string;
  missingParentModuleId: string;
  tagsPageId: string;
  navPageId: string;
  cardsPageId: string;
  missingInstancePageId: string;
}

const seeded: Partial<SeedIds> = {};

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      for (const slug of Object.values(PAGE_SLUGS)) {
        await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${slug})`;
        await tx`DELETE FROM pages WHERE slug = ${slug}`;
      }
      for (const slug of Object.values(MOD_SLUGS)) {
        await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug = ${slug})`;
        await tx`DELETE FROM modules WHERE slug = ${slug}`;
      }
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
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

  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");

      // Template + content block — shared across all pages below.
      // The layout_id binding picks the site-default layout (which
      // declares its own `content` slot the composer fills).
      const tpl = (await tx`
        INSERT INTO templates (slug, display_name, html, layout_id)
        VALUES (
          ${TPL_SLUG},
          '#71 list iter',
          '<body><caelo-slot name="content">_</caelo-slot></body>',
          (SELECT id FROM layouts WHERE slug = 'site-default')
        )
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seeded.templateId = tpl[0]?.id ?? "";
      await tx`
        INSERT INTO template_blocks (template_id, name, display_name, position)
        VALUES (${seeded.templateId}::uuid, 'content', 'Content', 0)
      `;

      // text-list module + content_instance + page placement.
      const tagsMod = (await tx`
        INSERT INTO modules (slug, display_name, html, fields)
        VALUES (
          ${MOD_SLUGS.tags},
          'Tags',
          '<ul>{{#tags}}<li>{{.}}</li>{{/tags}}</ul>',
          '[{"name":"tags","kind":"text-list","label":"Tags"}]'::jsonb
        )
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seeded.tagsModuleId = tagsMod[0]?.id ?? "";
      const tagsCi = (await tx`
        INSERT INTO content_instances (module_id, "values")
        VALUES (${seeded.tagsModuleId}::uuid, '{"tags":["a","b","c"]}'::jsonb)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      const tagsPage = (await tx`
        INSERT INTO pages (slug, locale, name, title, template_id)
        VALUES (${PAGE_SLUGS.textList}, 'en', 'Text list', 'Text list', ${seeded.templateId}::uuid)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seeded.tagsPageId = tagsPage[0]?.id ?? "";
      await tx`
        INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        VALUES (${seeded.tagsPageId}::uuid, 'content', 0, ${seeded.tagsModuleId}::uuid, ${tagsCi[0]?.id}::uuid, 'unsynced')
      `;

      // link-list module (AC #1 fixture) + content_instance + page.
      const navMod = (await tx`
        INSERT INTO modules (slug, display_name, html, fields)
        VALUES (
          ${MOD_SLUGS.nav},
          'Nav',
          '<nav>{{#nav_items}}<a href="{{href}}">{{label}}</a>{{/nav_items}}</nav>',
          '[{"name":"nav_items","kind":"link-list","label":"Nav items"}]'::jsonb
        )
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seeded.navModuleId = navMod[0]?.id ?? "";
      const navCi = (await tx`
        INSERT INTO content_instances (module_id, "values")
        VALUES (
          ${seeded.navModuleId}::uuid,
          '{"nav_items":[{"label":"Docs","href":"/docs"},{"label":"Blog","href":"/blog"}]}'::jsonb
        )
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      const navPage = (await tx`
        INSERT INTO pages (slug, locale, name, title, template_id)
        VALUES (${PAGE_SLUGS.linkList}, 'en', 'Link list', 'Link list', ${seeded.templateId}::uuid)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seeded.navPageId = navPage[0]?.id ?? "";
      await tx`
        INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        VALUES (${seeded.navPageId}::uuid, 'content', 0, ${seeded.navModuleId}::uuid, ${navCi[0]?.id}::uuid, 'unsynced')
      `;

      // module-list — parent + child module + nested content_instances.
      const cardsMod = (await tx`
        INSERT INTO modules (slug, display_name, html, fields)
        VALUES (
          ${MOD_SLUGS.cards},
          'Cards',
          '<section>{{#cards}}ignored{{/cards}}</section>',
          '[{"name":"cards","kind":"module-list","label":"Cards"}]'::jsonb
        )
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seeded.cardsModuleId = cardsMod[0]?.id ?? "";
      const cardMod = (await tx`
        INSERT INTO modules (slug, display_name, html, fields)
        VALUES (
          ${MOD_SLUGS.card},
          'Card',
          '<article>{{title}}</article>',
          '[{"name":"title","kind":"text","label":"Title"}]'::jsonb
        )
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seeded.cardModuleId = cardMod[0]?.id ?? "";

      const card1Ci = (await tx`
        INSERT INTO content_instances (module_id, "values")
        VALUES (${seeded.cardModuleId}::uuid, '{"title":"First card"}'::jsonb)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      const card2Ci = (await tx`
        INSERT INTO content_instances (module_id, "values")
        VALUES (${seeded.cardModuleId}::uuid, '{"title":"Second card"}'::jsonb)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      const cardsValuesJson = JSON.stringify({
        cards: [
          { moduleId: seeded.cardModuleId, contentInstanceId: card1Ci[0]?.id },
          { moduleId: seeded.cardModuleId, contentInstanceId: card2Ci[0]?.id },
        ],
      });
      const cardsCi = (await tx`
        INSERT INTO content_instances (module_id, "values")
        VALUES (${seeded.cardsModuleId}::uuid, ${cardsValuesJson}::jsonb)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      const cardsPage = (await tx`
        INSERT INTO pages (slug, locale, name, title, template_id)
        VALUES (${PAGE_SLUGS.moduleList}, 'en', 'Cards', 'Cards', ${seeded.templateId}::uuid)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seeded.cardsPageId = cardsPage[0]?.id ?? "";
      await tx`
        INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        VALUES (${seeded.cardsPageId}::uuid, 'content', 0, ${seeded.cardsModuleId}::uuid, ${cardsCi[0]?.id}::uuid, 'unsynced')
      `;

      // Loud-raw on missing nested content_instance.
      const missingMod = (await tx`
        INSERT INTO modules (slug, display_name, html, fields)
        VALUES (
          ${MOD_SLUGS.missingParent},
          'Missing parent',
          '<section>{{#cards}}x{{/cards}}</section>',
          '[{"name":"cards","kind":"module-list","label":"Cards"}]'::jsonb
        )
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seeded.missingParentModuleId = missingMod[0]?.id ?? "";
      const danglingId = "00000000-0000-0000-0000-0000000ddead";
      const missingValuesJson = JSON.stringify({
        cards: [{ moduleId: seeded.cardModuleId, contentInstanceId: danglingId }],
      });
      const missingCi = (await tx`
        INSERT INTO content_instances (module_id, "values")
        VALUES (${seeded.missingParentModuleId}::uuid, ${missingValuesJson}::jsonb)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      const missingPage = (await tx`
        INSERT INTO pages (slug, locale, name, title, template_id)
        VALUES (${PAGE_SLUGS.missingInstance}, 'en', 'Missing', 'Missing', ${seeded.templateId}::uuid)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seeded.missingInstancePageId = missingPage[0]?.id ?? "";
      await tx`
        INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        VALUES (${seeded.missingInstancePageId}::uuid, 'content', 0, ${seeded.missingParentModuleId}::uuid, ${missingCi[0]?.id}::uuid, 'unsynced')
      `;
    });
  } finally {
    await sql.end();
  }
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("pages.render_preview list iteration (#71)", () => {
  it("text-list — jsonb {tags:[...]} round-trips through the engine into <li> elements", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.render_preview", {
      pageId: seeded.tagsPageId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { html } = r.value as { html: string };
    expect(html).toContain("<li>a</li><li>b</li><li>c</li>");
    expect(html).not.toMatch(/\{\{[#/]/);
  });

  it("link-list — AC #1 verbatim fixture over the real DB", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.render_preview", {
      pageId: seeded.navPageId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { html } = r.value as { html: string };
    expect(html).toContain('<a href="/docs">Docs</a>');
    expect(html).toContain('<a href="/blog">Blog</a>');
    expect(html).not.toMatch(/\{\{[#/]/);
    expect(html).not.toMatch(/\{\{label/);
    expect(html).not.toMatch(/\{\{href/);
  });

  it("module-list — nested {moduleId, contentInstanceId} refs render in order, no marker residue", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.render_preview", {
      pageId: seeded.cardsPageId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { html } = r.value as { html: string };
    expect(html).toContain("<article>First card</article>");
    expect(html).toContain("<article>Second card</article>");
    expect(html.indexOf("First card")).toBeLessThan(html.indexOf("Second card"));
    expect(html).not.toMatch(/\{\{[#/]/);
  });

  it("loud-raw — missing nested content_instance surfaces caelo:missing comment in HTML", async () => {
    // The op response's `missingSlots` is composer-level (named
    // template slots the page didn't fill). The renderer-level
    // failure markers (content-instance-missing, depth-limit, cycle,
    // ...) live on the RenderResult that the op consumes but doesn't
    // currently aggregate into its response — the HTML comment is
    // the operator-facing signal at the op boundary. Direct callers
    // of renderModuleWithContent (covered by the unit tests in
    // preview-render.test.ts) read the structured channel.
    const r = await execute(registry, adapter, systemCtx, "pages.render_preview", {
      pageId: seeded.missingInstancePageId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { html } = r.value as { html: string };
    expect(html).toContain(
      "<!-- caelo:missing reason=content-instance-missing 00000000-0000-0000-0000-0000000ddead -->",
    );
  });

  it("RLS sanity — system + ai actors render identical HTML", async () => {
    const sys = await execute(registry, adapter, systemCtx, "pages.render_preview", {
      pageId: seeded.navPageId,
    });
    const ai = await execute(registry, adapter, aiCtx, "pages.render_preview", {
      pageId: seeded.navPageId,
    });
    expect(sys.ok).toBe(true);
    expect(ai.ok).toBe(true);
    if (!sys.ok || !ai.ok) return;
    const sysHtml = (sys.value as { html: string }).html;
    const aiHtml = (ai.value as { html: string }).html;
    expect(aiHtml).toBe(sysHtml);
  });
});
