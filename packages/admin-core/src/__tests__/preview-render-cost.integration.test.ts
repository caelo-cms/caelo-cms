// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1212 — what one editor preview costs the database, and that the
 * cost does not grow with the site.
 *
 * Every statement the adapter runs is counted (`onStatement`) for one
 * `pages.render_preview`, on a site of ~150 and of ~2,000 pages, main line
 * and chat branch, cold (site view not cached) and warm (unchanged draft):
 * the counts are the same at both sizes, and an unchanged draft stays
 * within the issue's budget.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type CostSite, setupCostSite } from "./_preview-cost.js";

/** The issue's acceptance budget for one preview of an unchanged draft. */
const WARM_BUDGET = 70;

let site: CostSite;

beforeAll(async () => {
  site = await setupCostSite({ plugins: false });
});

afterAll(async () => {
  await site.close();
});

describe("pages.render_preview database cost (#1212)", () => {
  it("does not grow with the number of pages, and stays within budget warm", async () => {
    const small = await site.measure();
    await site.seedFillerPages(150, 2000);
    const large = await site.measure();
    console.log("[preview-render-cost]", JSON.stringify({ small, large }));
    expect(large).toEqual(small);
    expect(small.warm).toBeLessThanOrEqual(WARM_BUDGET);
    expect(small.branchWarm).toBeLessThanOrEqual(WARM_BUDGET);
  });
});
