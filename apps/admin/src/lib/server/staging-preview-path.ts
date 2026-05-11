// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.84 — mirror of static-generator's pageOutputPath, returning
 * the SUFFIX (without leading slash) that the admin's
 * /_staging-preview/<runId>/ proxy should append. Strips the trailing
 * `index.html` so the operator sees a clean URL.
 *
 * Used by /edit?/stage and /content/pages?/stage to build the
 * "Preview" link in the post-Stage toast. Single source of truth
 * lives in apps/static-generator/src/generate.ts:121, but the admin
 * doesn't import from static-generator's source (the deploy
 * subprocess does); duplicating the small switch here keeps the
 * dep graph tidy.
 */

export interface LocaleConfigForPreview {
  readonly code: string;
  readonly urlStrategy: string;
  readonly urlHost: string | null;
}

export function stagingPreviewPath(slug: string, locale?: LocaleConfigForPreview): string {
  const trimmed = slug.replace(/^\/+|\/+$/g, "");
  const isHome = trimmed === "" || trimmed === "home" || trimmed === "index";
  // Generator emits the home page as just `index.html`. The proxy
  // serves `<runId>/` by appending `index.html`, so the cleanest
  // URL for home is the empty suffix.
  const dirPath = isHome ? "" : `${trimmed}/`;
  if (!locale) return dirPath;
  switch (locale.urlStrategy) {
    case "none":
      return dirPath;
    case "subdirectory":
      return `${locale.code}/${dirPath}`;
    case "subdomain":
    case "domain":
      // Hosted-locale strategies emit under `_hosts/<host>/`. The
      // preview proxy can serve that path verbatim — operator sees
      // the canonical path the live CDN would route.
      return locale.urlHost ? `_hosts/${locale.urlHost}/${dirPath}` : dirPath;
    default:
      return dirPath;
  }
}
