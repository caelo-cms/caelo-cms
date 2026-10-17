// SPDX-License-Identifier: MPL-2.0

/**
 * The PR template's "User docs affected" section is a contract: after a
 * release, the docs-sync workflow (#827) finds it by its exact heading in
 * every merged `user-facing` PR and drafts the end-user docs update from it
 * (epic #825). Renaming the heading would silently empty those drafts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATE = readFileSync(
  resolve(import.meta.dir, "../.github/PULL_REQUEST_TEMPLATE.md"),
  "utf8",
);

describe("PR template", () => {
  it("has the exact `## User docs affected` heading, once", () => {
    expect(TEMPLATE.match(/^## User docs affected$/gm)).toHaveLength(1);
  });

  it("names the `user-facing` label next to it", () => {
    const section = TEMPLATE.split(/^## User docs affected$/m)[1]?.split(/^## /m)[0] ?? "";
    expect(section).toContain("`user-facing`");
  });
});
