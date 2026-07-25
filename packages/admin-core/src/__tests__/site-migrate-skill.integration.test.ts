// SPDX-License-Identifier: MPL-2.0

/**
 * issue #188 / #278 — the site-migrate skill against the real Postgres
 * (CLAUDE.md §6: no mocked DB). Verifies the seeded row, the
 * keyword-matcher engagement for the messages operators actually type
 * (domain-shaped first messages included), and the behavioural contract
 * lines the body must carry.
 *
 * The behavioural contract tracks the STAGED flow rewrite (migration
 * 0178, superseding the #278 body 0150 and dropping the 0173 "CRAWL
 * FIRST" guard). The crawl is no longer the first move: the body encodes
 * a staged rebuild — UNDERSTAND + DESIGN DIRECTION → HOMEPAGE FIRST (the
 * homepage ALONE as the design anchor) → HOMEPAGE CHECKPOINT (fidelity
 * self-analysis + "passt die Richtung?") → KEY PAGE TYPES (a few
 * representatives, then "another type or mass-import?") → MASS IMPORT
 * (the DEPTH crawl as the long-tail bulk tool, compose_from_import +
 * disjoint subagents) → FINISH — plus the cross-cutting cost gate and
 * the loud-honesty rules preserved from earlier amendments.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

let sqlc: SQL;
let skill: {
  slug: string;
  status: string;
  body: string;
  auto_engagement_hints: {
    keywords: string[];
    chipTrigger: boolean;
    alwaysOn: boolean;
  };
};

beforeAll(async () => {
  sqlc = new SQL(ADMIN_URL!);
  const rows = (await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    return await tx`
      SELECT slug, status, body, auto_engagement_hints
      FROM skills WHERE slug = 'site-migrate' LIMIT 1
    `;
  })) as unknown as (typeof skill)[];
  if (!rows[0]) throw new Error("site-migrate skill row missing — is migration 0112 applied?");
  skill = rows[0];
});

afterAll(async () => {
  await sqlc.end();
});

describe("site-migrate skill row (#188)", () => {
  it("is seeded ACTIVE — the 90% onboarding case must not wait for an activation click", () => {
    expect(skill.status).toBe("active");
  });

  it("body carries the staged homepage-first flow (0178)", () => {
    const b = skill.body;
    // Look before you talk; the URL-only opener still leads.
    expect(b).toContain("inspect_external_page");
    expect(b).toContain("always look at the real site first");
    expect(b).toContain("0. NO URL YET");
    // The flow is homepage-first + fail-fast + STAGED, NOT a blind upfront
    // crawl. Migration 0178 restructured it into homepage -> key types ->
    // mass import, dropping the 0173 "CRAWL FIRST" guard.
    expect(b).toContain("FAIL-FAST, HOMEPAGE-FIRST");
    expect(b).toContain("STAGED (HOMEPAGE -> KEY TYPES -> MASS IMPORT)");
    expect(b).toContain("1. UNDERSTAND");
    expect(b).toContain("2. HOMEPAGE FIRST");
    expect(b).toContain("3. HOMEPAGE CHECKPOINT");
    expect(b).toContain("4. KEY PAGE TYPES");
    expect(b).toContain("5. MASS IMPORT");
    expect(b).toContain("6. FINISH");
    // The 0173 "CRAWL FIRST" ordering guard is gone — the crawl is the LAST
    // tool, not the first gated proposal.
    expect(b).not.toContain("CRAWL FIRST");
    // Step 1 discovery tool + facet-scoped cheap inspect (Markdown GIST).
    expect(b).toContain("map_external_page_types");
    expect(b).toContain("markdown:true, meta:true, links:true");
    // Step 1 DESIGN DIRECTION (migration 0176) — the operator picks the design
    // intent (1:1 / refresh / optimize) up front, via offer_choices.
    expect(b).toContain("DESIGN DIRECTION");
    expect(b).toContain("1:1 BEIBEHALTEN");
    expect(b).toContain("AUFFRISCHEN");
    expect(b).toContain("OPTIMIERTER VORSCHLAG");
    // The rebuild contract keys its improve-vs-preserve stance off that choice.
    expect(b).toContain("FOLLOW THE CHOSEN DIRECTION");
    // Step 2 (0187) — the homepage is INSPECTED LIVE (no crawl); media is
    // imported first via import_media_from_urls, then built with Caelo URLs.
    expect(b).toContain("INSPECT the homepage LIVE");
    // Step 3 homepage checkpoint (0189) — the screenshot-diff fidelity gate is
    // GONE (reflow-brittle, wrong for a refresh direction); correctness is a
    // content-inventory + a VISUAL self-check, then the operator confirm.
    expect(b).not.toContain("verify_import_page_fidelity");
    expect(b).toContain("SELF-CHECK the homepage two ways");
    expect(b).toContain("get_import_page_screenshot");
    expect(b).toContain("passt die Richtung?");
    expect(b).toContain("offer_choices");
    // 0189 — sub-pages follow the same (simpler) loop as the homepage.
    expect(b).toContain("SUB-PAGES FOLLOW THE HOMEPAGE WORKFLOW");
    // Step 4 key types — boilerplate dedup, a FEW representatives, then the
    // "another type or mass-import?" checkpoint before the crawl.
    expect(b).toContain("detect_import_boilerplate");
    expect(b).toContain("check_page_content_inventory");
    expect(b).toContain("Rest jetzt importieren");
    // Step 5 mass import — the DEPTH crawl is the long-tail intake, but every
    // page is REBUILT via build_page (disjoint subagents applying the built
    // type patterns). compose_from_import (the raw-materialise shortcut that
    // dumps the source's page-builder markup) is dropped from the flow entirely.
    expect(b).toContain("DEPTH mode");
    expect(b).not.toContain("compose_from_import");
    expect(b).toContain("spawn_subagents");
    expect(b).toContain("DISJOINT page sets");
    // 0187 — media is IMPORT-FIRST via import_media_from_urls; the removed
    // scan-and-rewrite migrate_media must no longer appear in the body.
    expect(b).not.toContain("migrate_media");
    expect(b).toContain("import_media_from_urls");
    expect(b).toContain("ASSETS FIRST, THEN BUILD");
    // The rebuild contract is preserved (content sacred, markup rebuilt).
    expect(b).toContain("THE REBUILD CONTRACT");
    expect(b).toContain("REPLACE IN ONE STEP");
    expect(b).toContain("CONTENT COMPLETENESS");
    expect(b).toContain("CHROME IS LAYOUT-OWNED");
    // Operator directive (2026-07-22): the AI rebuilds page HTML from scratch
    // even for a 1:1 takeover — no imported page-builder classes may survive.
    expect(b).toContain("NO IMPORTED PAGE-BUILDER MARKUP");
    expect(b).toContain("elementor-");
    expect(b).toContain("1:1 INCLUDED");
    // No open "build all at once?" prompt dumped early.
    expect(b).toContain("build them all at once?");
    expect(b).not.toContain("build all URLs at once");
    // §11.A two-step approval contract — preserved for both the scoped
    // list-mode imports and the final depth crawl.
    expect(b).toContain("TWO-STEP flow");
    expect(b).toContain("LIST mode");
    expect(b).toContain("Pending your approval");
    expect(b).toContain("right above the input box");
    expect(b).toContain("Never send them to an admin page");
    expect(b).toContain("NEVER claim the crawl ran");
    expect(b).toContain("ready_for_review");
    // Cross-cutting: cost gate + finish/publish + loud honesty.
    expect(b).toContain("COST GATE");
    expect(b).toContain("check_run_budget");
    expect(b).toContain("set_migration_budget");
    expect(b).toContain("log_page_edit");
    expect(b).toContain("set_pages_status_many");
    expect(b).toContain("never claim a gated action was applied");
  });

  it("instructs passing importPageId to build_page + the staging id to the inventory check (0197)", () => {
    // Dev-run regression: a rebuilt sub-page failed check_page_content_inventory
    // with "import page not found" because build_page was called WITHOUT
    // importPageId — so no accepted_page_id link was stamped, and the built
    // page's TRANSLATED slug could not reverse-map to the crawled page. The
    // skill must now tell the AI to (a) always pass importPageId to build_page
    // (links the crawl + idempotent) and (b) prefer the staging import id for
    // the inventory check (it always resolves).
    const b = skill.body;
    // (a) build contract carries importPageId with the reason.
    expect(b).toContain("ALWAYS carrying `importPageId`");
    expect(b).toContain("`accepted_page_id`");
    // The subagent brief hands the id AND says to pass it to build_page.
    expect(b).toContain("PASSING that import page id as `importPageId`");
    // (b) inventory gate prefers the always-resolving staging id.
    expect(b).toContain("pass the page's STAGING import_pages id");
  });
});
