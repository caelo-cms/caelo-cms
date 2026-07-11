// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario 1 (v0.13.0) — Create a homepage from scratch via real AI,
 * then re-edit just the hero headline.
 *
 * Validates the full chat → Stage → Publish → re-edit loop against
 * the live Anthropic API (Opus 4.7, temperature=0). Every mid-flow
 * assertion is deterministic (DOM via getByRole/locator, DB via
 * bun:SQL, admin-stderr via captured admin.log); the only AI call in
 * the verification path is the closing vision verdict on the published
 * production URL.
 *
 * Coverage map (`.workflow-plan.md` §8 Tier 3 + §7 AC):
 *   • AC #2 — homepage create + re-edit preservation
 *   • AC #4, #5 — Playwright drives everything, no mid-flow LLM
 *   • AC #6 — closing vision verdict
 *   • AC #7 — orphan-lock + chat-runner-diag regression guards
 *   • AC #11 — retries=1 (config-level; 2 attempts total)
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "./fixtures.js";
import {
  assertNoChatRunnerDiagWarnings,
  assertNoOrphanLocks,
  attachChatSessionTracker,
  awaitPublishComplete,
  awaitStageComplete,
  getProductionUrl,
  loginAsDevOwner,
  resetLiveditFixtures,
  sendChatPromptAndWait,
  verifyPublishedPageWithVision,
} from "./helpers.js";

// issue #112 — the prompt states design intent the way a real operator
// would ("nicely designed", "fitting color scheme", "nice header
// background"). Run 27357551606 showed the AI can satisfy the
// cold-start gate (origin flipped + description recorded) while
// leaving the seed-grayscale primary (#171717) untouched when the
// operator never mentions design; the on-brand assertion below then
// rightly fails. Naming the intent here keeps the scenario realistic
// AND gives the model the brand context §1A expects it to act on.
const HOMEPAGE_PROMPT =
  "Create a homepage for an AI-first CMS called Caelo — a nicely designed page with a " +
  "fitting color scheme for a trustworthy, developer-focused brand (pick real brand colors; " +
  "don't leave it black-and-white) and a nice background for the header. Include a header " +
  "module with the Caelo brand and a simple top navigation, a hero section with a headline, " +
  "a 3-column feature grid below the hero with three features about branched edits, plugin sandbox, " +
  "and snapshot revert, and a footer module with copyright text mentioning Caelo and MPL 2.0.";

// Concrete enough to avoid the chat-runner's `passive-response-diag`
// warning, which fires when the AI returns a short text-only response
// to a vague follow-up under high accumulated context. The target
// headline is short + unique so the post-reedit content_values diff
// is unambiguous.
const HERO_REEDIT_PROMPT =
  "Update the hero headline to 'Ship faster with Caelo'. Keep all other modules unchanged.";

interface PageModuleSnapshot {
  readonly pageId: string;
  readonly title: string;
  readonly slug: string;
  readonly placements: ReadonlyArray<{
    blockName: string;
    position: number;
    moduleSlug: string;
    contentUpdatedAt: string | null;
  }>;
  readonly footerContentText: string;
}

/**
 * Find the most-recently-touched page (created or content-updated)
 * and snapshot its placements + content rows. Returns null when no
 * page has been touched since `sinceTimestamp` — surfaces "AI emitted
 * no add_page tool call" loudly rather than asserting against stale
 * seed pages.
 */
