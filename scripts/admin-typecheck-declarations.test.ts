// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1394 — the admin's typecheck reads `@caelo-cms/admin-core` through its
 * built declarations (`dist/*.d.ts`), never through its sources.
 *
 * With `exports` pointing straight at `src/index.ts`, every `svelte-check` and
 * `tsc --noEmit` run over `apps/admin` re-checked all ~670 admin-core source
 * files (drizzle query types included): 5.7 M symbols, 3.77 GB of heap for
 * `tsc`, a 4.46 GB peak RSS for `svelte-check`, and a heap-out-of-memory crash
 * on the GitHub runner. admin-core is already checked by its own composite
 * project in the root `tsc -b`, so the admin only needs its declarations:
 * 0.95 GB of heap, and svelte-check passes inside a 1.5 GB heap.
 *
 * The runtime keeps reading the sources: Bun and Vite ignore the `types`
 * condition and take `default`, so no image or dev server needs `dist`.
 * The admin's `typecheck` script builds admin-core first, so a standalone
 * run never checks against missing or stale declarations.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, path), "utf8")) as Record<string, unknown>;
}

type ConditionalExport = { types?: string; default?: string };

describe("admin typecheck reads admin-core declarations (#1394)", () => {
  const adminCore = readJson("packages/admin-core/package.json");
  const exportsMap = adminCore.exports as Record<string, ConditionalExport | string>;

  it("every admin-core export resolves types to dist and runtime to src", () => {
    expect(Object.keys(exportsMap).length).toBeGreaterThan(0);
    for (const [subpath, target] of Object.entries(exportsMap)) {
      expect(typeof target, `export ${subpath} must be a conditional object`).toBe("object");
      const conditional = target as ConditionalExport;
      expect(conditional.types, `export ${subpath} types`).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(conditional.default, `export ${subpath} default`).toMatch(/^\.\/src\/.+\.ts$/);
      // The declaration sits where tsc emits it for that source (rootDir src → outDir dist).
      const emitted = (conditional.default as string)
        .replace(/^\.\/src\//, "./dist/")
        .replace(/\.ts$/, ".d.ts");
      expect(conditional.types).toBe(emitted);
      // `types` must come first: TypeScript takes the first matching condition.
      expect(Object.keys(conditional)[0]).toBe("types");
    }
    expect(adminCore.types).toBe("./dist/index.d.ts");
  });

  it("the admin's typecheck builds admin-core's declarations before checking", () => {
    const scripts = readJson("apps/admin/package.json").scripts as Record<string, string>;
    expect(scripts.typecheck?.startsWith("tsc -b ../../packages/admin-core && ")).toBe(true);
  });
});
