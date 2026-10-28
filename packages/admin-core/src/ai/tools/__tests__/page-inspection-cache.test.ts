// SPDX-License-Identifier: MPL-2.0

/**
 * #1216 — the page-inspection cache is bounded in size, not only in entry
 * count: a few large rendered pages must not pin hundreds of MB.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  CACHE_CHAR_CAP,
  clearPageInspectionCacheForTests,
  getPageInspection,
  pageInspectionCacheCharsForTests,
  putPageInspection,
} from "../_page-inspection-cache.js";

afterEach(() => clearPageInspectionCacheForTests());

const page = (url: string, chars: number) => ({
  url,
  html: "h".repeat(chars),
  markdown: "",
});

describe("page-inspection cache size bound", () => {
  it("evicts the oldest entries once the total size passes the cap", () => {
    const quarter = Math.floor(CACHE_CHAR_CAP / 4);
    const refs = [1, 2, 3, 4, 5].map((n) =>
      putPageInspection("s", page(`https://x.test/${n}`, quarter)),
    );
    expect(pageInspectionCacheCharsForTests()).toBeLessThanOrEqual(CACHE_CHAR_CAP);
    expect(getPageInspection(refs[0] as string)).toBeNull();
    expect(getPageInspection(refs[4] as string)?.url).toBe("https://x.test/5");
  });

  it("keeps the newest entry even when it alone is over the cap", () => {
    const old = putPageInspection("s", page("https://x.test/old", 10));
    const big = putPageInspection("s", page("https://x.test/big", CACHE_CHAR_CAP + 1));
    expect(getPageInspection(big)?.url).toBe("https://x.test/big");
    expect(getPageInspection(old)).toBeNull();
  });

  it("re-putting the same page replaces its size instead of adding to it", () => {
    putPageInspection("s", page("https://x.test/a", 1000));
    putPageInspection("s", page("https://x.test/a", 1000));
    expect(pageInspectionCacheCharsForTests()).toBe(1000 + "https://x.test/a".length);
  });
});
