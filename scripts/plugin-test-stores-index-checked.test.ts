// SPDX-License-Identifier: MPL-2.0

/**
 * #1536 — a shipped plugin's unit tests fake its store through the SDK's
 * `indexCheckedQuery`.
 *
 * The host refuses a `list()` no index of the plugin's manifest can drive
 * (#1292). international-site 0.12.2 shipped such a read: its unit test
 * reached it, but through a bare `{ list: async () => rows }` that answers
 * every read, so CI passed and every Stage's audit on a production install
 * errored. A fake wrapped in `indexCheckedQuery(plugin, zone, …)` throws the
 * host's refusal instead, so a read the host would refuse fails the test
 * that reaches it.
 *
 * This scan fails on an object literal in a shipped plugin's test that
 * defines `list` and is not the argument of `indexCheckedQuery(…)`. A fake
 * that is not a store (another handle with a `list`), or a store wrapped
 * where it is handed out, is allowed with a reason below.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PLUGINS = resolve(REPO_ROOT, "packages/plugins");

/** `<file>: <line opening the literal>` → why it may stay unwrapped. */
const ALLOWED: Record<string, string> = {
  "packages/plugins/consent-manager/src/render-hooks.test.ts: consentPurposes: { list: async () => [] },":
    "the visitor's consent purposes (ctx.consentPurposes), not a store",
  "packages/plugins/newsletter/src/send-runs.test.ts: return {":
    "FakeStore.handle(): every handle it gives out is wrapped where the harness hands it to the plugin (query, adminQuery)",
  "packages/plugins/newsletter/src/send-runs.test.ts: const raced = {":
    "overrides list() of a handle wrapped in indexCheckedQuery and delegates to it",
};

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** Index of the `{` opening the object literal around `at`, or -1. Skips strings naively. */
function enclosingBrace(src: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = src[i];
    if (c === "}") depth += 1;
    else if (c === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/** Every object literal defining `list` that is not handed to indexCheckedQuery. */
function uncheckedStores(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(
    /(^|[\s,{])(list\s*:\s*(async\b|\(|function\b)|async\s+list\s*[<(])/gm,
  )) {
    const brace = enclosingBrace(src, (m.index ?? 0) + m[1].length);
    if (brace < 0) continue;
    const before = src.slice(Math.max(0, brace - 200), brace);
    if (/indexCheckedQuery\(\s*[\w.]+\s*,\s*"(schema|adminSchema)"\s*,\s*$/.test(before)) continue;
    const lineStart = src.lastIndexOf("\n", brace) + 1;
    const lineEnd = src.indexOf("\n", brace);
    out.push(src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim());
  }
  return out;
}

describe("#1536 — shipped plugins' test stores apply the host's read rule", () => {
  it("finds an unwrapped store and accepts a wrapped one", () => {
    expect(uncheckedStores("const q = {\n  list: async () => rows,\n};")).toEqual(["const q = {"]);
    expect(
      uncheckedStores(
        'const q = indexCheckedQuery(plugin, "adminSchema", {\n  list: async () => rows,\n});',
      ),
    ).toEqual([]);
    expect(uncheckedStores("const s = {\n  async list(table) { return []; },\n};")).toEqual([
      "const s = {",
    ]);
  });

  it("every store a shipped plugin's test fakes is index-checked", () => {
    const found: string[] = [];
    for (const path of testFiles(PLUGINS)) {
      const file = relative(REPO_ROOT, path);
      for (const line of uncheckedStores(readFileSync(path, "utf8")))
        found.push(`${file}: ${line}`);
    }
    const unexplained = found.filter((f) => !(f in ALLOWED));
    expect(
      unexplained,
      "wrap the fake in indexCheckedQuery(plugin, zone, …) from @caelo-cms/plugin-sdk, or add it to ALLOWED with the reason it is not a store",
    ).toEqual([]);
    // A stale allow-list entry fails too: the exception it explained is gone.
    expect(Object.keys(ALLOWED).filter((k) => !found.includes(k))).toEqual([]);
  });
});
