// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1212 (epic #1209) — previews must not deadlock the pool.
 *
 * Before, `pages.render_preview` held its transaction across every plugin
 * call, and each plugin storage access took a second connection from the
 * same pool. With as many concurrent previews as connections, every
 * preview held one and waited for another: the admin stalled for good
 * (production, 2026-10-28). Here 20 previews run at once on a pool of 10,
 * with the shipped plugins answering their render hooks from storage, and
 * all of them must finish.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type CostSite, setupCostSite } from "./_preview-cost.js";

const POOL_MAX = 10;
const CONCURRENT = 20;
/** Far above what 20 previews take; a deadlock never finishes. */
const DEADLINE_MS = 25_000;

let site: CostSite;

beforeAll(async () => {
  site = await setupCostSite({ plugins: true, poolMax: POOL_MAX });
});

afterAll(async () => {
  await site.close();
});

describe("concurrent previews (#1212)", () => {
  it(`${CONCURRENT} previews on a pool of ${POOL_MAX} all complete`, async () => {
    const renders = Array.from({ length: CONCURRENT }, (_, i) =>
      site.render(
        i % 2 === 0 ? { pageId: site.pageId } : { path: "/cost-page", chatBranchId: site.branchId },
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadlock">((resolve) => {
      timer = setTimeout(() => resolve("deadlock"), DEADLINE_MS);
    });
    const outcome = await Promise.race([Promise.all(renders), deadline]);
    clearTimeout(timer);
    expect(outcome).not.toBe("deadlock");
    const results = outcome as { html: string }[];
    expect(results).toHaveLength(CONCURRENT);
    for (const r of results) expect(r.html).toContain("<h1>Hello</h1>");
  }, 60_000);
});
