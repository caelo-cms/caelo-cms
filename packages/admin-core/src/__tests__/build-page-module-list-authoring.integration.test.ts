// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #417 — proves the AI-tool authoring path for `module-list` card
 * grids END TO END against the real Postgres.
 *
 * Background: in the 2026-08-03 dogfood run the agent minted card grids
 * as content-coupled scalar fields (`quote_justamazing`, `logo_…`)
 * instead of a `module-list` of card sub-modules — explicitly because
 * this path had never been verified and it would not risk a broken
 * first render. This file is that verification: the REAL AI tool
 * (`build_page`) mints the parent module with a `module-list` field,
 * mints card sub-modules as detached `ref` entries, binds their
 * content_instances via `{"$ref"}` markers, places the grid on a page —
 * and the DB-aware render path (`pages.render_preview`, the op behind
 * the `inspect_page_render` tool) produces the cards with no
 * `needs recursive renderer` comment, no `caelo:missing` markers, and
 * no raw placeholders.
 *
 * `preview-render-list-iteration.integration.test.ts` covers the same
 * RENDER path but seeds via raw SQL — it proves rendering, not
 * authoring. This file covers the authoring half.
 *
 * Actor note: tool handlers run with the `system` actor per the repo
 * convention (the cold-start gate fires only for `ai` actors and its
 * state lives in preserved seed tables — see
 * add-module-to-template-place.integration.test.ts); the AI-actor
 * write path (actorScope + RLS) is covered separately by driving the
 * `pages.build_page` op — exactly what the tool executes past the
 * gate — with `actorKind: "ai"`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { buildPageTool } from "../ai/tools/build-page.js";
import { createContentInstanceTool } from "../ai/tools/create-content-instance.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { setPageModuleContentTool } from "../ai/tools/set-page-module-content.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "i417-module-list-authoring",
};

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000fffe",
  actorKind: "ai",
  requestId: "i417-module-list-authoring-ai",
};

const TS = Date.now().toString(36);
const TPL_SLUG = `i417-tpl-${TS}`;
const PAGE_SLUG = `i417-features-${TS}`;
const PAGE_SLUG_AI = `i417-ai-${TS}`;
const PAGE_SLUG_FANOUT = `i417-fanout-${TS}`;
const CARD_TYPE = "i417-feature-card";

const toolCtx = () => ({ adapter, registry }) as ToolContext;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`i417-%-${TS}`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`i417-%-${TS}`}`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${"I417 %"})`;
      await tx`DELETE FROM modules WHERE display_name LIKE ${"I417 %"}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

let templateId = "";

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  // audit_events.actor_id FKs actors — the AI actor needs a row (same
  // pattern as propose-execute / themes-pending; actors is a preserved
  // seed table, so insert-once and leave it).
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${AI.actorId}::uuid, 'ai', 'i417-test-ai') ON CONFLICT DO NOTHING`;
    });
  } finally {
    await sql.end();
  }

  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: TPL_SLUG,
    displayName: "I417 TPL",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
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
  await adapter.close();
});

async function renderPage(ctx: ExecutionContext, pageId: string): Promise<string> {
  const r = await execute(registry, adapter, ctx, "pages.render_preview", { pageId });
  if (!r.ok) throw new Error(`render_preview failed: ${JSON.stringify(r.error)}`);
  return (r.value as { html: string }).html;
}

