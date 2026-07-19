// SPDX-License-Identifier: MPL-2.0

/**
 * Regression coverage for the branch-overlay-drops-fields bug (fix
 * commit "carry branch-edited module fields into the page-module
 * overlay", preview.ts).
 *
 * The bug: `pages.render_preview` with a `chatBranchId` overlays a
 * branch-edited module's HTML/CSS/JS onto the live `modules` row but
 * DROPPED the snapshot's `fields[]`. So when a chat-branch `edit_module`
 * ADDS a list field (e.g. a new `link-list`) together with the
 * `{{#field}}` section that iterates it, the render context still used
 * the STALE live `modules.fields` — which doesn't declare the new
 * field — and the section rendered as literal `{{#field}}` text
 * (`field-not-declared`) instead of the `<a>` items.
 *
 * The fix mirrors the layout + nested overlays (which already carried
 * fields): the top-level page-module overlay now sets `m.fields` from
 * the branch snapshot when it carries a `fields` array.
 *
 * This test seeds the exact shape: a LIVE module with an empty schema
 * and a body with no section, a chat-branch `module_snapshots` row that
 * adds a `link-list` field + the iterating section, and a bound
 * content_instance holding the list values. Rendering WITH the branch
 * id must produce the `<a>` items; rendering WITHOUT it must fall back
 * to the (section-free) live body. Per CLAUDE.md §6, every bug fix
 * lands with a regression test in the same tier as the bug.
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

const SYSTEM_ACTOR = "00000000-0000-0000-0000-00000000ffff";
const systemCtx: ExecutionContext = {
  actorId: SYSTEM_ACTOR,
  actorKind: "system",
  requestId: "preview-branch-overlay-fields-test",
};

const TPL_SLUG = "branch-fields-tpl";
const PAGE_SLUG = "branch-fields-page";
const MOD_SLUG = "branch-fields-mod-nav";
const BRANCH_ID = "b1a2c3d4-0b1a-4b1a-8b1a-00000000b12a";
const SNAP_DESC = "branch-overlay-fields-test-snapshot";

interface SeedIds {
  templateId: string;
  moduleId: string;
  pageId: string;
}
const seeded: Partial<SeedIds> = {};

// The branch snapshot's module state: adds the `nav_items` link-list
// field AND the iterating section that the LIVE body lacks.
const BRANCH_STATE = JSON.stringify({
  html: '<nav>{{#nav_items}}<a href="{{href}}">{{label}}</a>{{/nav_items}}</nav>',
  css: "",
  js: "",
  displayName: "Nav (branch-edited)",
  slug: MOD_SLUG,
  fields: [{ name: "nav_items", kind: "link-list", label: "Nav items" }],
  deletedAt: null,
});

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // Snapshots first (module_snapshots FK-cascades from site_snapshots,
      // but delete explicitly by our branch id to be safe against reruns).
      await tx`DELETE FROM module_snapshots WHERE site_snapshot_id IN (
        SELECT id FROM site_snapshots WHERE chat_branch_id = ${BRANCH_ID}::uuid
      )`;
      await tx`DELETE FROM site_snapshots WHERE chat_branch_id = ${BRANCH_ID}::uuid OR description = ${SNAP_DESC}`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug = ${MOD_SLUG})`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
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

      const tpl = (await tx`
        INSERT INTO templates (slug, display_name, html, layout_id)
        VALUES (
          ${TPL_SLUG},
          'Branch fields tpl',
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

      // LIVE module: empty schema, body has NO section. This is the
      // pre-branch-edit state the overlay must supersede.
      const mod = (await tx`
        INSERT INTO modules (slug, display_name, type, html, fields)
        VALUES (
          ${MOD_SLUG},
          'Nav',
          ${MOD_SLUG},
          '<nav></nav>',
          '[]'::jsonb
        )
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seeded.moduleId = mod[0]?.id ?? "";

      // content_instance carries the list values. (Values may hold keys
      // the live schema doesn't declare; they only render once a field
      // declares them — which is exactly what the branch overlay adds.)
      const ci = (await tx`
        INSERT INTO content_instances (module_id, "values")
        VALUES (
          ${seeded.moduleId}::uuid,
          '{"nav_items":[{"label":"Docs","href":"/docs"},{"label":"Blog","href":"/blog"}]}'::jsonb
        )
        RETURNING id::text AS id
      `) as unknown as { id: string }[];

      const page = (await tx`
        INSERT INTO pages (slug, locale, name, title, template_id)
        VALUES (${PAGE_SLUG}, 'en', 'Branch fields', 'Branch fields', ${seeded.templateId}::uuid)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seeded.pageId = page[0]?.id ?? "";
      await tx`
        INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        VALUES (${seeded.pageId}::uuid, 'content', 0, ${seeded.moduleId}::uuid, ${ci[0]?.id}::uuid, 'unsynced')
      `;

      // Chat-branch module_snapshots row: the branch-edited module that
      // ADDS the nav_items field + the iterating section.
      const ss = (await tx`
        INSERT INTO site_snapshots (actor_id, op_kind, description, chat_branch_id)
        VALUES (${SYSTEM_ACTOR}::uuid, 'unknown', ${SNAP_DESC}, ${BRANCH_ID}::uuid)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      await tx`
        INSERT INTO module_snapshots (site_snapshot_id, module_id, state)
        VALUES (${ss[0]?.id}::uuid, ${seeded.moduleId}::uuid, ${BRANCH_STATE}::jsonb)
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

describe("pages.render_preview branch-overlay carries module fields", () => {
  it("WITH chatBranchId — branch-added link-list field renders its <a> items (regression)", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.render_preview", {
      pageId: seeded.pageId,
      chatBranchId: BRANCH_ID,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { html } = r.value as { html: string };
    // The branch body + branch schema compose: the section iterates.
    expect(html).toContain('<a href="/docs">Docs</a>');
    expect(html).toContain('<a href="/blog">Blog</a>');
    // The bug's signature: an undeclared section survives as literal
    // `{{#nav_items}}` text. It must NOT appear now.
    expect(html).not.toMatch(/\{\{[#/]/);
    expect(html).not.toContain("nav_items");
  });

  it("WITHOUT chatBranchId — live (section-free) body renders, no items, no residue", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.render_preview", {
      pageId: seeded.pageId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { html } = r.value as { html: string };
    // Live body is `<nav></nav>`; the renderer tags it with a
    // data-caelo-module-id but the section-free body renders no items.
    expect(html).toMatch(/<nav[^>]*><\/nav>/);
    expect(html).not.toContain('<a href="/docs">');
    expect(html).not.toMatch(/\{\{[#/]/);
  });
});
