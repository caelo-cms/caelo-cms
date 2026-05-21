// SPDX-License-Identifier: MPL-2.0

import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

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
 *    workflow's admin build. The fix: drop `external: true`. Vite then
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
        return { id: "oxc-parser/src-js/index.js" };
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
