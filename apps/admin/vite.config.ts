// SPDX-License-Identifier: MPL-2.0
//
// Issue trail for `forceOxcParserNativeEntry` below — read the chain
// before touching the hook:
//   #51 added the hook to pin `oxc-parser` to its native NAPI
//       dispatcher entry (`src-js/index.js`).
//   #52 was the original wasm-wasi startup crash that motivated the
//       hook: Vite's default resolution followed
//       `"browser": "src-js/wasm.js"` and inlined a static import of
//       `@oxc-parser/binding-wasm32-wasi` — a binding bun doesn't
//       install on native hosts.
//   #53 was the Docker-build crash from the hook's first cut
//       returning `external: true`; fixed by inlining the dispatcher
//       via an absolute-path redirect (see `OXC_PARSER_NATIVE_ENTRY`
//       below).
// The detailed in-line doc-comments below explain the why; this header
// just orients a cold reader on the issue numbers worth grepping.

import { createRequire } from "node:module";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * Absolute path to oxc-parser's native NAPI dispatcher entry, pre-resolved
 * at config-load time. The `resolveId` hook below redirects the bare
 * `"oxc-parser"` import to this path. Rolldown (Vite 8's bundler) does
 * NOT re-resolve a subpath spec like `"oxc-parser/src-js/index.js"`
 * through `node_modules`; it tries to open the literal path and fails
 * with `os error 2`. An absolute path skips that walk entirely. If the
 * dep is missing, `require.resolve` throws here — at config load —
 * instead of mid-bundling, which is the cheaper failure signal.
 */
const OXC_PARSER_NATIVE_ENTRY = createRequire(import.meta.url).resolve(
  "oxc-parser/src-js/index.js",
);

/**
 * Force `oxc-parser` to resolve to its native NAPI dispatcher entry
 * (`src-js/index.js`) and let Vite inline that dispatcher into the SSR
 * bundle. Two regressions are gated here:
 *
 * 1. `"browser": "src-js/wasm.js"` (the #52 crash). oxc-parser's
 *    `package.json` declares a `browser` field that statically imports
 *    `@oxc-parser/binding-wasm32-wasi`. That binding is an optional dep
 *    with `@emnapi/core` / `@emnapi/runtime` deps bun doesn't materialize
 *    on a native host, so the bundled server crashes at startup with
 *    `Cannot find module '@oxc-parser/binding-wasm32-wasi'`. `ssr.external`
 *    and `build.rollupOptions.external` were both tried first and didn't
 *    catch this — oxc-parser is imported transitively through
 *    `@caelo-cms/plugin-sandbox` (a workspace package bundled into the
 *    SSR output), and by the time those externalization passes run,
 *    Rollup has already resolved through the browser field and inlined
 *    `wasm.js`. Intercepting in `resolveId` with `enforce: "pre"` runs
 *    before that resolution and locks the entry path.
 *
 * 2. `external: true` (the #53 Docker-build crash). The first cut of
 *    this plugin returned `{ id: "oxc-parser/src-js/index.js", external:
 *    true }`. `external: true` left `import … from
 *    "oxc-parser/src-js/index.js"` in the chunk, and the SvelteKit
 *    adapter Worker then ESM-resolved that import from
 *    `.svelte-kit/output/server/chunks/src.js` — which fails in the
 *    lean production Docker layout and tanks the release-images
 *    workflow's admin build. The fix: drop `external: true` so Vite
 *    inlines the dispatcher, and return the *absolute* path to
 *    `src-js/index.js` (see `OXC_PARSER_NATIVE_ENTRY` above) — Rolldown
 *    won't re-resolve a subpath spec via node_modules and would error
 *    `Could not load oxc-parser/src-js/index.js` otherwise. Vite then
 *    follows the redirect and inlines the dispatcher (`src-js/index.js`
 *    + `src-js/bindings.js`) directly into the SSR chunk. The inlined
 *    `bindings.js` uses `createRequire(import.meta.url)` for the
 *    platform-specific `@oxc-parser/binding-<os>-<arch>` lookups, so
 *    the runtime walks up from the chunk to find the binding installed
 *    in `node_modules` — no external import left to resolve. The
 *    production image only needs `@oxc-parser/binding-<os>-<arch>`
 *    present in `node_modules`, which the Dockerfile's `Patch up
 *    missing native bindings via npm` block already guarantees.
 *
 * The inlined dispatcher's lazy `require()` calls for
 * `experimentalRawTransfer` / `experimentalLazy`
 * (`./raw-transfer/eager.js` etc.) resolve against the bundled chunk's
 * URL and would 404 if invoked. Caelo only ever calls
 * `parseSync(filename, source)`, so those code paths are dead in our
 * build. If a future caller needs raw transfer, re-evaluate this
 * trade-off then.
 */
function forceOxcParserNativeEntry(): Plugin {
  return {
    name: "force-oxc-parser-native-entry",
    enforce: "pre",
    resolveId(id) {
      if (id === "oxc-parser") {
        return { id: OXC_PARSER_NATIVE_ENTRY };
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [forceOxcParserNativeEntry(), tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    strictPort: false,
  },
  ssr: {
    // Playwright deps are devDependencies, never imported from
    // `apps/admin/src/`, but with bun's hoisted linker (see
    // `../../bunfig.toml`) `playwright-core` lives at the workspace root
    // where Vite's SSR module walker can reach it via transitive imports
    // from `@playwright/test` / `@axe-core/playwright`. Marking them
    // external skips the analysis, cuts module count, and matches the
    // dependency boundary (test-only, not part of the admin runtime).
    external: ["playwright-core", "@playwright/test", "@axe-core/playwright"],
  },
});
