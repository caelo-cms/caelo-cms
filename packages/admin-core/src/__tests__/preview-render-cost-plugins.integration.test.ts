// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1212 — the preview cost benchmark with the shipped
 * international-site and consent-manager plugins running, as on a
 * production install (see `preview-render-cost.integration.test.ts` for
 * the core-only measure).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type CostSite, setupCostSite } from "./_preview-cost.js";

let site: CostSite;

beforeAll(async () => {
  site = await setupCostSite({ plugins: true });
});

afterAll(async () => {
  await site.close();
});

describe("pages.render_preview database cost with plugins (#1212)", () => {
  it("does not grow with the number of pages", async () => {
    const small = await site.measure();
    await site.seedFillerPages(150, 2000);
    const large = await site.measure();
    console.log("[preview-render-cost-plugins]", JSON.stringify({ small, large }));
    if (process.env.COST_DUMP) {
      console.log(
        site
          .lastStatements()
          .map((s) => s.replace(/\s+/g, " ").slice(0, 160))
          .join("\n"),
      );
    }
    expect(large).toEqual(small);
  });
});
