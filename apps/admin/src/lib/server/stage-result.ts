// SPDX-License-Identifier: MPL-2.0

/**
 * What a finished Stage shows the operator: where to preview the staged
 * build and how many draft pages it does NOT contain. Shared by /edit's
 * Stage button and the Open changes overview (issue #620).
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { getQueryContext } from "./query.js";
import { stagingPreviewPath } from "./staging-preview-path.js";

/**
 * Preview URL of a staged build plus the draft-page count.
 *
 * @param build - the staging deploy's run id and provider preview URL.
 * @param pageId - the page to open in the preview (GCP preview paths),
 *   or null for the site root.
 */
export async function describeStagedBuild(
  ctx: ExecutionContext,
  build: { readonly runId: string; readonly previewUrl?: string },
  pageId: string | null,
): Promise<{ previewUrl: string; draftPageCount: number }> {
  const { adapter, registry } = getQueryContext();
  let previewUrl: string;
  if (build.previewUrl) {
    previewUrl = build.previewUrl;
  } else if (process.env.CAELO_PROVIDER === "gcp") {
    previewUrl = `/_staging-preview/${build.runId}/`;
    if (pageId) {
      const pageRow = await execute(registry, adapter, ctx, "pages.get", { pageId });
      if (pageRow.ok) {
        const p = (pageRow.value as { page: { currentPath: string } }).page;
        previewUrl = `/_staging-preview/${build.runId}/${stagingPreviewPath(p.currentPath)}`;
      }
    }
  } else {
    previewUrl = process.env.CAELO_STAGING_BASE_URL ?? "http://localhost:8081";
  }

  // Migration run #9 R10 (issue #262) — the partial success-lie: staging
  // builds only status='published' pages, so a build can "succeed" while
  // the operator's draft work (e.g. an entire migration) is absent from
  // it. The count lets the toast say what is NOT in the preview.
  let draftPageCount = 0;
  const pages = await execute(registry, adapter, ctx, "pages.list", {});
  if (pages.ok) {
    draftPageCount = (pages.value as { pages: { status: string }[] }).pages.filter(
      (p) => p.status === "draft",
    ).length;
  }
  return { previewUrl, draftPageCount };
}
