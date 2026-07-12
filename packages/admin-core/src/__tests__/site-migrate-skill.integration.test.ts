// SPDX-License-Identifier: MPL-2.0

/**
 * issue #188 — the site-migrate skill (migration 0112) against the
 * real Postgres (CLAUDE.md §6: no mocked DB). Verifies the seeded row,
 * the keyword-matcher engagement for the messages operators actually
 * type (domain-shaped first messages included), and the behavioural
 * contract lines the body must carry: inspect-before-fork, the ONE
 * fork question, the §11.A two-step crawl contract, and the
 * never-claim-it-ran rule the e2e scenario (#200) asserts end-to-end.
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

  it("body carries the behavioural contract", () => {
    const b = skill.body;
    // Look before you talk; glance tools by name.
    expect(b).toContain("inspect_external_page");
    expect(b).toContain("screenshot_external_page");
    expect(b).toContain("always look at the real site first");
    // One decision at a time; fork + scope are clickable choices.
    expect(b).toContain("0. NO URL YET");
    expect(b).toContain("offer_choices");
    expect(b).toContain("Full redesign");
    // §11.A two-step contract — chat-first since 0121, strip-anchored
    // since 0122: the Approve click lives on the proposal card /
    // pending strip right above the chat input, never an admin page.
    expect(b).toContain("TWO-STEP flow");
    expect(b).toContain("Pending your approval");
    expect(b).toContain("right above the input box");
    expect(b).toContain("Never send them to an admin page");
    expect(b).toContain("NEVER claim the crawl ran");
    // Background-job honesty: crawl status handling is spelled out.
    expect(b).toContain("ready_for_review");
    // 0122: ONE plan question (scope + cost) BEFORE queueing — the AI
    // must wait for the answer, not pitch and queue in one message.
    expect(b).toContain("PLAN CHECK");
    expect(b).toContain("WAIT for the answer");
    expect(b).toContain("never queue a proposal in the same message");
    expect(b).toContain("AI budget");
    expect(b).toContain("Pilot first");
    // Both fork branches route somewhere real.
    expect(b).toContain("compose_from_import");
    expect(b).toContain("site-genesis");
    // Loud-honesty tail.
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
