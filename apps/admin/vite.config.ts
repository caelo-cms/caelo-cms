// SPDX-License-Identifier: MPL-2.0

import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * Force `oxc-parser` to resolve to its native NAPI dispatch entry
 * (`src-js/index.js`) even in SSR builds. Without this, Vite picks
 * `oxc-parser/package.json`'s `"browser": "src-js/wasm.js"` field and
 * hardcodes `import * from "@oxc-parser/binding-wasm32-wasi"` into the
 * server bundle. The wasm-wasi binding is an optional dep that bun only
 * installs as a fallback (it depends on `@emnapi/core` / `@emnapi/runtime`
 * which aren't part of the platform-native install), so the bundled server
 * crashes at startup with `Cannot find module
 * '@oxc-parser/binding-wasm32-wasi'` on every host.
 *
 * `ssr.external` and `build.rollupOptions.external` were both tried first
 * and didn't catch this — oxc-parser is imported transitively through
 * `@caelo-cms/plugin-sandbox` (a workspace package that's bundled into the
 * SSR output), and by the time those externalization passes run, Rollup
 * has already resolved oxc-parser via the browser field and inlined
 * `wasm.js`. Intercepting in `resolveId` with `enforce: "pre"` runs
 * before that resolution and locks the entry path.
 */
function forceOxcParserNativeEntry(): Plugin {
  return {
    name: "force-oxc-parser-native-entry",
    enforce: "pre",
    resolveId(id) {
      if (id === "oxc-parser") {
        return { id: "oxc-parser/src-js/index.js", external: true };
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
