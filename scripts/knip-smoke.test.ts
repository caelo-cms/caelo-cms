// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #12 — integration-tier proof that knip actually detects dead
 * code, run against a self-contained fixture in a temp directory.
 *
 * The unit test (`knip-config.test.ts`) locks the config shape and the
 * CI test (`knip-ci-step.test.ts`) locks the workflow wiring, but
 * neither proves the tool itself flags an unused export with the binary
 * version this repo pins. This test spawns the repo's installed knip
 * against a throwaway fixture: a `lib` module that is imported by the
 * entry (so the file is reachable) but whose `orphanUnusedExport` symbol
 * has no consumer. Knip should report that symbol under `exports`. The
 * fixture is built OUTSIDE the repo tree (OS temp dir) so it can never
 * pollute the real `bun run knip` gate.
 *
 * Note: the file is deliberately imported. An entirely-unreachable file
 * surfaces under the `files` category, not `exports`; this test targets
 * the export finder specifically, so the file must be reachable with
 * one consumed export and one dead export.
 *
 * This is the AC #4 evidence in test form: knip surfaces dead code. The
 * audit's named items (`file-type` in admin-core, `pruneSha`) were
 * handled in the implementation diff; this test guards the detection
 * capability against a future config change that might silently break
 * it.
 *
 * S1: knip reports the unused export by name and exits non-zero (1 =
 *     findings) when pointed at a fixture with an orphan export.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const KNIP_BIN = join(REPO_ROOT, "node_modules", ".bin", "knip");

const fixtureDir = mkdtempSync(join(tmpdir(), "knip-regression-"));

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function writeFixture(): void {
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  writeFileSync(
    join(fixtureDir, "package.json"),
    JSON.stringify({ name: "knip-regression-fixture", version: "0.0.0", type: "module" }, null, 2),
  );
  writeFileSync(
    join(fixtureDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler" } }, null, 2),
  );
  writeFileSync(
    join(fixtureDir, "knip.json"),
    JSON.stringify({ entry: ["src/entry.ts"], project: ["src/**/*.ts"] }, null, 2),
  );
  // entry imports `used` from lib (so lib.ts is reachable) but never
  // touches orphanUnusedExport — that symbol is the dead export knip
  // must flag under the `exports` category.
  writeFileSync(
    join(fixtureDir, "src", "entry.ts"),
    'import { used } from "./lib.ts";\nexport const entryVal = used;\n',
  );
  writeFileSync(
    join(fixtureDir, "src", "lib.ts"),
    "export const used = 1;\nexport function orphanUnusedExport(): number {\n  return 42;\n}\n",
  );
}

describe("knip detects dead code (issue #12, AC #4)", () => {
  it(
    "S1: flags an unused export by name and exits non-zero",
    async () => {
      writeFixture();
      const proc = Bun.spawn([KNIP_BIN, "--include", "exports", "--no-progress"], {
        cwd: fixtureDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      expect(stdout).toContain("orphanUnusedExport");
      expect(exitCode).toBe(1);
    },
    { timeout: 30_000 },
  );
});
