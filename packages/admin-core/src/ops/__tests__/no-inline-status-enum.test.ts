// SPDX-License-Identifier: MPL-2.0

/**
 * Regression guard for issue #20's DRY centralization. Two invariants that
 * the AC grep-gates checked once, made permanent so a future PR can't quietly
 * re-introduce the duplication:
 *
 *   1. No file under packages/admin-core/src re-inlines the propose/execute
 *      status 4-tuple `z.enum(["pending","applied","rejected","superseded"])`.
 *      Gated domains must import `proposalStatus` from @caelo-cms/shared (and
 *      derive variants from `PROPOSAL_STATUSES` / `.exclude`).
 *   2. No file defines its own `describeError` except the canonical
 *      `ai/tools/_describe-error.ts`.
 *
 * Pure source-scan, no runtime deps — same surface as
 * scripts/codeql-workflow.test.ts. The needle for invariant 1 is built from
 * parts so this test file does not itself contain the forbidden literal.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "..", "..");

/** All .ts source files under admin-core/src, excluding tests, dist, and node_modules. */
function sourceFiles(): string[] {
  return readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" })
    .filter(
      (rel) =>
        rel.endsWith(".ts") &&
        !rel.endsWith(".test.ts") &&
        !rel.includes("__tests__") &&
        !rel.includes("/dist/") &&
        !rel.includes("node_modules"),
    )
    .map((rel) => resolve(SRC_ROOT, rel));
}

describe("no inlined shared primitives under admin-core/src (issue #20 guard)", () => {
  const files = sourceFiles();

  it("scans a non-trivial number of source files", () => {
    // Guards against a broken glob silently passing the asserts below.
    expect(files.length).toBeGreaterThan(50);
  });

  it("does not re-inline the propose/execute status 4-tuple", () => {
    // Built from parts so the needle isn't present verbatim in this file.
    const states = ["pending", "applied", "rejected", "superseded"];
    const needle = `z.enum([${states.map((s) => `"${s}"`).join(", ")}]`;
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes(needle));
    expect(offenders).toEqual([]);
  });

  it("defines describeError only in the canonical _describe-error.ts", () => {
    const offenders = files.filter(
      (f) =>
        f.endsWith("_describe-error.ts") === false &&
        readFileSync(f, "utf8").includes("function describeError"),
    );
    expect(offenders).toEqual([]);
  });
});
