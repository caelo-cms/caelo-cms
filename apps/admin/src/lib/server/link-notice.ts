// SPDX-License-Identifier: MPL-2.0

/**
 * #1240 — the two halves of a publish click's link notice in the panel:
 * what the click says about the pages it published, and "Back to draft".
 * Shared by /edit and the pages list.
 */

import type { LinkNotice } from "@caelo-cms/admin-core";
import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { getQueryContext } from "./query.js";

/** How many pages `pages.set_status_many` takes per call. */
const STATUS_BATCH = 200;

/**
 * The links of `pageIds` that would stop Publish live. The status change
 * stands either way, so a check that could not run is reported, not fatal.
 *
 * @returns `notice`: null when clean; `checkFailed`: why the check did not
 *   run, null when it did.
 */
export async function publishLinkNotice(
  ctx: ExecutionContext,
  pageIds: readonly string[],
): Promise<{ notice: LinkNotice | null; checkFailed: string | null }> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, "links.publish_notice", { pageIds });
  if (!r.ok) {
    console.error("[publish] the link check did not run", { error: r.error });
    return { notice: null, checkFailed: describeError(r.error) };
  }
  return { notice: (r.value as { notice: LinkNotice | null }).notice, checkFailed: null };
}

/** Take `pageIds` back to draft; returns what went wrong, or null. */
export async function setPagesToDraft(
  ctx: ExecutionContext,
  pageIds: readonly string[],
): Promise<string | null> {
  const { adapter, registry } = getQueryContext();
  for (let i = 0; i < pageIds.length; i += STATUS_BATCH) {
    const r = await execute(registry, adapter, ctx, "pages.set_status_many", {
      pageIds: pageIds.slice(i, i + STATUS_BATCH),
      status: "draft",
    });
    if (!r.ok) return describeError(r.error);
  }
  return null;
}

/** The form's comma-separated page ids. */
export function pageIdsOf(form: FormData): string[] {
  return String(form.get("pageIds") ?? "")
    .split(",")
    .filter((id) => id.length > 0);
}

/** What the operator is told once the pages are back to draft. */
export const BACK_TO_DRAFT_MESSAGE =
  "Back to draft. Publish live stays closed until you Stage again: the staged build still contains these pages.";
