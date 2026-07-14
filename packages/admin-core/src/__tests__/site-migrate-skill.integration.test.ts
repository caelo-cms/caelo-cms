// SPDX-License-Identifier: MPL-2.0

/**
 * issue #188 / #278 — the site-migrate skill against the real Postgres
 * (CLAUDE.md §6: no mocked DB). Verifies the seeded row, the
 * keyword-matcher engagement for the messages operators actually type
 * (domain-shaped first messages included), and the behavioural contract
 * lines the body must carry.
 *
 * The behavioural contract tracks the #278 flow rewrite (migration
 * 0150): the body no longer describes the old upfront-crawl +
 * "build all URLs at once?" route (compose_from_import, the A/B/C
 * redesign fork, PLAN CHECK / pilot scope). It now encodes the
 * fail-fast, homepage-first flow — UNDERSTAND → HOMEPAGE FIRST → EARLY
 * CHECKPOINT (fidelity self-analysis + "passt die Richtung?") → FAN OUT
 * per page type → FINISH — plus the cross-cutting cost gate and the
 * loud-honesty rules preserved from earlier amendments.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { matchSkills } from "@caelo-cms/shared";
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

  it("body carries the #278 fail-fast, homepage-first flow", () => {
    const b = skill.body;
    // Look before you talk; the URL-only opener still leads.
    expect(b).toContain("inspect_external_page");
    expect(b).toContain("always look at the real site first");
    expect(b).toContain("0. NO URL YET");
    // The flow is homepage-first + fail-fast, NOT a blind upfront crawl.
    expect(b).toContain("FAIL-FAST, HOMEPAGE-FIRST (issue #278)");
    expect(b).toContain("1. UNDERSTAND");
    expect(b).toContain("2. HOMEPAGE FIRST");
    expect(b).toContain("3. EARLY CHECKPOINT");
    expect(b).toContain("4. FAN OUT PER PAGE TYPE");
    expect(b).toContain("5. NOT EVERYTHING");
    expect(b).toContain("6. FINISH");
    // Step 1 discovery tool + facet-scoped cheap inspect.
    expect(b).toContain("map_external_page_types");
    expect(b).toContain("links:true, meta:true");
    // Step 3 early checkpoint — visual self-analysis then operator confirm.
    expect(b).toContain("verify_import_page_fidelity");
    expect(b).toContain("So sieht deine Startseite aus — passt die Richtung?");
    expect(b).toContain("offer_choices");
    // Step 4 fan-out — boilerplate dedup, inventory proof, disjoint subagents.
    expect(b).toContain("detect_import_boilerplate");
    expect(b).toContain("check_page_content_inventory");
    expect(b).toContain("spawn_subagents");
    expect(b).toContain("DISJOINT page sets");
    expect(b).toContain("migrate_media");
    // The rebuild contract is preserved (content sacred, markup rebuilt).
    expect(b).toContain("THE REBUILD CONTRACT");
    expect(b).toContain("REPLACE IN ONE STEP");
    expect(b).toContain("CONTENT COMPLETENESS");
    expect(b).toContain("IMPROVE BY DEFAULT");
    expect(b).toContain("CHROME IS LAYOUT-OWNED");
    // No "build all at once?" prompt, no blind upfront crawl.
    expect(b).toContain("build them all at once?");
    expect(b).not.toContain("build all URLs at once");
    expect(b).not.toContain("compose_from_import");
    // §11.A two-step approval contract — preserved, but for a SCOPED
    // list-mode import (never a full-origin depth crawl).
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
});

describe("site-migrate auto-engagement", () => {
  const activeSkills = () => [
    {
      id: "00000000-0000-4000-8000-000000000188",
      slug: "site-migrate",
      displayName: "Site Migration",
      hints: skill.auto_engagement_hints,
    },
    {
      id: "00000000-0000-4000-8000-000000000163",
      slug: "site-genesis",
      displayName: "Site Genesis",
      hints: {
        keywords: ["new website", "from scratch", "design my site"],
        chipTrigger: false,
        alwaysOn: false,
      },
    },
  ];

  const engagedFor = (message: string): string[] =>
    matchSkills({ skills: activeSkills(), userMessage: message, chipCount: 0 }).map((m) => m.slug);

  it.each([
    "Meine Website ist https://example.com, bitte übernehmen",
    "please migrate my site to caelo",
    "wir wollen mit unserer bestehenden website umziehen",
    "can you import my existing website? it's at www.acme-tools.example",
    "our site is at acme.de and we want to move it here",
    // 0126 — the first-run chip's own message + natural phrasings.
    "I have an existing website that I'd like to migrate to Caelo.",
    "I already have a website",
    "wir haben schon eine website und wollen zu caelo",
  ])("engages for: %s", (message) => {
    expect(engagedFor(message)).toContain("site-migrate");
  });

  it("does not engage on unrelated content edits", () => {
    expect(engagedFor("make the hero headline bolder")).not.toContain("site-migrate");
  });

  it("from-scratch requests engage genesis, not migrate", () => {
    const engaged = engagedFor("I want a brand new website designed from scratch");
    expect(engaged).toContain("site-genesis");
    expect(engaged).not.toContain("site-migrate");
  });
});
