// SPDX-License-Identifier: MPL-2.0

import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    strictPort: false,
  },
  // Playwright deps are devDependencies and never imported from
  // `apps/admin/src/`, but with bun's hoisted linker (see ../../bunfig.toml)
  // `playwright-core` lives at the workspace root where Vite's SSR module
  // walker can reach it via transitive imports from `@playwright/test` /
  // `@axe-core/playwright`. Without an explicit external, Vite tries to
  // bundle it during `bun run build` and emits a wall of `[UNRESOLVED_IMPORT]`
  // warnings for `fs`/`os`/`tty`/`util` — playwright-core uses Node built-ins
  // inside browser-driver code that never runs in SSR anyway. Marking it
  // external skips the analysis, cuts the bundled module count, and matches
  // the dependency boundary (test-only, not part of the admin runtime).
  ssr: {
    external: ["playwright-core", "@playwright/test", "@axe-core/playwright"],
  },
});