describe("build_page authors a module-list card grid (the path issue #417's dogfood agent routed around)", () => {
  let pageId = "";
  let cardModuleId = "";
  const cardRefs: { moduleId: string; contentInstanceId: string }[] = [];

  it("ONE build_page tool call: detached card mints + {$ref} module-list binding + placement", async () => {
    const r = await buildPageTool.handler(
      SYSTEM,
      {
        page: { slug: PAGE_SLUG, title: "I417 Features", templateId },
        modules: [
          {
            ref: "card_a",
            // no blockName → detached (nested-only): minted + content-bound.
            displayName: "I417 Feature Card",
            description: "One feature card: role-named title + body.",
            kind: "content",
            type: CARD_TYPE,
            html: "<article><h3>{{card_title}}</h3><p>{{card_body}}</p></article>",
            fields: [
              { name: "card_title", kind: "text", label: "Card title" },
              { name: "card_body", kind: "text", label: "Card body" },
            ],
            content: {
              source: "inline",
              values: { card_title: "Fast setup", card_body: "Live in minutes." },
            },
          },
          {
            // Second card: same module re-used via moduleId {"$ref"}, own instance.
            ref: "card_b",
            moduleId: { $ref: "card_a" },
            content: {
              source: "inline",
              values: { card_title: "Fair pricing", card_body: "Pay for what you use." },
            },
          },
          {
            blockName: "content",
            displayName: "I417 Feature Grid",
            description: "Grid of feature cards (module-list of card sub-modules).",
            kind: "content",
            html: '<section class="i417-grid">{{#feature_cards}}INNER_IS_DISCARDED{{/feature_cards}}</section>',
            fields: [
              {
                name: "feature_cards",
                kind: "module-list",
                label: "Feature cards",
                allowedModuleTypes: [CARD_TYPE],
              },
            ],
            content: {
              source: "inline",
              values: { feature_cards: [{ $ref: "card_a" }, { $ref: "card_b" }] },
            },
          },
        ],
      },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(`build_page tool failed: ${r.content}`);
    const v = r.value as {
      pageId: string;
      placements: { moduleId: string; contentInstanceId: string; minted: boolean }[];
      detached: { ref: string; moduleId: string; contentInstanceId: string }[];
    };
    pageId = v.pageId;
    // One placement (the grid); both cards are detached, not placed.
    expect(v.placements.length).toBe(1);
    expect(v.detached.length).toBe(2);
    cardModuleId = v.detached[0]?.moduleId ?? "";
    // card_b re-used card_a's module — one card module, two instances.
    expect(v.detached[1]?.moduleId).toBe(cardModuleId);
    expect(v.detached[0]?.contentInstanceId).not.toBe(v.detached[1]?.contentInstanceId);
    for (const d of v.detached) {
      cardRefs.push({ moduleId: d.moduleId, contentInstanceId: d.contentInstanceId });
    }

    // The grid's content_instance stores RESOLVED refs, not {"$ref"} markers.
    const ci = await execute(registry, adapter, SYSTEM, "content_instances.get", {
      id: v.placements[0]?.contentInstanceId,
    });
    if (!ci.ok) throw new Error("grid ci get failed");
    const cards = (
      ci.value as { instance: { values: { feature_cards?: Record<string, unknown>[] } } }
    ).instance.values.feature_cards;
    expect(cards?.length).toBe(2);
    expect(cards?.[0]?.moduleId).toBe(cardModuleId);
    expect(cards?.[0]?.contentInstanceId).toBe(cardRefs[0]?.contentInstanceId);
  });

  it("renders on the DB-aware path: cards in order, no recursive-renderer comment, no residue", async () => {
    const html = await renderPage(SYSTEM, pageId);
    expect(html).toContain("<h3>Fast setup</h3>");
    expect(html).toContain("<h3>Fair pricing</h3>");
    expect(html.indexOf("Fast setup")).toBeLessThan(html.indexOf("Fair pricing"));
    // module-list semantics: the inner block is DISCARDED, elements render
    // as pre-resolved partials (template-engine.ts renderModuleList).
    expect(html).not.toContain("INNER_IS_DISCARDED");
    // The compose-path escape hatch must NOT appear on the DB path.
    expect(html).not.toContain("needs recursive renderer");
    expect(html).not.toContain("caelo:missing");
    // No raw placeholders or section markers survive.
    expect(html).not.toMatch(/\{\{[#/]/);
    expect(html).not.toContain("{{card_title}}");
    expect(html).not.toContain("{{feature_cards}}");
  });

  it("incremental chain appends a card: create_content_instance + set_page_module_content", async () => {
    const created = await createContentInstanceTool.handler(
      SYSTEM,
      {
        moduleId: cardModuleId,
        displayName: "I417 Card Three",
        values: { card_title: "Open source", card_body: "MPL 2.0 forever." },
      },
      toolCtx(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(`create_content_instance failed: ${created.content}`);
    // The tool reports the new id in its text content (that IS the AI-facing
    // surface — the model reads it from the tool result, so the test does too).
    const thirdId = /content_instance ([0-9a-f-]{36}) created/.exec(created.content)?.[1];
    if (!thirdId) throw new Error(`no contentInstanceId in tool content: ${created.content}`);

    const set = await setPageModuleContentTool.handler(
      SYSTEM,
      {
        pageId,
        blockName: "content",
        position: 0,
        contentValues: {
          feature_cards: [...cardRefs, { moduleId: cardModuleId, contentInstanceId: thirdId }],
        },
      },
      toolCtx(),
    );
    expect(set.ok).toBe(true);
    if (!set.ok) throw new Error(`set_page_module_content failed: ${set.content}`);

    const html = await renderPage(SYSTEM, pageId);
    expect(html).toContain("<h3>Open source</h3>");
    expect(html.indexOf("Fair pricing")).toBeLessThan(html.indexOf("Open source"));
    expect(html).not.toContain("needs recursive renderer");
    expect(html).not.toContain("caelo:missing");
  });

  it("the pages.build_page op accepts the AI actor for the same composition (actorScope + RLS)", async () => {
    const r = await execute(registry, adapter, AI, "pages.build_page", {
      page: { slug: PAGE_SLUG_AI, title: "I417 AI Page", templateId },
      modules: [
        {
          ref: "card",
          displayName: "I417 AI Card",
          description: "Card minted by the AI actor.",
          kind: "content",
          html: "<article>{{card_title}}</article>",
          fields: [{ name: "card_title", kind: "text", label: "Card title" }],
          content: { source: "inline", values: { card_title: "AI-authored" } },
        },
        {
          blockName: "content",
          displayName: "I417 AI Grid",
          description: "Module-list grid minted by the AI actor.",
          kind: "content",
          html: "<section>{{#cards}}x{{/cards}}</section>",
          fields: [{ name: "cards", kind: "module-list", label: "Cards" }],
          content: { source: "inline", values: { cards: [{ $ref: "card" }] } },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const html = await renderPage(AI, (r.value as { pageId: string }).pageId);
    expect(html).toContain("<article>AI-authored</article>");
    expect(html).not.toContain("needs recursive renderer");
  });

  it("§1A guard: numbered-scalar fanout is rejected through the real op path, nothing written", async () => {
    const r = await execute(registry, adapter, SYSTEM, "pages.build_page", {
      page: { slug: PAGE_SLUG_FANOUT, title: "I417 Fanout", templateId },
      modules: [
        {
          blockName: "content",
          displayName: "I417 Fanout Grid",
          description: "Grid authored the WRONG way — numbered scalars.",
          kind: "content",
          html: "<section><p>{{label}}</p><p>{{label2}}</p><p>{{label3}}</p></section>",
          fields: [
            { name: "label", kind: "text", label: "Label" },
            { name: "label2", kind: "text", label: "Label 2" },
            { name: "label3", kind: "text", label: "Label 3" },
          ],
          content: { source: "inline", values: { label: "a", label2: "b", label3: "c" } },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msg = (r.error as { message?: string }).message ?? "";
    expect(msg).toContain("modules[0]");
    expect(msg).toContain("numbered-scalar fanout");
    expect(msg).toContain("text-list");
    expect(msg).toContain("module-list");

    // All-or-nothing: the page create rolled back with the module reject.
    const sql = new SQL(ADMIN_URL!);
    try {
      const rows =
        (await sql`SELECT id FROM pages WHERE slug = ${PAGE_SLUG_FANOUT}`) as unknown as unknown[];
      expect(rows.length).toBe(0);
    } finally {
      await sql.end();
    }
  });
});
