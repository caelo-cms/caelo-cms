// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #13 regression contract over `.madgerc` + the root
 * `package.json` madge wiring.
 *
 * Madge is the circular-dependency gate (CLAUDE.md §4 — small,
 * composable modules imply a clean import graph). Its behaviour hinges
 * on a single config file whose every field is load-bearing: drop
 * `skipTypeImports` and CI reds on 5 type-only false positives; drop
 * the `.svelte-kit` exclude and CI reds on ~96 generated-proxy cycles;
 * rename the `circular` script and the CI gate silently runs the wrong
 * thing. This is a pure file-shape test — no madge subprocess, no
 * Postgres — mirroring `scripts/knip-config.test.ts`; the live madge
 * invocation is covered by `scripts/madge-smoke.test.ts` and the CI
 * wiring by `scripts/madge-ci-step.test.ts`.
 *
 * MC1: `.madgerc` parses as STRICT JSON. Madge's rc loader tries
 *      JSON.parse first; a stray `//` comment would make it fall back
 *      to ini-parsing and silently mis-read the config.
 * MC2: `detectiveOptions.{ts,tsx}.skipTypeImports` are both `true` —
 *      the knob that distinguishes a runtime cycle from a type-only
 *      one (erased under verbatimModuleSyntax).
 * MC3: `excludeRegExp` carries patterns for `.svelte-kit`,
 *      node_modules, dist, build, and test files.
 * MC4: `tsConfig` points at `tsconfig.base.json` and `fileExtensions`
 *      is exactly `["ts","tsx"]`.
 * MC5: root `package.json#scripts.circular` is the exact command the
 *      CI gate depends on.
 * MC6: `madge` is exact-pinned (no `^`/`~`) in devDependencies.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const MADGERC_PATH = join(REPO_ROOT, ".madgerc");
const PKG_PATH = join(REPO_ROOT, "package.json");

const MADGERC_RAW = readFileSync(MADGERC_PATH, "utf8");
const PKG_RAW = readFileSync(PKG_PATH, "utf8");

type MadgeConfig = {
  fileExtensions?: ReadonlyArray<string>;
  tsConfig?: string;
  excludeRegExp?: ReadonlyArray<string>;
  detectiveOptions?: {
    ts?: { skipTypeImports?: boolean };
    tsx?: { skipTypeImports?: boolean };
  };
};

type PackageJson = {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const pkg = JSON.parse(PKG_RAW) as PackageJson;

describe("madge config contract (issue #13)", () => {
  it("MC1: .madgerc parses as strict JSON (no comments)", () => {
    expect(() => JSON.parse(MADGERC_RAW)).not.toThrow();
  });

  const config = JSON.parse(MADGERC_RAW) as MadgeConfig;

  it("MC2: skipTypeImports is enabled for both ts and tsx", () => {
    expect(config.detectiveOptions?.ts?.skipTypeImports).toBe(true);
    expect(config.detectiveOptions?.tsx?.skipTypeImports).toBe(true);
  });

  it("MC3: excludeRegExp covers generated, vendor, build, and test paths", () => {
    const patterns = config.excludeRegExp ?? [];
    const joined = patterns.join("\n");
    expect(joined).toContain("svelte-kit");
    expect(joined).toContain("node_modules");
    expect(joined).toContain("dist");
    expect(joined).toContain("build");
    expect(joined).toContain("test");
  });

  it("MC4: tsConfig and fileExtensions match the scanned TS surface", () => {
    expect(config.tsConfig).toBe("tsconfig.base.json");
    expect(config.fileExtensions).toEqual(["ts", "tsx"]);
  });

  it("MC5: root package.json carries the exact `circular` script", () => {
    expect(pkg.scripts?.circular).toBe("madge --circular apps packages");
  });

  it("MC6: madge is exact-pinned in devDependencies", () => {
    const range = pkg.devDependencies?.madge ?? "";
    expect(range).not.toContain("^");
    expect(range).not.toContain("~");
    expect(range).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