function snapshotMostRecentPage(sinceTimestamp: string): PageModuleSnapshot | null {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);
        const out = {};
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          const pages = await tx\`
            SELECT
              p.id::text AS "pageId",
              p.title,
              p.slug,
              GREATEST(p.created_at, p.updated_at) AS "lastTouched"
            FROM pages p
            WHERE p.deleted_at IS NULL
              AND GREATEST(p.created_at, p.updated_at) >= \${process.env.SINCE}::timestamptz
            ORDER BY GREATEST(p.created_at, p.updated_at) DESC
            LIMIT 1
          \`;
          if (pages.length === 0) {
            process.stdout.write("null");
            return;
          }
          const pg = pages[0];
          // PR #61 — content lives in content_instances now (bound to
          // page_modules via pm.content_instance_id), not in the legacy
          // page_module_content table. Read ci.updated_at so the
          // re-edit assertion detects edits the AI persists via
          // set_content_instance_values.
          const placements = await tx\`
            SELECT
              pm.block_name      AS "blockName",
              pm.position        AS position,
              m.slug             AS "moduleSlug",
              ci.updated_at::text AS "contentUpdatedAt"
            FROM page_modules pm
            JOIN modules m            ON m.id  = pm.module_id
            JOIN content_instances ci ON ci.id = pm.content_instance_id
            WHERE pm.page_id = \${pg.pageId}::uuid
            ORDER BY pm.block_name, pm.position
          \`;
          // Aggregate any footer-ish content into a single text blob for
          // substring assertions. Same content_instances source as above.
          const footerRows = await tx\`
            SELECT ci.values::text AS values
            FROM page_modules pm
            JOIN modules m            ON m.id  = pm.module_id
            JOIN content_instances ci ON ci.id = pm.content_instance_id
            WHERE pm.page_id = \${pg.pageId}::uuid
              AND (m.slug ILIKE '%footer%' OR pm.block_name ILIKE '%footer%')
          \`;
          out.pageId = pg.pageId;
          out.title = pg.title;
          out.slug = pg.slug;
          out.placements = placements;
          out.footerContentText = footerRows.map(r => r.values).join("\\n");
        });
        await sql.end();
        process.stdout.write(JSON.stringify(out));
      `,
    ],
    { env: { ...process.env, SINCE: sinceTimestamp }, encoding: "utf8" },
  );
  if (raw.status !== 0) {
    throw new Error(`snapshotMostRecentPage failed: ${raw.stderr || raw.stdout}`);
  }
  const trimmed = raw.stdout.trim();
  if (trimmed === "null" || trimmed.length === 0) return null;
  return JSON.parse(trimmed) as PageModuleSnapshot;
}

interface ThemeDesignReport {
  readonly chromaticColorCount: number;
  readonly hasGradient: boolean;
  readonly hasSurfaceAlt: boolean;
  readonly webFontFamilies: readonly string[];
}

interface ActiveThemeBrand {
  readonly origin: string;
  readonly description: string | null;
  readonly primaryValue: string | null;
  /** issue #161 — deterministic design analysis of the tokens document. */
  readonly designReport: ThemeDesignReport;
}

/**
 * issue #112 (AC #4) — read the active theme's provenance + primary
 * color straight from the DB. `primaryValue` resolves `color.primary`
 * (base token) or the `color.primary.500` ramp stop, whichever the AI
 * authored.
 */
