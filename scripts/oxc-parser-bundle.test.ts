// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #53 regression contract over `apps/admin/vite.config.ts`.
 *
 * The `forceOxcParserNativeEntry` `resolveId` hook in that file is
 * load-bearing for the production admin build. Two regressions are
 * gated here, and a third (the comment block that records why) is gated
 * because the failure mode of dropping it is "the next contributor
 * re-adds `external: true` thinking it's a cleanup". U-numbers track
 * plan §8 / `## Test strategy` Tier 1.
 *
 * U1: hook still present — otherwise the `"browser": "src-js/wasm.js"`
 *     resolution from #52 returns and the SSR bundle crashes at startup
 *     with `Cannot find module '@oxc-parser/binding-wasm32-wasi'`.
 * U2: hook does NOT set `external: true` — the #53 regression. Leaving
 *     the import external tanks the SvelteKit adapter Worker on the lean
 *     production Docker layout.
 * U3: redirect target stays `oxc-parser/src-js/index.js`. Flipping it
 *     to `src-js/wasm.js` resurrects #52.
 * U4: `enforce: "pre"` retained on the plugin. Without it, whichever
 *     resolver runs first wins and the wasm browser field comes back.
 * U5: doc-comment block above the plugin mentions `inline` +
 *     `createRequire`. Without that record, the trade-off (dispatcher
 *     inlined, runtime walks up from the chunk to find the platform
 *     binding) is invisible at review time.
 *
 * No build-output assertions — that would require a 30s+ `bun run
 * build` in the `check` job. The e2e job (`bun run build` inside
 * Playwright's webServer) is the bundle-level regression catcher.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CONFIG_PATH = resolve(REPO_ROOT, "apps/admin/vite.config.ts");
const config = readFileSync(CONFIG_PATH, "utf8");

const PLUGIN_NAME = "forceOxcParserNativeEntry";

/**
 * Slice the source of the resolveId-hook function body so per-region
 * assertions don't false-positive on unrelated parts of the file —
 * notably `ssr.external: [...]` which legitimately contains `external`,
 * and any future Vite config that might also use `enforce` / `pre` for
 * a different plugin.
 */
function extractPluginBody(src: string): string {
  const start = src.indexOf(`function ${PLUGIN_NAME}`);
  if (start === -1) throw new Error(`no \`${PLUGIN_NAME}\` plugin in vite.config.ts`);
  // The body runs to the closing `}\n}` of the wrapper function. Match the
  // first `\n}\n` after the function header — the inner plugin object closes
  // with `};\n` (note the semicolon), so the brace-newline-brace-newline
  // pattern uniquely identifies the wrapper's terminator.
  const end = src.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`unterminated \`${PLUGIN_NAME}\` body`);
  return src.slice(start, end);
}

/**
 * Extract the `/** … *\/` doc-comment that immediately precedes the
 * plugin function definition, so U5 only inspects the explanatory block
 * and not, say, a future unrelated comment elsewhere in the file.
 */
function extractDocComment(src: string): string {
  const fnStart = src.indexOf(`function ${PLUGIN_NAME}`);
  if (fnStart === -1) throw new Error(`no \`${PLUGIN_NAME}\` plugin in vite.config.ts`);
  const commentEnd = src.lastIndexOf("*/", fnStart);
  if (commentEnd === -1) throw new Error(`no doc-comment before \`${PLUGIN_NAME}\``);
  const commentStart = src.lastIndexOf("/**", commentEnd);
  if (commentStart === -1) throw new Error(`no /** opener for \`${PLUGIN_NAME}\` doc-comment`);
  return src.slice(commentStart, commentEnd + 2);
}

/**
 * Extract the `return { ... };` object literal inside the
 * `if (id === "oxc-parser")` branch of the resolveId hook. Scoping U2
 * to just this object — instead of the whole plugin body — eliminates
 * the false-positive surface against any future legitimate
 * `external: [...]` array literal elsewhere in the plugin (e.g., a
 * nested `build.rollupOptions.external` block) and the inverse
 * false-negative: a misplaced `external: true` on a sibling field
 * inside the same plugin object would slip past a body-wide regex.
 */
