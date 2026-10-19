// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 — links to pages a build does not contain.
 *
 * The static generator resolves internal references (`caelo:page/<id>`)
 * and reports every page that links to a page which exists but is not
 * published (`GenerateResult.unpublishedLinkTargets`): that link 404s on
 * the deployed site. Maintainer decision 2 on #724: a warning at Stage,
 * a block at Publish live (rollout F). This module is the warning half —
 * the shape at the generator → admin boundary and the sentence every
 * Stage surface (the AI's stage tool, the editor toast, Open changes)
 * shows.
 */

import { z } from "zod";

/** One page linking to a page the build does not ship (generator output). */
export const unpublishedLinkTargetSchema = z
  .object({
    /** The page carrying the link. */
    pageSlug: z.string(),
    pagePath: z.string(),
    /** The linked page and the path its link renders as. */
    targetPageId: z.string().uuid(),
    targetUrl: z.string(),
  })
  .strict();
export type UnpublishedLinkTarget = z.infer<typeof unpublishedLinkTargetSchema>;

/** How many links a warning names (the count is always exact). */
export const UNPUBLISHED_LINKS_LISTED = 10;

/**
 * One sentence naming the links to unpublished pages and the next step,
 * or null when there are none. Worded for both the operator and the AI.
 */
export function describeUnpublishedLinks(links: readonly UnpublishedLinkTarget[]): string | null {
  if (links.length === 0) return null;
  const listed = links
    .slice(0, UNPUBLISHED_LINKS_LISTED)
    .map((l) => `${l.pagePath} → ${l.targetUrl}`)
    .join(", ");
  const more =
    links.length > UNPUBLISHED_LINKS_LISTED
      ? ` and ${links.length - UNPUBLISHED_LINKS_LISTED} more`
      : "";
  return (
    `${links.length} link(s) point to draft pages that are not in this build, so they lead nowhere on the site: ${listed}${more}. ` +
    "Publish the linked pages (set_pages_status_many, or the status toggle in the editor) or remove the links before Publish live."
  );
}
