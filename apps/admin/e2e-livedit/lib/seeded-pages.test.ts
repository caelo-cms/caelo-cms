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

const seedsPublishedPage = (source: string): boolean =>
  /INSERT INTO pages \([^)]*\)\s*VALUES \([^)]*'published'/.test(source);

describe("scenario fixtures", () => {
  const scenarios = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".browser.ts"));

  test("the scan finds the scenarios it guards", () => {
    const seeding = scenarios.filter((f) =>
      seedsPublishedPage(readFileSync(join(SCENARIOS_DIR, f), "utf8")),
    );
    expect(seeding).toContain("scenario-consent.browser.ts");
  });

  test.each(scenarios)("%s seeds a description for a published page it stages", (file) => {
    const source = readFileSync(join(SCENARIOS_DIR, file), "utf8");
    if (!seedsPublishedPage(source) || !source.includes("awaitStageComplete(")) return;
    expect(source).toContain("INSERT INTO pages_seo");
  });
});