function extractResolveIdReturn(src: string): string {
  const branchStart = src.indexOf(`if (id === "oxc-parser")`);
  if (branchStart === -1) throw new Error("no `oxc-parser` resolveId branch");
  const returnStart = src.indexOf("return {", branchStart);
  if (returnStart === -1) throw new Error("no `return { … }` in `oxc-parser` resolveId branch");
  const returnEnd = src.indexOf("};", returnStart);
  if (returnEnd === -1) throw new Error("unterminated `return { … };` in `oxc-parser` resolveId branch");
  return src.slice(returnStart, returnEnd + 2);
}

const pluginBody = extractPluginBody(config);
const docComment = extractDocComment(config);
const resolveIdReturn = extractResolveIdReturn(config);

describe("apps/admin/vite.config.ts — issue #53 regression contract", () => {
  it("U1: forceOxcParserNativeEntry hook is present (resolves the #52 wasm-wasi crash)", () => {
    expect(pluginBody).toContain(`id === "oxc-parser"`);
  });

  it("U2: resolveId return value does NOT set `external: true` (issue #53 regression)", () => {
    expect(resolveIdReturn).not.toMatch(/external\s*:\s*true/);
  });

  it("U3: redirect target stays the native dispatcher entry, not the wasm field", () => {
    expect(pluginBody).toContain(`"oxc-parser/src-js/index.js"`);
    expect(pluginBody).not.toContain(`"oxc-parser/src-js/wasm.js"`);
  });

  it('U4: `enforce: "pre"` is retained on the plugin', () => {
    expect(pluginBody).toContain(`enforce: "pre"`);
  });

  it("U5: doc-comment records the inline-dispatcher trade-off (mentions `inline` + `createRequire`)", () => {
    expect(docComment.toLowerCase()).toContain("inline");
    expect(docComment).toContain("createRequire");
  });
});

// ---------------------------------------------------------------------------
// Bundle-level contract (B1 / B2).
//
// U1-U5 above are source-string assertions: they catch a deliberate
// revert in vite.config.ts, but not behavioural drift in Vite / Rollup
// (e.g., a Vite version bump that changes `enforce: "pre"` ordering, or
// a different plugin reordering ahead of forceOxcParserNativeEntry).
// The build-output assertions below close that gap.
//
// They run only when `apps/admin/build/server/chunks/` exists — i.e.,
// after `bun run build` in `apps/admin/`. The `check` CI job has no
// build artifact and skips the block transparently; the `e2e` job's
// Playwright webServer runs `bun run build` before any spec, so this
// block fires there too. Local devs see the assertions on any post-build
// `bun test` run.
// ---------------------------------------------------------------------------

const BUILD_CHUNKS_DIR = resolve(REPO_ROOT, "apps/admin/build/server/chunks");

interface BuildChunk {
  readonly path: string;
  readonly content: string;
}

function readBuildChunks(): readonly BuildChunk[] | null {
  if (!existsSync(BUILD_CHUNKS_DIR)) return null;
  const jsFiles = readdirSync(BUILD_CHUNKS_DIR).filter((f) => f.endsWith(".js"));
  if (jsFiles.length === 0) return null;
  return jsFiles.map((f) => {
    const p = resolve(BUILD_CHUNKS_DIR, f);
    return { path: p, content: readFileSync(p, "utf8") };
  });
}

const buildChunks = readBuildChunks();

if (buildChunks) {
  describe("apps/admin/build/server/chunks — bundle-level regression contract", () => {
    it("B1: at least one chunk references `@oxc-parser/binding-` (dispatcher inlined, not externalized)", () => {
      const hits = buildChunks.filter((c) => c.content.includes("@oxc-parser/binding-"));
      expect(hits.length).toBeGreaterThan(0);
    });

    it("B2: no chunk leaves an unresolved `from \"oxc-parser…\"` import (the #53 failure mode)", () => {
      // Match `from "oxc-parser"` or `from "oxc-parser/<subpath>"` — the
      // exact shape `external: true` would leave behind. Single + double
      // quotes both — Rollup usually emits double-quoted strings, but
      // pin both for robustness.
      const importRegex = /from\s*["']oxc-parser(?:["']|\/)/;
      const leftover = buildChunks.filter((c) => importRegex.test(c.content));
      expect(leftover.map((c) => c.path)).toEqual([]);
    });
  });
}
