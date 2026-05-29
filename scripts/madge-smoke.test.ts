// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #13 — integration-tier proof that the pinned madge binary
 * actually detects a runtime circular dependency and, with
 * `skipTypeImports` on, ignores a type-only one.
 *
 * The config test (`madge-config.test.ts`) locks the `.madgerc` shape
 * and the CI test (`madge-ci-step.test.ts`) locks the workflow wiring,
 * but neither proves the tool itself flags a cycle with the version
 * this repo pins. This test spawns the installed binary
 * (`node_modules/.bin/madge`, not `bunx`, so it exercises the exact
 * lockfile version) against a throwaway fixture in an OS temp dir —
 * never inside the repo tree, so it can't pollute the real
 * `bun run circular` gate. Mirrors `scripts/knip-smoke.test.ts`.
 *
 * The fixture holds two cycles:
 *   - a real runtime cycle (`runtime-a` <-> `runtime-b`, value imports)
 *   - a type-only cycle (`type-only` <-> `type-consumer`, `import type`)
 *
 * MS1: with skipTypeImports on, madge flags the runtime cycle by name.
 * MS2: ...and exits non-zero — the exact signal the CI step relies on.
 * MS3: ...and does NOT report the type-only cycle (the regression
 *      guard for the false-positive class found during planning).
 * MS4: control — with skipTypeImports OFF, the type-only cycle IS
 *      reported, proving MS3's pass is caused by the knob, not by
 *      madge failing to see the type edge at all.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const MADGE_BIN = join(REPO_ROOT, "node_modules", ".bin", "madge");

const fixtureDir = mkdtempSync(join(tmpdir(), "madge-regression-"));

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function writeFixtureSources(): void {
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  // value-import cycle: runtime-a <-> runtime-b (a real runtime cycle)
  writeFileSync(
    join(fixtureDir, "src", "runtime-a.ts"),
    'import { b } from "./runtime-b";\nexport const a = () => b;\n',
  );
  writeFileSync(
    join(fixtureDir, "src", "runtime-b.ts"),
    'import { a } from "./runtime-a";\nexport const b = () => a;\n',
  );
  // type-only cycle: erased under verbatimModuleSyntax, not a runtime cycle
  writeFileSync(
    join(fixtureDir, "src", "type-only.ts"),
    'import type { U } from "./type-consumer";\nexport type T = { u?: U };\n',
  );
  writeFileSync(
    join(fixtureDir, "src", "type-consumer.ts"),
    'import type { T } from "./type-only";\nexport type U = { t?: T };\n',
  );
}

// Writes a value-import cycle under an `excluded-dir/` subtree, used to
// prove excludeRegExp actually suppresses a cycle (not just that the
// pattern string is present in .madgerc — that's the config test's MC3).
function writeExcludedCycle(): void {
  mkdirSync(join(fixtureDir, "src", "excluded-dir"), { recursive: true });
  writeFileSync(
    join(fixtureDir, "src", "excluded-dir", "ex-a.ts"),
    'import { exB } from "./ex-b";\nexport const exA = () => exB;\n',
  );
  writeFileSync(
    join(fixtureDir, "src", "excluded-dir", "ex-b.ts"),
    'import { exA } from "./ex-a";\nexport const exB = () => exA;\n',
  );
}

function writeMadgerc(opts: {
  skipTypeImports: boolean;
  excludeRegExp?: ReadonlyArray<string>;
}): void {
  writeFileSync(
    join(fixtureDir, ".madgerc"),
    JSON.stringify({
      fileExtensions: ["ts"],
      ...(opts.excludeRegExp ? { excludeRegExp: opts.excludeRegExp } : {}),
      detectiveOptions: { ts: { skipTypeImports: opts.skipTypeImports } },
    }),
  );
}

async function runMadge(): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn([MADGE_BIN, "--circular", "."], {
    cwd: fixtureDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

describe("madge detects runtime cycles, ignores type-only (issue #13)", () => {
  it("MS0: the pinned madge binary is installed", () => {
    expect(
      existsSync(MADGE_BIN),
      `madge binary missing at ${MADGE_BIN} — run \`bun install\``,
    ).toBe(true);
  });

  it(
    "MS1-MS3: with skipTypeImports on, flags the runtime cycle, exits non-zero, ignores the type-only cycle",
    async () => {
      writeFixtureSources();
      writeMadgerc({ skipTypeImports: true });
      const { stdout, exitCode } = await runMadge();

      // MS1: runtime cycle reported by name
      expect(stdout).toContain("runtime-a");
      expect(stdout).toContain("runtime-b");
      // MS2: non-zero exit drives the CI gate failure
      expect(exitCode).toBe(1);
      // MS3: type-only cycle suppressed
      expect(stdout).not.toContain("type-only");
      expect(stdout).not.toContain("type-consumer");
    },
    { timeout: 30_000 },
  );

  it(
    "MS4 (control): with skipTypeImports off, the type-only cycle IS reported",
    async () => {
      writeFixtureSources();
      writeMadgerc({ skipTypeImports: false });
      const { stdout, exitCode } = await runMadge();

      expect(stdout).toContain("type-consumer");
      expect(stdout).toContain("type-only");
      expect(exitCode).toBe(1);
    },
    { timeout: 30_000 },
  );

  it(
    "MS5: excludeRegExp suppresses a cycle under an excluded path while still flagging others",
    async () => {
      writeFixtureSources();
      writeExcludedCycle();
      writeMadgerc({
        skipTypeImports: true,
        excludeRegExp: ["(^|/)excluded-dir(/|$)"],
      });
      const { stdout, exitCode } = await runMadge();

      // the excluded cycle is not reported (proves excludeRegExp is honored)
      expect(stdout).not.toContain("ex-a");
      expect(stdout).not.toContain("ex-b");
      expect(stdout).not.toContain("excluded-dir");
      // ...but the non-excluded runtime cycle still is, so the gate isn't blinded
      expect(stdout).toContain("runtime-a");
      expect(exitCode).toBe(1);
    },
    { timeout: 30_000 },
  );
});
