// SPDX-License-Identifier: MPL-2.0

/**
 * Batch-load what a render needs to resolve lists (epic #1107,
 * `docs/lists.md` §10): list types, lists, page types, the page index for
 * queries, media metadata, the `link-resolve` page partition and the
 * `list-resolve` overlays. In a preview the draft view of the chat's
 * branch; the shared resolver (`createListRenderContext`) consumes it.
 *
 * FIXME(issue #1109): part B of epic #1107 implements this loader (it owns
 * the tables and the draft overlay); until it merges every preview fails
 * here loudly.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ListRenderData } from "@caelo-cms/shared";

/** Options of {@link loadListRenderData}. */
export interface LoadListRenderDataOptions {
  /** The chat branch whose draft view a preview renders; null = main line. */
  readonly chatBranchId: string | null;
  readonly scope: "preview" | "build";
  readonly env: "preview" | "dev" | "staging" | "production";
}

/** Load the list render data for one preview or build. */
export async function loadListRenderData(
  _tx: TransactionRunner,
  _opts: LoadListRenderDataOptions,
): Promise<ListRenderData> {
  throw new Error("loadListRenderData: implemented by part B (#1109)");
}
