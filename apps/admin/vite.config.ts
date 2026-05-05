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
  // `bun` is a built-in module available at runtime under Bun; we need
  // the bundle to keep a bare `import { SQL } from "bun"` so the runtime
  // resolves to Bun's virtual built-in. SvelteKit's SSR plugin overrides
  // Vite's `ssr.external`, so we ALSO need build.rollupOptions.external
  // (the lower-level Rollup-side externalization) to actually keep the
  // import bare. Without this, Vite resolved `"bun"` against our build-
  // time stub package and INLINED `const SQL = stub;` into the chunk.
  ssr: {
    external: ["bun"],
    noExternal: [],
  },
  optimizeDeps: {
    exclude: ["bun"],
  },
  build: {
    rollupOptions: { external: ["bun"] },
  },
});
