// SPDX-License-Identifier: MPL-2.0

/**
 * issue #262 regression guard — no bare CommonJS `require(...)` calls in
 * server-side source that runs inside vite's dev SSR.
 *
 * Run #7's "Stage to staging silently no-ops" root cause: deploy.trigger's
 * `resolveGeneratorCli()` lazily called `require("node:fs")`. Under `bun`
 * (prod server, `bun test`) `require` exists even in ESM, so nothing ever
 * failed in CI. Under vite dev SSR the module graph is ESM on a Node
 * runtime where `require` is undefined — the call threw INSIDE the op
 * transaction, rolled back the deploy_runs row (zero forensic trace) and
 * every Stage in dev died with "require is not defined".
 *
 * A runtime test can't catch this class (Bun always defines `require`),
 * so this is a static scan: any `require(` call outside a comment or a
 * type position fails the suite. Use a top-level `import` instead; for
 * genuinely-dynamic loading use `await import(...)`.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Directories whose .ts sources are reachable from the admin dev server. */
const SCAN_ROOTS = [
  resolve(import.meta.dirname, ".."), // packages/admin-core/src
  resolve(import.meta.dirname, "../../../../apps/admin/src"),
];

const SKIP_DIRS = new Set(["__tests__", "node_modules", ".svelte-kit"]);

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      collectTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

/**
 * Matches a real `require(` call: not preceded by an identifier char or
 * `.` (excludes `createRequire(`, `module.require(`) and not inside a
 * word (excludes `requirePermission(`, `requireUser(`).
 */
const REQUIRE_CALL = /(?<![\w$.])require\s*\(/;

function offendingLines(file: string): string[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const hits: string[] = [];
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    // Strip line comments + a same-line block comment. Good enough for a
    // lint-tier scan; strings containing `require(` would still hit, which
    // is acceptable (none exist today and a false positive fails loudly).
    const lineComment = line.indexOf("//");
    if (lineComment !== -1) line = line.slice(0, lineComment);
    const blockStart = line.indexOf("/*");
    if (blockStart !== -1) {
      const blockEnd = line.indexOf("*/", blockStart + 2);
      if (blockEnd === -1) {
        line = line.slice(0, blockStart);
        inBlockComment = true;
      } else {
        line = line.slice(0, blockStart) + line.slice(blockEnd + 2);
      }
    }
    if (REQUIRE_CALL.test(line)) hits.push(`${file}:${i + 1}: ${raw.trim()}`);
  }
  return hits;
}

describe("no bare require() in ESM server source (issue #262)", () => {
  it("finds zero require(...) calls under admin-core/src and apps/admin/src", () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) collectTsFiles(root, files);
    expect(files.length).toBeGreaterThan(50); // sanity: the scan saw the tree

    const offenders = files.flatMap(offendingLines);
    expect(offenders).toEqual([]);
  });
});