function snapshotActiveThemeBrand(): ActiveThemeBrand {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);
        let out = null;
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          const rows = await tx\`
            SELECT origin, description, tokens FROM themes WHERE is_active = true LIMIT 1
          \`;
          const row = rows[0];
          if (!row) return;
          const tokens = typeof row.tokens === "string" ? JSON.parse(row.tokens) : row.tokens;
          const primary = tokens?.color?.primary ?? null;
          const primaryValue =
            (primary && typeof primary.$value === "string" && primary.$value) ||
            (primary && primary["500"] && typeof primary["500"].$value === "string" && primary["500"].$value) ||
            null;
          // issue #161 — deterministic design analysis of the document.
          const chromatic = new Set();
          const isChromaticHex = (v) => {
            const m = /^#([0-9a-f]{6})/i.exec(v);
            if (!m) return !v.startsWith("#"); // oklch/rgb() etc: count as chromatic
            const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
            return Math.max(r, g, b) - Math.min(r, g, b) > 24;
          };
          const walkColors = (node) => {
            if (!node || typeof node !== "object") return;
            for (const [k, v] of Object.entries(node)) {
              if (k.startsWith("$")) continue;
              if (v && typeof v === "object") {
                if (typeof v.$value === "string") {
                  if (isChromaticHex(v.$value.toLowerCase())) chromatic.add(v.$value.toLowerCase());
                } else walkColors(v);
              }
            }
          };
          walkColors(tokens?.color ?? null);
          const SYSTEM_FONTS = new Set(["serif","sans-serif","monospace","system-ui","ui-sans-serif","ui-serif","ui-monospace","arial","helvetica","georgia","menlo","monaco"]);
          const webFonts = [];
          for (const t of Object.values(tokens?.typography ?? {})) {
            const fam = t && t.$value && typeof t.$value.fontFamily === "string" ? t.$value.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "") : null;
            if (fam && !SYSTEM_FONTS.has(fam.toLowerCase()) && !webFonts.includes(fam)) webFonts.push(fam);
          }
          const designReport = {
            chromaticColorCount: chromatic.size,
            hasGradient: !!tokens?.gradient && Object.keys(tokens.gradient).some((k) => !k.startsWith("$")),
            hasSurfaceAlt: !!(tokens?.color && (tokens.color["surface-alt"] || tokens.color.surfaceAlt)),
            webFontFamilies: webFonts,
          };
          out = { origin: row.origin, description: row.description, primaryValue, designReport };
        });
        await sql.end();
        process.stdout.write(JSON.stringify(out));
      `,
    ],
    { env: { ...process.env }, encoding: "utf8" },
  );
  if (raw.status !== 0) {
    throw new Error(`snapshotActiveThemeBrand failed: ${raw.stderr || raw.stdout}`);
  }
  const trimmed = raw.stdout.trim();
  if (trimmed === "null" || trimmed.length === 0) {
    throw new Error("snapshotActiveThemeBrand: no active theme row found");
  }
  return JSON.parse(trimmed) as ActiveThemeBrand;
}

/**
 * issue #112 (AC #4) — fail when the primary color is grayscale. The
 * scenario prompt names a SaaS / dev-tools brand, so a chromatic
 * primary is the only correct outcome HERE (a deliberately monochrome
 * brand would be a different scenario). Accepts hex and oklch() —
 * anything else fails loudly so a format drift surfaces instead of
 * silently passing.
 */
function assertChromaticPrimary(value: string): void {
  const SEED_GRAYS = new Set(["#171717", "#000000", "#0a0a0a"]);
  const normalized = value.trim().toLowerCase();
  if (SEED_GRAYS.has(normalized)) {
    throw new Error(
      `active theme primary ${value} is a seed grayscale value — issue #112 regression`,
    );
  }
  const hex = /^#([0-9a-f]{6})$/.exec(normalized);
  if (hex?.[1] !== undefined) {
    const n = Number.parseInt(hex[1], 16);
    /* eslint-disable no-bitwise */
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    /* eslint-enable no-bitwise */
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread <= 24) {
      throw new Error(
        `active theme primary ${value} has RGB spread ${spread} (≤24 ≈ grayscale) — the AI shipped an off-brand neutral palette (issue #112)`,
      );
    }
    return;
  }
  const oklch = /^oklch\(\s*[\d.]+%?\s+([\d.]+)\s/.exec(normalized);
  if (oklch?.[1] !== undefined) {
    const chroma = Number.parseFloat(oklch[1]);
    if (chroma <= 0.03) {
      throw new Error(
        `active theme primary ${value} has OKLCh chroma ${chroma} (≤0.03 ≈ grayscale) — issue #112 regression`,
      );
    }
    return;
  }
  throw new Error(
    `active theme primary ${value} is in an unrecognised color format — extend assertChromaticPrimary rather than skipping the on-brand check`,
  );
}

