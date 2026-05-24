// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.3 — /content/library list view.
 *
 * Loads every active content_instance with placementCount + module slug
 * so the operator can see at a glance which instances are shared
 * across pages (placementCount >= 2) vs orphan (zero placements) vs
 * one-off (exactly one placement). Filtering happens client-side
 * because the dataset is small in practice (instances ~= placements,
 * bounded by the number of pages times average modules-per-page).
 */

import { execute } from "@caelo-cms/query-api";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "content_instances.list", {});
  const instances = r.ok
    ? (
        r.value as {
          instances: {
            id: string;
            moduleId: string;
            moduleSlug: string;
            moduleDisplayName: string;
            slug: string | null;
            displayName: string | null;
            values: Record<string, unknown>;
            version: number;
            placementCount: number;
            createdAt: string;
            updatedAt: string;
          }[];
        }
      ).instances
    : [];
  return { instances };
};
