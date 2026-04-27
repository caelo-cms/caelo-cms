// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "ai_calls.aggregate", {});
  if (r.ok) {
    return r.value as {
      totals: {
        calls: number;
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        costUsd: number;
      };
      perDay: {
        day: string;
        calls: number;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
      }[];
    };
  }
  return {
    totals: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
    perDay: [],
  };
};
