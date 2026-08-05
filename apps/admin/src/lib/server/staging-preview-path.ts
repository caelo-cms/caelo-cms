// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.84 — mirror of static-generator's pageOutputPath, returning
 * the SUFFIX (without leading slash) that the admin's
 * /_staging-preview/<runId>/ proxy should append. Strips the trailing
 * `index.html` so the operator sees a clean URL.
 *
 * Used by /edit?/stageAndDeployStaging and /content/pages?/stage to
 * build the "Preview" link in the post-Stage toast. Single source of
 * truth lives in apps/static-generator/src/generate.ts, but the
 * admin doesn't import from static-generator's source (the deploy
 * subprocess does); duplicating the tiny home test here keeps the
 * dep graph tidy. Path shaping beyond slug + home becomes a plugin
 * contribution on the URL composition point (#390).
 */

export function stagingPreviewPath(slug: string): string {
  const trimmed = slug.replace(/^\/+|\/+$/g, "");
  const isHome = trimmed === "" || trimmed === "home" || trimmed === "index";
  // Generator emits the home page as just `index.html`. The proxy
  // serves `<runId>/` by appending `index.html`, so the cleanest
  // URL for home is the empty suffix.
  return isHome ? "" : `${trimmed}/`;
}
