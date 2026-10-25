// SPDX-License-Identifier: MPL-2.0

/**
 * `pages_seo.get_many` — the AI's SEO read returns each page's stored SEO
 * AND its core text, so a meta description is written from the page's
 * words without composing the whole page (layout, theme, CSS: 50–200 KB).
 *
 * Pinned:
 *   - the text is the page's own template-block placements in render
 *     order (template slot order, then position), nested module-list
 *     children included, placeholders resolved from the content values;
 *     the layout chrome (header text shared by every page) is left out;
 *   - a chat's draft edit shows on that chat's branch, not on main;
 *   - the text is capped at a word boundary and says it was cut;
 *   - an unknown page id refuses the read and names the id.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { PAGE_CONTENT_TEXT_MAX } from "../ops/content/page-content-text.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "sgm-sys" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";

type SeoPage = {
  pageId: string;
  title: string;
  path: string;
  seo: { metaDescription: string } | null;
  contentText: string;
  contentTextTruncated: boolean;
  contentTextLength: number;
};

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function seoPages(ctx: ExecutionContext, pageIds: string[]): Promise<SeoPage[]> {
  return (await op<{ pages: SeoPage[] }>(ctx, "pages_seo.get_many", { pageIds })).pages;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  // A layout whose header chrome carries text every page shows.
  const { layoutId } = await op<{ layoutId: string }>(SYS, "layouts.create", {
    slug: `sgm-layout-${TS}`,
    displayName: "SGM Layout",
    html: '<body><caelo-slot name="header"></caelo-slot><caelo-slot name="content"></caelo-slot></body>',
    blocks: [
      { name: "header", displayName: "Header", position: 0 },
      { name: "content", displayName: "Content", position: 1 },
    ],
  });
  const { moduleId: headerId } = await op<{ moduleId: string }>(SYS, "modules.create", {
    slug: `sgm-header-${TS}`,
    displayName: "SGM Header",
    kind: "chrome",
    html: "<header><nav>CHROME HEADER TEXT</nav></header>",
  });
  await op(SYS, "layout_modules.set", { layoutId, blockName: "header", moduleIds: [headerId] });

  // The hero slot comes BEFORE the content slot in the template.
  ({ templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
    slug: `sgm-tpl-${TS}`,
    displayName: "SGM Template",
    layoutId,
    html: '<main><caelo-slot name="hero">_</caelo-slot><caelo-slot name="content">_</caelo-slot></main>',
  }));
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [
      { name: "hero", displayName: "Hero", position: 0 },
      { name: "content", displayName: "Content", position: 1 },
    ],
  });
});

afterAll(async () => {
  await adapter.close();
});

/** A page with a card grid (module-list of two cards) in `content` and a hero in `hero`. */
async function buildPage(
  slug: string,
  heroBody: string,
): Promise<{ pageId: string; heroCi: string }> {
  const built = await op<{
    pageId: string;
    placements: { moduleId: string; contentInstanceId: string }[];
  }>(SYS, "pages.build_page", {
    page: { slug: `sgm-${slug}-${TS}`, title: `SGM ${slug}`, templateId },
    modules: [
      {
        ref: "card_a",
        displayName: `SGM Card ${slug}`,
        description: "A feature card.",
        kind: "content",
        type: `sgm-card-${slug}-${TS}`,
        html: "<article><h3>{{card_title}}</h3><p>{{card_body}}</p></article>",
        fields: [
          { name: "card_title", kind: "text", label: "Title" },
          { name: "card_body", kind: "text", label: "Body" },
        ],
        content: {
          source: "inline",
          values: { card_title: "Fast setup", card_body: "Live in minutes." },
        },
      },
      {
        ref: "card_b",
        moduleId: { $ref: "card_a" },
        content: {
          source: "inline",
          values: { card_title: "Fair & square", card_body: "Pay what you use." },
        },
      },
      // Listed before the hero on purpose: the text follows the template's
      // slot order, not the order the modules were authored in.
      {
        blockName: "content",
        displayName: `SGM Grid ${slug}`,
        description: "Grid of feature cards.",
        kind: "content",
        html: '<section>{{#cards}}x{{/cards}}<a href="/">{{cta_label}}</a></section>',
        fields: [
          {
            name: "cards",
            kind: "module-list",
            label: "Cards",
            allowedModuleTypes: [`sgm-card-${slug}-${TS}`],
          },
          { name: "cta_label", kind: "text", label: "CTA" },
        ],
        content: {
          source: "inline",
          values: { cards: [{ $ref: "card_a" }, { $ref: "card_b" }], cta_label: "See pricing" },
        },
      },
      {
        blockName: "hero",
        displayName: `SGM Hero ${slug}`,
        description: "Page hero.",
        kind: "hero",
        html: "<section><h1>{{hero_title}}</h1><p>{{hero_body}}</p><script>var t = 'NOT TEXT';</script></section>",
        fields: [
          { name: "hero_title", kind: "text", label: "Title" },
          { name: "hero_body", kind: "text", label: "Body" },
        ],
        content: {
          source: "inline",
          values: { hero_title: "Pricing &amp; plans", hero_body: heroBody },
        },
      },
    ],
  });
  // Placements come back in the authored order of the placed modules: grid, hero.
  const hero = built.placements[1]?.contentInstanceId;
  if (!hero) throw new Error("build_page returned no hero placement");
  return { pageId: built.pageId, heroCi: hero };
}

