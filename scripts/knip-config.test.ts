// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #12 regression contract over `knip.json` + the root
 * `package.json` knip wiring.
 *
 * Knip is the dead-code gate (CLAUDE.md §5). Its config is a single
 * file that decides which workspaces get analysed, which paths are
 * ignored, and which findings are deferred to issue #22. A typo in a
 * workspace key, a stale ignore path, or a renamed `knip:strict` script
 * silently degrades the gate's coverage — CI would still go green while
 * checking less than it should. This test locks every load-bearing
 * field so that drift fires locally before merge, in the same spirit as
 * `scripts/dependabot-config.test.ts`.
 *
 * It is a pure file-shape test — no Postgres, no knip subprocess — so it
 * runs in milliseconds regardless of the compose stack state. The live
 * knip invocation is covered by `scripts/knip-smoke.test.ts` and the CI
 * gate step; the CI wiring is covered by `scripts/knip-ci-step.test.ts`.
 *
 * C1: `knip.json` parses as STRICT JSON. Knip's `.json` reader uses
 *     `JSON.parse`; a contributor pasting a `//` comment (knip.jsonc is
 *     the comment-capable variant) would crash knip at CI time with a
 *     less obvious error. Parsing here catches it first.
 * C2: `$schema` is present and pins the SAME knip major as the
 *     `package.json` devDependency. A major bump without a config audit
 *     would drift the schema URL; this ties them together.
 * C3: every key in `workspaces` is `.` OR resolves to a real directory
 *     containing a `package.json`. Overrides only exist where knip's
 *     auto-detection is wrong, so a typo'd path would silently no-op.
 * C4: every NON-glob entry in `ignore` points at a path that exists on
 *     disk. A stale ignore (file since deleted) is dead config that
 *     hides the fact that the deferral is resolved.
 * C5: every key in `ignoreIssues` points at a real file. Same staleness
 *     guard for the per-file category suppressions deferred to #22.
 * C6: root `package.json` carries `knip`, `knip:strict`, `knip:fix`
 *     scripts with the exact command strings CI + docs depend on. The
 *     CI gate runs `knip:strict`; a rename here would silently change
 *     what CI enforces.
 * C7: `knip` is pinned to an EXACT version in devDependencies (no
 *     `^`/`~`), matching the repo's exact-pin convention.
 * C8: `ignoreExportsUsedInFile` is `true`. The first-run finding volume
 *     depended on this setting collapsing internal-only exports; losing
 *     it would resurface ~40 findings and break the green gate.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const KNIP_PATH = join(REPO_ROOT, "knip.json");
const PKG_PATH = join(REPO_ROOT, "package.json");

const KNIP_RAW = readFileSync(KNIP_PATH, "utf8");
const PKG_RAW = readFileSync(PKG_PATH, "utf8");

type KnipConfig = {
  $schema?: string;
  ignore?: ReadonlyArray<string>;
  ignoreIssues?: Record<string, ReadonlyArray<string>>;
  ignoreExportsUsedInFile?: boolean;
  workspaces?: Record<string, unknown>;
};

type PackageJson = {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const pkg = JSON.parse(PKG_RAW) as PackageJson;

describe("knip.json config contract (issue #12)", () => {
  it("C1: parses as strict JSON (no comments)", () => {
    expect(() => JSON.parse(KNIP_RAW)).not.toThrow();
  });

  const config = JSON.parse(KNIP_RAW) as KnipConfig;

  it("C2: $schema pins the same knip major as the package.json devDependency", () => {
    expect(config.$schema).toBeDefined();
    const schemaMajor = config.$schema?.match(/knip@(\d+)/)?.[1];
    const depRange = pkg.devDependencies?.knip;
    expect(depRange).toBeDefined();
    const depMajor = depRange?.match(/(\d+)/)?.[1];
    expect(schemaMajor).toBe(depMajor);
  });

  it("C3: every workspace override key resolves to a real package directory", () => {
    const keys = Object.keys(config.workspaces ?? {});
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      if (key === ".") continue;
      const pkgJson = join(REPO_ROOT, key, "package.json");
      expect(existsSync(pkgJson), `workspace override "${key}" has no package.json`).toBe(true);
    }
  });

  it("C4: every non-glob ignore path exists on disk", () => {
    for (const entry of config.ignore ?? []) {
      if (entry.includes("*")) continue;
      const abs = join(REPO_ROOT, entry);
      expect(existsSync(abs), `ignore entry "${entry}" points at a missing path`).toBe(true);
    }
  });

  it("C5: every ignoreIssues key points at a real file", () => {
    for (const file of Object.keys(config.ignoreIssues ?? {})) {
      const abs = join(REPO_ROOT, file);
      expect(existsSync(abs), `ignoreIssues key "${file}" points at a missing file`).toBe(true);
    }
  });

  it("C6: root package.json carries the knip / knip:strict / knip:fix scripts", () => {
    expect(pkg.scripts?.knip).toBe("knip");
    expect(pkg.scripts?.["knip:strict"]).toBe("knip --reporter github-actions");
    expect(pkg.scripts?.["knip:fix"]).toBe("knip --fix");
  });

  it("C7: knip is exact-pinned in devDependencies", () => {
    const range = pkg.devDependencies?.knip ?? "";
    expect(range).not.toContain("^");
    expect(range).not.toContain("~");
    expect(range).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("C8: ignoreExportsUsedInFile is enabled", () => {
    expect(config.ignoreExportsUsedInFile).toBe(true);
  });
});
