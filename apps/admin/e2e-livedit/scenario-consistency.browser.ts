// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario (issue #161 tier 2, epic #149) — cross-page visual consistency.
 *
 * The operator requirement behind the design-quality epic, verbatim: page B
 * must look like it belongs to the same site as page A. One chat builds two
 * pages; after Publish, the COMPUTED styles of the same role on both pages
 * must match — the primary call-to-action (fill, text color, radius, font)
 * and the section heading (family, weight, size within a fluid-type band).
 * The prompt deliberately does NOT ask for consistency: per §1A the
 * operator never says "reuse the button primitive", so the AI has to get
 * there unprompted through the primitives (#152), the Design Manifest
 * (#165) and the consistency gate (#166). A failure here means one of those
 * stopped carrying.
 *
 * Both pages also run through the rendered-design floor and the
 * non-blocking AI-judge rubric (`design-report.jsonl`).
 *
 * OPT-IN, not PR-gating: set CAELO_LIVEDIT_CONSISTENCY=1 to run. Building,
 * staging, auditing and publishing two pages is a second homepage-sized
 * run (~15 min, a full scenario's token spend); the PR job's 65-minute
 * budget is already spent on the per-PR scenarios. Run it nightly /
 * on demand and with the 10x determinism recipe before promoting it.
 */

import { judgeDesign, probeDesign, probeRoleStyles, recordDesignReport } from "./design-probe.js";
import { expect, test } from "./fixtures.js";
import {
  assertNoChatRunnerDiagWarnings,
  assertNoOrphanLocks,
  attachChatSessionTracker,
  awaitAiStaged,
  awaitPublishComplete,
  awaitQualityGateOpen,
  getProductionUrl,
  loginAsDevOwner,
  resetLiveditFixtures,
  runBunInline,
  sendChatPromptAndWait,
} from "./helpers.js";
import {
  checkColorVariety,
  checkTypeHierarchy,
  compareStyleSnapshots,
  findTemplateLeaks,
  pickPrimaryCta,
} from "./lib/design-assertions.js";

const TWO_PAGE_PROMPT =
  "Build a small website for Lumen Ledger, a bookkeeping app for freelancers: a homepage and a " +
  "Pricing page. Pick a fitting color scheme with real brand colors (not black-and-white). " +
  "The homepage needs a hero with a 'Start free trial' button and two more sections with headings; " +
  "the Pricing page needs a heading per section, three plans, and a 'Start free trial' button too.";

interface BuiltPage {
  readonly title: string;
  readonly currentPath: string;
}

/**
 * The published (main-branch) pages created or touched since `sinceIso`,
 * with their served path. Draft-branch copies are excluded: only what the
 * AI staged into main can be on the production site.
 */
function builtPagesSince(sinceIso: string): BuiltPage[] {
  const raw = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    let rows = [];
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      rows = await tx\`
        SELECT title, current_path AS "currentPath"
        FROM pages
        WHERE deleted_at IS NULL
          AND chat_branch_id IS NULL
          AND GREATEST(created_at, updated_at) >= \${process.env.SINCE}::timestamptz
        ORDER BY current_path
      \`;
    });
    await sql.end();
    process.stdout.write(JSON.stringify(rows));
    `,
    { SINCE: sinceIso },
  );
  return JSON.parse(raw.trim()) as BuiltPage[];
}

/** Production URL of a served path; directory style needs the trailing slash. */
function productionUrlOf(currentPath: string): string {
  const origin = getProductionUrl().replace(/\/+$/, "");
  const path = currentPath.endsWith("/") ? currentPath : `${currentPath}/`;
  return `${origin}${path}`;
}

test.describe("e2e-livedit consistency — two pages, one design", () => {
  test.skip(
    process.env.CAELO_LIVEDIT_CONSISTENCY !== "1",
    "opt-in (CAELO_LIVEDIT_CONSISTENCY=1) — a second full build+publish run; nightly/on-demand cost, not per-PR",
  );

  test.beforeEach(() => {
    resetLiveditFixtures();
  });

  test("homepage and pricing page share CTA and heading styles after publish", async ({ page }) => {
    // Two pages, a Stage, up to two quality-gate fix rounds, a Publish.
    test.setTimeout(30 * 60_000);
    const start = new Date().toISOString();
    const tracker = attachChatSessionTracker(page);

    await loginAsDevOwner(page);
    await page.goto("/edit");
    await sendChatPromptAndWait(page, TWO_PAGE_PROMPT);
    const sessionId = tracker.currentSessionId();
    expect(sessionId, "Expected the SSE tracker to capture a chat session id").not.toBeNull();
    if (!sessionId) throw new Error("unreachable");

    await awaitAiStaged(start);
    await awaitQualityGateOpen(page, sessionId);
    await awaitPublishComplete(page);

    const pages = builtPagesSince(start);
    const home = pages.find((p) => p.currentPath === "/");
    const pricing = pages.find((p) => /pric/i.test(p.currentPath) || /pric/i.test(p.title));
    expect(
      home && pricing,
      `Expected a homepage at "/" and a pricing page among the built pages, got: ${JSON.stringify(pages)}`,
    ).toBeTruthy();
    if (!home || !pricing) throw new Error("unreachable");

    const roles = [];
    for (const built of [home, pricing]) {
      const url = productionUrlOf(built.currentPath);
      const res = await page.request.get(url);
      expect(res.status(), `GET ${url}`).toBeLessThan(400);
      expect(findTemplateLeaks(await res.text()), `template leaks on ${url}`).toEqual([]);

      await page.goto(url);
      const probe = await probeDesign(page);
      const violations = [...checkTypeHierarchy(probe.type), ...checkColorVariety(probe.colors, 1)];
      recordDesignReport({
        scenario: "consistency",
        url,
        probe,
        violations,
        judge: await judgeDesign(page),
      });
      expect(violations, `rendered design floor on ${url}`).toEqual([]);
      roles.push({ url, styles: await probeRoleStyles(page) });
    }

    const [a, b] = roles;
    if (!a || !b) throw new Error("unreachable");
    const ctaA = pickPrimaryCta(a.styles.ctaCandidates);
    const ctaB = pickPrimaryCta(b.styles.ctaCandidates);
    expect(ctaA, `no filled chromatic call-to-action on ${a.url}`).not.toBeNull();
    expect(ctaB, `no filled chromatic call-to-action on ${b.url}`).not.toBeNull();
    expect(a.styles.h2, `no section heading (h2) on ${a.url}`).not.toBeNull();
    expect(b.styles.h2, `no section heading (h2) on ${b.url}`).not.toBeNull();
    if (!ctaA || !ctaB || !a.styles.h2 || !b.styles.h2) throw new Error("unreachable");

    // Fluid `clamp()` type may land a few px apart between sections of
    // different width; family and weight are tokens and must be identical.
    const consistency = [
      ...compareStyleSnapshots(
        `primary CTA ("${ctaA.text}" vs "${ctaB.text}")`,
        ctaA.styles,
        ctaB.styles,
      ),
      ...compareStyleSnapshots("section heading h2", a.styles.h2, b.styles.h2, {
        "font-size": 0.2,
      }),
    ];
    recordDesignReport({
      scenario: "consistency",
      url: `${a.url} vs ${b.url}`,
      violations: consistency,
    });
    expect(consistency, "the two pages do not read as one site (issue #161)").toEqual([]);

    assertNoOrphanLocks(sessionId);
    assertNoChatRunnerDiagWarnings();
  });
});
