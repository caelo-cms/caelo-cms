// SPDX-License-Identifier: MPL-2.0

/**
 * Regression guard for the 2026-07-14 dev-DB wipe: the bunfig test preload
 * TRUNCATEd every non-seed table whenever the DB URLs were present — so a
 * plain `bun test <unit-file>` in a worktree with a linked `.env` destroyed a
 * dev install's data (chat history, pages, ai_calls). The fix makes the
 * destructive reset opt-in via `CAELO_TEST_DB_RESET=1`, wired only into the
 * canonical entry points. These assertions pin all three pieces so a future
 * refactor can't silently re-arm the footgun:
 *
 *   1. the preload gates the reset on the env var (not just URL presence),
 *   2. `bun run test` / `bun run coverage` opt in explicitly,
 *   3. the coverage gate's integration pass opts in per-spawn while the
 *      unit pass stays DB-free.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

describe("destructive test-DB reset is opt-in (CAELO_TEST_DB_RESET)", () => {
  it("test-preload gates resetDatabase on CAELO_TEST_DB_RESET", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts/test-preload.ts"), "utf8");
    expect(src).toContain('process.env.CAELO_TEST_DB_RESET === "1"');
    // The beforeAll that runs the reset must sit behind the opt-in flag,
    // not behind URL presence alone.
    expect(src).toMatch(/ADMIN_URL && PUBLIC_URL && RESET_OPTED_IN/);
  });

  it("package.json test + coverage scripts opt in explicitly", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.test).toContain("CAELO_TEST_DB_RESET=1");
    expect(pkg.scripts.coverage).toContain("CAELO_TEST_DB_RESET=1");
  });

  it("coverage gate: integration pass opts in, unit pass does not", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts/coverage-check.ts"), "utf8");
    expect(src).toContain('CAELO_TEST_DB_RESET: "1"');
    // Exactly one runTests call carries the flag (the integration pass).
    expect(src.split('CAELO_TEST_DB_RESET: "1"').length - 1).toBe(1);
  });
});
