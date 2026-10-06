// SPDX-License-Identifier: MPL-2.0

import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // SvelteKit 2.x defaults to Origin-based CSRF checks; no extra config
    // needed. Double-submit CSRF at the form layer uses `session.csrfToken`.
  },
};

export default config;