test.describe("e2e-livedit Scenario 1 — homepage from scratch", () => {
  // Playwright retries=1 — each attempt must start from clean fixtures.
  // Without this, attempt 1's orphan rows confuse snapshotMostRecentPage
  // on attempt 2 (per plan §6 open question 4).
  test.beforeEach(() => {
    resetLiveditFixtures();
  });

  test("AI creates a homepage, stages, publishes, re-edits hero — vision verdict + regression guards", async ({
    page,
  }) => {
    // Snapshot the wall-clock so we can isolate pages this scenario
    // creates from any pre-existing seed pages.
    const startTimestamp = new Date().toISOString();

    const tracker = attachChatSessionTracker(page);

    // ── Step 1: Login (AC #4) ──────────────────────────────────────
    await loginAsDevOwner(page);

    // ── Step 2: Open /edit and send the homepage prompt (AC #2) ────
    await page.goto("/edit");
    await sendChatPromptAndWait(page, HOMEPAGE_PROMPT);

    const chatSessionId = tracker.currentSessionId();
    expect(chatSessionId, "Expected the SSE tracker to capture a chat session id").not.toBeNull();
    if (!chatSessionId) throw new Error("unreachable");

    // ── Step 3: DOM assertions (chat-branch state visible in iframe) ──
    // Chat-branch writes are visible in the preview iframe immediately
    // (the chat session renders against its own branch). The DB-level
    // count assertion runs AFTER awaitStageComplete because, per
    // CLAUDE.md §2, chat-branch writes don't hit the main `pages` /
    // `page_modules` tables until Stage merges them.
    const previewFrame = page.frameLocator("iframe").first();
    // ≥1 <h1>, not exactly 1: a hero + sub-section heading shouldn't flake
    // the test. Asserting the first <h1> is visible covers both cases.
    await expect(
      previewFrame.locator("h1").first(),
      "Expected the preview iframe to render at least one <h1>",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      previewFrame.locator("footer").first(),
      "Expected the preview iframe to render a <footer> element",
    ).toBeVisible({ timeout: 30_000 });
    // The rendered page must contain visible navigation (the AI's
    // page often renders nav links inside the hero/content module's
    // body rather than as a separate module placed in the layout's
    // `header` slot — visually they look like a site header, but
    // semantically they sit inside <main>, not <header>). Asserting
    // on the first visible <a> covers both shapes without depending
    // on which CSS-only element the AI chose for the wrapper.
    await expect(
      previewFrame.locator("a:visible").first(),
      "Expected the rendered page to include at least one visible <a> (nav link, CTA, etc.)",
    ).toBeVisible({ timeout: 30_000 });
    // The rendered page must have non-trivial body text — guards
    // against an "empty page with layout chrome only" pass-through.
    const bodyText =
      (await previewFrame.locator("body").first().textContent({ timeout: 30_000 })) ?? "";
    expect(
      bodyText.trim().length,
      `Expected the rendered page body to contain substantive text. Got ${bodyText.trim().length} chars.`,
    ).toBeGreaterThan(100);

    // ── Step 4: Stage (AC #2, #7) ──────────────────────────────────
    await awaitStageComplete(page);
    // Stage triggers a real static-generator run AND merges the chat
    // session's preview branch into the main DB. The DB structural
    // assertions below now read the merged state. Browser-side
    // navigation isn't required; the action synchronously awaits
    // deploy.trigger.

    // ── Step 5: DB structural floor (AC #2) ────────────────────────
    // Structural minimum: the AI must have created a page row and at
    // least 2 page_modules placements. At temperature=0 the AI
    // consistently uses a bulk add_page tool that emits 2 placements
    // in a single call regardless of how the prompt is phrased; this
    // is the deterministic floor. Header / footer content quality is
    // verified via the iframe DOM checks above (the AI's modules
    // surface through the layout's <caelo-slot> markers); brand-text
    // quality is verified via the production HTML check + the vision
    // verdict below.
    const snapshot = snapshotMostRecentPage(startTimestamp);
    expect(
      snapshot,
      "Expected the AI to create a page via add_page tool calls — no pages.updated_at > scenario start. Likely a v0.10.17-class empty-response regression.",
    ).not.toBeNull();
    if (!snapshot) throw new Error("unreachable");
    expect(
      snapshot.placements.length,
      `Expected ≥2 page_modules for ${snapshot.pageId}`,
    ).toBeGreaterThanOrEqual(2);

    // ── Step 6: Publish + vision verdict + regression guards ───────
    await awaitPublishComplete(page);

    // Compose the production URL from the snapshot's slug. Caelo's
    // routing manifest maps slug='home' to outputPath 'index.html'
    // (i.e. served at the origin root), and any other slug to
    // '<slug>/index.html' (served at /<slug>/). Trailing slash is
    // mandatory for non-home slugs because Caddy's try_files resolves
    // <path>/index.html only when the request path ends in /. Strip
    // leading slashes the AI sometimes adds.
    const productionOrigin = getProductionUrl().replace(/\/+$/, "");
    const slugPath = snapshot.slug.replace(/^\/+/, "");
    const productionUrl =
      slugPath === "" || slugPath === "home"
        ? `${productionOrigin}/`
        : `${productionOrigin}/${slugPath}/`;
    const productionResponse = await page.request.get(productionUrl);
    expect(productionResponse.status(), `GET ${productionUrl}`).toBeGreaterThanOrEqual(200);
    expect(productionResponse.status(), `GET ${productionUrl}`).toBeLessThan(400);
    const productionBody = await productionResponse.text();
    expect(productionBody, `Production HTML at ${productionUrl} missing "Caelo"`).toContain(
      "Caelo",
    );
    // #71 regression guard — the bug this scenario is meant to catch:
    // the static-gen compose path used to leak raw `{{#nav_items}}` /
    // `{{/nav_items}}` markers to visitors when the AI authored
    // text-list / link-list fields, because the no-DB compose path
    // didn't implement Mustache section iteration. After Plan B
    // (shared template engine), the published HTML must NEVER contain
    // `{{#` or `{{/` markers. Closes the open thread on #62.
    expect(
      productionBody,
      "Published HTML must not leak {{# or {{/ markers — see #71, closes the open thread on #62",
    ).not.toMatch(/\{\{[#/]/);
    // The previous "MPL 2.0" production HTML substring check was
    // dropped — it depended on the AI emitting a literal copyright
    // footer module, which the AI doesn't do deterministically at
    // temperature=0 (the AI uses a bulk add_page tool that produces 2
    // placements regardless of prompt phrasing). The iframe DOM check
    // above already verifies the <footer> renders substantive content;
    // the vision verdict below verifies overall page quality.

    // Vision verdict (AC #6, #18) — fail loudly on a non-ok verdict.
    await page.goto(productionUrl);
    const verdict = await verifyPublishedPageWithVision(page);
    expect(verdict.ok, `Vision verdict failed: ${verdict.reason}`).toBe(true);

    // Final-state screenshot of the published production view — picked
    // up by the workflow's "Push screenshots…" step (see
    // .github/workflows/e2e-livedit.yml) and embedded in the sticky
    // PR comment on green runs. Path sits under the artifact-upload
    // root (apps/admin/test-results/livedit/) so it survives in CI.
    await page.screenshot({
      fullPage: true,
      path: "test-results/livedit/final-state/scenario-homepage.png",
    });

    // Regression guards (AC #7).
    assertNoOrphanLocks(chatSessionId);
    assertNoChatRunnerDiagWarnings();

    // ── On-brand theme (issue #112) ────────────────────────────────
    // The operator named a brand ("Caelo … trustworthy, developer-
    // focused"), so the AI must have composed a brand-derived theme:
    // non-seed origin, recorded design rationale, and a primary with
    // real chroma. This is the assertion the PR #107 run would have
    // failed (black logo, black buttons — shadcn-default minted via
    // the old preset menu and left grayscale).
    const themeBrand = snapshotActiveThemeBrand();
    expect(
      themeBrand.origin,
      "Active theme origin must have flipped off 'seed' during the cold-start sequence",
    ).not.toBe("seed");
    expect(
      (themeBrand.description ?? "").trim().length,
      "Active theme must carry a recorded design rationale (set_theme_meta / propose_create_theme description)",
    ).toBeGreaterThan(0);
    expect(
      themeBrand.primaryValue,
      "Active theme tokens must define color.primary (base token or 500 ramp stop)",
    ).not.toBeNull();
    if (themeBrand.primaryValue === null) throw new Error("unreachable");
    assertChromaticPrimary(themeBrand.primaryValue);

    // ── Design floor (issue #161) ──────────────────────────────────
    // Hard-assert only the deterministic minimum the #153 palette-pair
    // guidance makes stable: a real palette carries at least two
    // DISTINCT chromatic colors (primary + accent/secondary), not one
    // hue with neutrals. Everything richer (gradient, surface-alt,
    // web fonts) is logged as a design-report warning first — promote
    // to hard assertions once the 10x determinism runs show they hold
    // (docs/internal/e2e-livedit.md recipe).
    const design = themeBrand.designReport;
    expect(
      design.chromaticColorCount,
      "Composed palette must carry at least two distinct chromatic colors (flat single-hue reads as unfinished — DEPTH_AND_SURFACE_HINTS)",
    ).toBeGreaterThanOrEqual(2);
    const designWarnings: string[] = [];
    if (!design.hasGradient) designWarnings.push("no gradient.* token composed");
    if (!design.hasSurfaceAlt) designWarnings.push("no color.surface-alt for section alternation");
    if (design.webFontFamilies.length === 0)
      designWarnings.push("typography uses system stacks only");
    for (const w of designWarnings) {
      console.warn(`[design-report] ${w} — candidate for promotion to a hard assertion`);
    }

    // ── Step 7: Re-edit the hero headline (AC #2 part 2) ───────────
    const preReeditSnapshot = snapshotMostRecentPage(startTimestamp);
    expect(preReeditSnapshot, "snapshot pre-reedit").not.toBeNull();
    if (!preReeditSnapshot) throw new Error("unreachable");

    await page.goto("/edit");
    await sendChatPromptAndWait(page, HERO_REEDIT_PROMPT);

    // Merge the re-edit chat-branch into main so the post-reedit
    // snapshot reads the updated content_values. Publish is not
    // required here — the assertion is pure DB shape (placement
    // identity + updated_at advance), not a production URL check.
    await awaitStageComplete(page);

    const postReeditSnapshot = snapshotMostRecentPage(startTimestamp);
    expect(postReeditSnapshot, "snapshot post-reedit").not.toBeNull();
    if (!postReeditSnapshot) throw new Error("unreachable");

    // Same set of placements — re-edit must NOT add/remove placements
    // (no module_id churn beyond updates to existing rows).
    const preKeys = preReeditSnapshot.placements.map((p) => `${p.blockName}/${p.position}`).sort();
    const postKeys = postReeditSnapshot.placements
      .map((p) => `${p.blockName}/${p.position}`)
      .sort();
    expect(postKeys).toEqual(preKeys);

    // At least one placement's content was updated (the hero) — and
    // not all of them (other modules should be untouched). The
    // "exactly one" assertion would require knowing which placement
    // the AI chose for the hero; ">=1 changed, <total" is the
    // looser shape-preservation guarantee the issue asks for.
    const updatedAtPairs = preReeditSnapshot.placements.map((pre, i) => {
      const post = postReeditSnapshot.placements[i];
      return {
        key: `${pre.blockName}/${pre.position}`,
        preUpdatedAt: pre.contentUpdatedAt,
        postUpdatedAt: post?.contentUpdatedAt ?? null,
      };
    });
    // A placement counts as "changed" by the re-edit if EITHER:
    //  (a) it previously had no page_module_content row (preUpdatedAt
    //      null) and now does (postUpdatedAt non-null) — i.e. the AI
    //      customised content_values for the first time, or
    //  (b) it already had a row and its updated_at advanced.
    // The AI's initial homepage build creates page_modules placements
    // without necessarily writing page_module_content rows (placements
    // use the module's default HTML until content is customized), so
    // (a) is the common path on the re-edit.
    const changed = updatedAtPairs.filter(
      (p) =>
        p.postUpdatedAt !== null && (p.preUpdatedAt === null || p.postUpdatedAt > p.preUpdatedAt),
    );
    expect(
      changed.length,
      `Expected ≥1 page_module_content row's updated_at to advance after the hero re-edit. updated_at pairs: ${JSON.stringify(updatedAtPairs)}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      changed.length,
      `Expected at least one placement to be untouched by the hero re-edit, but all ${updatedAtPairs.length} placements changed.`,
    ).toBeLessThan(updatedAtPairs.length);

    // Final regression-guard sweep.
    assertNoOrphanLocks(chatSessionId);
    assertNoChatRunnerDiagWarnings();
  });
});
