// SPDX-License-Identifier: MPL-2.0

/**
 * #1479 — builds refuse a published page without a meta description (#730),
 * so a scenario that stages a page it seeded as published must seed the
 * description too. The AI writes none for an empty page it did not author:
 * scenario-consent stayed green on Sonnet 5 only because that model invented
 * one, and failed the release gate on Sonnet 5.5. A real-AI run costs money,
 * so the fixture rule is checked on the scenario sources.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCENARIOS_DIR = join(import.meta.dir, "..");

const PUBLISHED_SEED = /INSERT INTO pages \([^)]*\)\s*VALUES \([^)]*'published'/g;
const DESCRIPTION_SEED =
  /INSERT INTO pages_seo \([^)]*meta_description[^)]*\)\s*VALUES \([^)]*'[^']+'\)/;

/**
 * The source after each published-page seed, up to the next one: the
 * description of that page has to be seeded in this stretch, so a second
 * page cannot pass on the first page's row.
 */
function publishedSeedStretches(source: string): string[] {
  const starts = [...source.matchAll(PUBLISHED_SEED)].map((m) => m.index);
  return starts.map((start, i) => source.slice(start, starts[i + 1]));
}

describe("publishedSeedStretches", () => {
  const page = "INSERT INTO pages (slug) VALUES ('a', 'published')";
  const seo = "INSERT INTO pages_seo (page_id, meta_description) VALUES (id, 'Text')";

  test("accepts a page followed by its description", () => {
    expect(DESCRIPTION_SEED.test(publishedSeedStretches(`${page}\n${seo}`)[0] ?? "")).toBe(true);
  });

  test("a second page does not pass on the first page's description", () => {
    const stretches = publishedSeedStretches(`${page}\n${seo}\n${page}`);
    expect(stretches.map((s) => DESCRIPTION_SEED.test(s))).toEqual([true, false]);
  });

  test("an empty description does not count", () => {
    const empty = "INSERT INTO pages_seo (page_id, meta_description) VALUES (id, '')";
    expect(DESCRIPTION_SEED.test(publishedSeedStretches(`${page}\n${empty}`)[0] ?? "")).toBe(false);
  });
});

describe("scenario fixtures", () => {
  const scenarios = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".browser.ts"));

  test("the scan finds the scenarios it guards", () => {
    const seeding = scenarios.filter(
      (f) => publishedSeedStretches(readFileSync(join(SCENARIOS_DIR, f), "utf8")).length > 0,
    );
    expect(seeding).toContain("scenario-consent.browser.ts");
  });

  test.each(scenarios)("%s seeds a description for each published page it stages", (file) => {
    const source = readFileSync(join(SCENARIOS_DIR, file), "utf8");
    if (!source.includes("awaitStageComplete(")) return;
    for (const stretch of publishedSeedStretches(source)) {
      expect(stretch).toMatch(DESCRIPTION_SEED);
    }
  });
});
