// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.84 → #390 — the staging-preview SUFFIX (without leading slash)
 * that the admin's /_staging-preview/<runId>/ proxy appends, derived
 * from the page's COMPOSED path (`pages.currentPath`). The generator
 * emits files at exactly that path, so no home/prefix knowledge is
 * duplicated here anymore: "/" → "" (the proxy appends index.html),
 * "/de/pricing" → "de/pricing/".
 */

export function stagingPreviewPath(currentPath: string): string {
  const trimmed = currentPath.replace(/^\/+|\/+$/g, "");
  return trimmed.length === 0 ? "" : `${trimmed}/`;
}
