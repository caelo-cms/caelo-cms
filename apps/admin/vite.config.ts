// SPDX-License-Identifier: MPL-2.0

import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5173,
    strictPort: false,
  },
  // `bun` is a built-in module available at runtime under Bun; Vite's Node-
  // backed SSR resolver can't find it during build and errors out. Mark it as
  // external so it remains a bare import that Bun resolves at runtime.
  ssr: {
    external: ["bun"],
    noExternal: [],
  },
  optimizeDeps: {
    exclude: ["bun"],
  },
});