describe("pages_seo.get_many — stored SEO + core text", () => {
  let pageId = "";
  let heroCi = "";

  it("returns the page's own text in render order, nested cards included, chrome left out", async () => {
    ({ pageId, heroCi } = await buildPage("main", "Simple plans for every team."));
    await op(SYS, "pages_seo.autofill", { pageId, metaDescription: "Stored description." });
    const [page] = await seoPages(SYS, [pageId]);
    expect(page?.title).toBe("SGM main");
    expect(page?.seo?.metaDescription).toBe("Stored description.");
    expect(page?.contentText).toBe(
      [
        "Pricing & plans",
        "Simple plans for every team.",
        "Fast setup",
        "Live in minutes.",
        "Fair & square",
        "Pay what you use.",
        "See pricing",
      ].join("\n"),
    );
    expect(page?.contentText).not.toContain("CHROME HEADER TEXT");
    expect(page?.contentText).not.toContain("NOT TEXT");
    expect(page?.contentTextTruncated).toBe(false);
  });

  it("shows a chat's draft edit on that chat's branch only", async () => {
    const session = await op<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      {
        title: `sgm-${TS}`,
      },
    );
    const AI: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: "sgm-ai",
      chatBranchId: session.chatBranchId,
      chatTaskId: session.chatSessionId,
    };
    await op(AI, "content_instances.set_values", {
      id: heroCi,
      values: { hero_title: "Draft headline", hero_body: "Draft body." },
    });

    const [onBranch] = await seoPages(AI, [pageId]);
    expect(onBranch?.contentText).toContain("Draft headline");
    expect(onBranch?.contentText).not.toContain("Pricing &");
    const [onMain] = await seoPages(SYS, [pageId]);
    expect(onMain?.contentText).toContain("Pricing & plans");
    expect(onMain?.contentText).not.toContain("Draft headline");
  });

  it("caps long text at a word boundary and says it was cut; reads several pages in one call", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const { pageId: longId } = await buildPage("long", long);
    const pages = await seoPages(SYS, [longId, pageId]);
    expect(pages.map((p) => p.pageId)).toEqual([longId, pageId]);
    const cut = pages[0];
    expect(cut?.contentTextTruncated).toBe(true);
    expect(cut?.contentText.length).toBeLessThanOrEqual(PAGE_CONTENT_TEXT_MAX);
    expect(cut?.contentText.endsWith("…")).toBe(true);
    // Cut between words: the last kept word is whole.
    expect(cut?.contentText).toMatch(/ word\d+…$/);
    expect(cut?.contentTextLength).toBeGreaterThan(PAGE_CONTENT_TEXT_MAX);
    expect(cut?.seo).toBeNull();
  });

  it("refuses an unknown page id and names it", async () => {
    const unknown = "11111111-1111-4111-8111-111111111111";
    const r = await execute(registry, adapter, SYS, "pages_seo.get_many", {
      pageIds: [pageId, unknown],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain(unknown);
  });
});
