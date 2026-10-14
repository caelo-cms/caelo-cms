// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — /settings/quality shows what the page checks found: a
 * blocking page-check rule on a page (rule id, message, count), the
 * non-blocking warnings next to it, the site-wide findings, and a
 * site-wide page-check acceptance with its accepted count. The same page
 * carries Lighthouse's Performance metrics (FCP, LCP, TBT, CLS, SI with
 * the LCP element and a layout shift), shown next to its scores. The audit run
 * is seeded straight into the tables in the shape
 * `quality_audits.record_result` writes; the ops themselves are covered by
 * the admin-core integration suite (quality-checks.integration.test.ts).
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const RUN_ID = crypto.randomUUID();
const REASON = `e2e-page-checks-${Date.now()}`;
const SLUG = `e2e-page-checks-${Date.now()}`;

function metric(
  id: string,
  label: string,
  title: string,
  value: number,
  display: string,
  score: number,
) {
  return {
    id,
    label,
    title,
    numericUnit: id === "cumulative-layout-shift" ? "unitless" : "millisecond",
    numericValue: value,
    displayValue: display,
    score,
    runValues: [value],
    unavailableReason: null,
  };
}

/** `quality_audit_pages.metrics` as record_result stores it (0274). */
const METRICS = JSON.stringify({
  runs: 1,
  metrics: [
    metric("first-contentful-paint", "FCP", "First Contentful Paint", 1200, "1.2 s", 0.97),
    metric("largest-contentful-paint", "LCP", "Largest Contentful Paint", 4100, "4.1 s", 0.21),
    metric("total-blocking-time", "TBT", "Total Blocking Time", 120, "120 ms", 0.97),
    metric("cumulative-layout-shift", "CLS", "Cumulative Layout Shift", 0.356, "0.356", 0.31),
    metric("speed-index", "SI", "Speed Index", 2200, "2.2 s", 0.99),
  ],
  lcpElement: { selector: "main > section.hero > img", label: "Hero" },
  lcpBreakdown: [{ subpart: "resourceLoadDelay", label: "Resource load delay", durationMs: 1800 }],
  layoutShifts: [
    {
      element: { selector: "body > header" },
      score: 0.356,
      causes: ["Unsized image element: header > img.logo"],
    },
  ],
});

test.beforeAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = (await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`)[0].id;
      // Its own page: the spec must not depend on pages other specs made.
      const page = (await tx\`
        INSERT INTO pages (slug, title, template_id, status, current_path)
        SELECT \${process.env.SLUG}, 'Page checks e2e', id, 'published', \${"/" + process.env.SLUG}
        FROM templates ORDER BY created_at LIMIT 1
        RETURNING id\`)[0];
      const deploy = (await tx\`
        INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at)
        SELECT id, \${actor}::uuid, 'succeeded', now() - interval '10 days', now() - interval '10 days'
        FROM deploy_targets WHERE name = 'staging'
        RETURNING id\`)[0];
      const problem = {
        kind: "check_rule", checkId: "seo-check", ruleId: "seo-check/title-missing",
        count: 1, allowed: 0,
        findings: [{ message: "No title: search engines show the URL instead." }],
      };
      const warning = {
        ruleId: "seo-check/title-long", severity: "warning", pageId: page.id,
        message: "Long title: 72 characters.",
      };
      const site = {
        kind: "check_rule", checkId: "robots", ruleId: "robots/blocked", count: 1, allowed: 0,
        findings: [{ message: "Robots block everything: robots.txt disallows /." }],
      };
      await tx\`
        INSERT INTO quality_audit_runs
          (id, deploy_run_id, requested_by, status, classification, finished_at, problem_count, checks)
        VALUES (\${process.env.RUN_ID}::uuid, \${deploy.id}::uuid, \${actor}::uuid, 'problems',
          \${JSON.stringify({ auditNeeded: false, reasons: [], skipped: ["field values: hero"] })}::jsonb,
          now(), 2,
          \${JSON.stringify({
            ran: [{ id: "seo-check", title: "SEO checks", scope: "page", source: { kind: "plugin", slug: "seo-check" } }],
            pagesChecked: 3,
            findingCounts: { error: 2, warning: 1, info: 0 },
            siteFindings: [{ ruleId: "robots/blocked", severity: "error", message: site.findings[0].message }],
            siteProblems: [site],
            errors: [],
          })}::jsonb)\`;
      await tx\`
        INSERT INTO quality_audit_pages
          (audit_run_id, page_id, url, status, scores, performance_runs, metrics, problems, check_findings)
        VALUES (\${process.env.RUN_ID}::uuid, \${page.id}::uuid, 'http://staging.test/', 'problems',
          \${JSON.stringify({ performance: 71, accessibility: 100, "best-practices": 100, seo: 100 })}::jsonb,
          '{71}', \${process.env.METRICS}::jsonb,
          \${JSON.stringify([problem])}::jsonb,
          \${JSON.stringify([{ ruleId: problem.ruleId, severity: "error", pageId: page.id, message: problem.findings[0].message }, warning])}::jsonb)\`;
      await tx\`
        INSERT INTO quality_acceptances (page_id, kind, audit_id, accepted_count, reason, accepted_by)
        VALUES (NULL, 'check', 'robots/allowed-test', 2, \${process.env.REASON}, \${actor}::uuid)\`;
    });
    await sql.end();
    `,
    { RUN_ID, REASON, SLUG, METRICS },
  );
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM quality_acceptances WHERE reason = \${process.env.REASON}\`;
      const run = (await tx\`SELECT deploy_run_id FROM quality_audit_runs WHERE id = \${process.env.RUN_ID}::uuid\`)[0];
      if (run) await tx\`DELETE FROM deploy_runs WHERE id = \${run.deploy_run_id}::uuid\`;
      await tx\`DELETE FROM pages WHERE slug = \${process.env.SLUG}\`;
    });
    await sql.end();
    `,
    { RUN_ID, REASON, SLUG },
  );
});

test("the quality view shows page-check findings, Performance metrics, site-wide findings, and a site-wide acceptance", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto(`/settings/quality?run=${RUN_ID}`);
  const detail = page.getByTestId("quality-audit-detail");
  await expect(detail).toContainText("No Lighthouse audit needed: field values: hero");
  await expect(detail).toContainText("Page checks (seo-check) read 3 page(s)");
  await expect(detail).toContainText("seo-check/title-missing");
  await expect(detail).toContainText("No title");
  await expect(detail.getByTestId("quality-check-notes")).toContainText(
    "warning: seo-check/title-long",
  );
  await expect(detail.getByTestId("quality-site-findings")).toContainText("robots/blocked");

  const metrics = detail.getByTestId("quality-page-metrics");
  await expect(metrics).toContainText("LCP 4.1 s");
  await expect(metrics).toContainText("CLS 0.356");
  await expect(metrics).toContainText("median of 1 run(s)");
  await expect(metrics).toContainText("LCP element: main > section.hero > img");
  await expect(metrics).toContainText("Resource load delay 1800 ms");
  await expect(metrics).toContainText(
    "Layout shift 0.356: body > header — Unsized image element: header > img.logo",
  );

  // #727: acceptances are reviewed grouped per decision. A site-wide one is
  // its own group (not "1 page(s)") and shows its scope, the accepted value
  // and the reason without expanding.
  const group = page.locator(
    '[data-testid="quality-acceptance-group"][data-group-key="check-site:robots/allowed-test"]',
  );
  await expect(group).toContainText("robots/allowed-test");
  await expect(group).toContainText("site-wide");
  await expect(group).toContainText("up to 2 error(s)");
  await expect(group).toContainText(REASON);
});
