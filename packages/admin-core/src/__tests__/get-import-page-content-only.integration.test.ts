// SPDX-License-Identifier: MPL-2.0

/**
 * issue #424 — `get_import_page` content-only mode against a real Postgres.
 *
 * A crawled page read used to deliver 40-50% ballast: source chrome
 * (twice — desktop + mobile DOM), consent text, and the raw WP preset-token
 * dump. The default view now strips all of it USING THE RUN'S OWN
 * CLASSIFICATIONS (blockName chrome modules + the persisted
 * imports.detect_boilerplate summary), reports loud counters (CLAUDE.md
 * §2), filters the token dump to values in use, and keeps the full capture
 * one `fullPage: true` away. The pageRef caches the FULL html either way,
 * so query_page_html still reaches stripped sections.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { getPageInspection } from "../ai/tools/_page-inspection-cache.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { getImportPageTool } from "../ai/tools/get-import-page.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const ACTOR_ID = "a4240000-0000-4000-8000-0000000a4240";
const RUN_ID = "a4241000-0000-4000-8000-0000000a4241";
const PAGE_IDS = [
  "a4242000-0000-4000-8000-0000000a4242",
  "a4243000-0000-4000-8000-0000000a4243",
  "a4244000-0000-4000-8000-0000000a4244",
] as const;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "content-only-test",
};

// Source chrome: identical on every page, extraction-classified as
// header/footer modules — layout-owned per #253/WS0.
const HEADER_HTML =
  '<header class="site-head"><nav class="main-nav"><ul><li><a href="/products">Products</a></li><li><a href="/pricing">Pricing overview</a></li><li><a href="/company">Company story</a></li></ul></nav></header>';
const FOOTER_HTML =
  '<footer class="site-foot"><div><p>Handcrafted in Hamburg since 2004.</p><a href="/imprint">Imprint</a><a href="/privacy">Privacy policy</a></div></footer>';

// A fixed CTA inside the CONTENT module of every page — chrome the
// boilerplate detector (not blockName) must catch.
const CTA_HTML =
  '<section class="newsletter-cta"><div><h3>Join our monthly newsletter</h3><p>Product updates and field notes, no spam ever.</p><a href="/signup">Subscribe now</a></div></section>';

// Consent modal (Complianz fingerprint) — only on page 1, mid-content,
// like the recorded searchviu crawl.
const CONSENT_HTML =
  '<div id="cmplz-cookiebanner-container"><div class="cmplz-body"><h4>Manage Consent</h4><p>We use cookies to store device information.</p><a href="#">Accept all cookies</a></div></div>';

// Desktop + mobile duplicate nav INSIDE the content module of page 1.
const INPAGE_NAV =
  '<nav class="toc-desktop"><a href="#intro">Introduction</a><a href="#specs">Specifications</a><a href="#faq">Common questions</a></nav>';
const INPAGE_NAV_MOBILE =
  '<div class="toc-mobile" role="navigation"><a href="#intro">Introduction</a><a href="#specs">Specifications</a><a href="#faq">Common questions</a></div>';

function contentHtml(unique: string, extras = ""): string {
  return `<main><article><h1>${unique} heading</h1><p>The ${unique} article body carries plenty of page-specific prose so extraction records it.</p><a href="/${unique}">Read more about ${unique}</a></article>${extras}${CTA_HTML}</main>`;
}

const THEME_TOKENS = {
  "--brand-primary": "#dc2626",
  "--wp--preset--color--vivid-red": "#cf2e2e",
  "--wp--preset--color--pale-pink": "#f78da7",
  "--wp--preset--shadow--natural": "6px 6px 9px rgba(0, 0, 0, 0.2)",
};

// Page 1 references vivid-red via var() — pale-pink + shadow are dump noise.
const PAGE1_CONTENT = contentHtml("falcon", CONSENT_HTML + INPAGE_NAV + INPAGE_NAV_MOBILE).replace(
  "<h1>falcon heading</h1>",
  '<h1 style="color: var(--wp--preset--color--vivid-red)">falcon heading</h1>',
);

async function seed(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM import_runs WHERE id = ${RUN_ID}::uuid`;
      await tx`
        INSERT INTO actors (id, kind, display_name)
        VALUES (${ACTOR_ID}::uuid, 'ai', 'content-only test AI')
        ON CONFLICT (id) DO NOTHING`;
      await tx`
        INSERT INTO import_runs (id, source_url, proposed_by, status)
        VALUES (${RUN_ID}::uuid, 'https://content-only.test/', ${ACTOR_ID}::uuid, 'ready_for_review')`;
      const pages: Array<{ id: string; slug: string; body: string }> = [
        { id: PAGE_IDS[0], slug: "falcon", body: PAGE1_CONTENT },
        { id: PAGE_IDS[1], slug: "heron", body: contentHtml("heron") },
        { id: PAGE_IDS[2], slug: "osprey", body: contentHtml("osprey") },
      ];
      for (const p of pages) {
        const modules = JSON.stringify([
          { blockName: "header", position: 0, html: HEADER_HTML, displayName: "Header (imported)" },
          { blockName: "content", position: 1, html: p.body, displayName: "Body (imported)" },
          { blockName: "footer", position: 2, html: FOOTER_HTML, displayName: "Footer (imported)" },
        ]);
        await tx`
          INSERT INTO import_pages
            (id, run_id, source_url, proposed_slug, proposed_title, proposed_modules, proposed_theme_tokens)
          VALUES (${p.id}::uuid, ${RUN_ID}::uuid, ${`https://content-only.test/${p.slug}`},
                  ${p.slug}, ${p.slug}, ${modules}::jsonb, ${JSON.stringify(THEME_TOKENS)}::jsonb)`;
      }
    });
  } finally {
    await sql.end();
  }
}

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await seed();
  // The REAL detector persists the boilerplate summary the read consumes.
  const detected = await execute(registry, adapter, SYSTEM, "imports.detect_boilerplate", {
    runId: RUN_ID,
    minPages: 2,
  });
  if (!detected.ok) throw new Error(JSON.stringify(detected.error));
});

afterAll(async () => {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM import_runs WHERE id = ${RUN_ID}::uuid`;
    });
  } finally {
    await sql.end();
  }
  await adapter.close();
});

function toolCtx(sessionId: string): ToolContext {
  return { adapter, registry, chatSessionId: sessionId } as ToolContext;
}

describe("get_import_page content-only mode (issue #424)", () => {
  it("op exposes the chrome-free join, chrome blockNames, and the run's boilerplate summary", async () => {
    const r = await execute(registry, adapter, SYSTEM, "imports.get_page_gist", {
      importPageId: PAGE_IDS[1],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const g = r.value as {
      html: string;
      contentHtml: string;
      chromeModuleBlocks: string[];
      boilerplateSummary: { candidates: unknown[] } | null;
    };
    expect(g.html).toContain("main-nav");
    expect(g.contentHtml).not.toContain("main-nav");
    expect(g.contentHtml).not.toContain("Handcrafted in Hamburg");
    expect(g.contentHtml).toContain("heron heading");
    expect(g.chromeModuleBlocks).toEqual(["header", "footer"]);
    expect(g.boilerplateSummary?.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("default read is content-only: chrome, consent, duplicate nav and preset noise gone — counters LOUD", async () => {
    const res = await getImportPageTool.handler(
      SYSTEM,
      { importPageId: PAGE_IDS[0] },
      toolCtx("content-only-session"),
    );
    expect(res.ok).toBe(true);
    const c = res.content;

    // Loud counters, one per strip family.
    expect(c).toContain("## Stripped from this read");
    expect(c).toContain(
      "- source chrome modules (layout-owned — bind ONCE at the layout, never per page): header, footer",
    );
    // All three seed pages share one implicit cluster, so the detector
    // places the fixed CTA at TEMPLATE level — still chrome, still stripped.
    expect(c).toContain("template-owned per the run's boilerplate detection");
    expect(c).toContain("join our monthly newsletter"); // candidate sampleText in the counter
    expect(c).toContain("- consent noise: 1 cookie/GDPR subtree(s)");
    expect(c).toContain("- duplicate nav DOM (desktop + mobile clone): 1 collapsed");
    expect(c).toContain("- design tokens: 2 unreferenced --wp--preset--* entries dropped");

    // The ballast itself is gone from the surfaced Markdown…
    expect(c).not.toContain("Pricing overview"); // header nav
    expect(c).not.toContain("Handcrafted in Hamburg"); // footer
    expect(c).not.toContain("Manage Consent"); // consent modal
    expect(c).not.toContain("no spam ever"); // site-wide CTA (boilerplate-stripped)
    // …the page's own content is not.
    expect(c).toContain("falcon heading");
    expect(c).toContain("page-specific prose");
    // The in-page nav survives ONCE (first occurrence), not twice.
    expect(c.match(/Specifications/g)?.length).toBe(1);

    // Token facet: non-preset + referenced presets stay, noise is dropped.
    expect(c).toContain("--brand-primary");
    expect(c).toContain("--wp--preset--color--vivid-red");
    expect(c).not.toContain("--wp--preset--color--pale-pink");

    // The no-raw-HTML contract holds with counters present.
    expect(c).not.toContain("<div");
    expect(c).not.toContain("<header");

    // The pageRef caches the FULL capture (raw stays reachable for
    // query_page_html) while the paginated Markdown is content-only.
    const pageRef = c.match(/pg_[a-z0-9]+/)?.[0];
    expect(pageRef).toBeDefined();
    const cached = getPageInspection(pageRef!);
    expect(cached?.html).toContain("main-nav");
    expect(cached?.markdown).not.toContain("Pricing overview");
  });

  it("fullPage: true opts out — today's full output, no counters", async () => {
    const res = await getImportPageTool.handler(
      SYSTEM,
      { importPageId: PAGE_IDS[0], fullPage: true },
      toolCtx("full-page-session"),
    );
    expect(res.ok).toBe(true);
    const c = res.content;
    expect(c).not.toContain("## Stripped from this read");
    // Chrome + consent text and the raw token dump are all back.
    expect(c).toContain("Pricing overview");
    expect(c).toContain("Handcrafted in Hamburg");
    expect(c).toContain("Manage Consent");
    expect(c).toContain("--wp--preset--color--pale-pink");
    expect(c).toContain("--wp--preset--shadow--natural");
    // The no-raw-HTML contract is mode-independent.
    expect(c).not.toContain("<div");
  });

  it("run without a boilerplate summary says so LOUDLY instead of silently skipping", async () => {
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`UPDATE import_runs SET boilerplate_summary = NULL WHERE id = ${RUN_ID}::uuid`;
      });
    } finally {
      await sql.end();
    }
    const res = await getImportPageTool.handler(
      SYSTEM,
      { importPageId: PAGE_IDS[1] },
      toolCtx("no-summary-session"),
    );
    expect(res.ok).toBe(true);
    const c = res.content;
    // blockName chrome still goes; the in-content CTA cannot (no summary) —
    // and the read SAYS so.
    expect(c).toContain("source chrome modules");
    expect(c).toContain("no boilerplate summary");
    expect(c).toContain("Join our monthly newsletter");
  });
});
