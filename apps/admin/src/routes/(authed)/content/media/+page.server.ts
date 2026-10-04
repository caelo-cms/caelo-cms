// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const query = url.searchParams.get("q") ?? undefined;
  const sort = url.searchParams.get("sort") === "most_used" ? "most_used" : "recent";
  // #531 — reference images (guides for generation/editing) live in their own view.
  const visibility = url.searchParams.get("visibility") === "reference" ? "reference" : "library";
  const result = await execute(registry, adapter, locals.ctx, "media.list", {
    query,
    sort,
    visibility,
    limit: 60,
    offset: 0,
  });
  if (!result.ok) {
    return { assets: [], totalCount: 0, query: query ?? "", sort, visibility };
  }
  const { assets, totalCount } = result.value as {
    assets: {
      id: string;
      slug: string;
      mime: string;
      originalName: string;
      sizeBytes: number;
      width: number | null;
      height: number | null;
      alt: string;
      usageCount: number;
      createdAt: string;
      variants: { variant: string }[];
    }[];
    totalCount: number;
  };
  return { assets, totalCount, query: query ?? "", sort, visibility };
};
