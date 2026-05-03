// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params }) => {
  requirePermission(locals, "settings.read");
  const requestId = params.requestId;
  if (!requestId || requestId.length > 64) throw error(400, "invalid requestId");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "audit.by_request_id", { requestId });
  if (!r.ok) throw error(500, "lookup failed");
  const v = r.value as {
    audit: Array<{
      id: string;
      actorId: string;
      operation: string;
      succeeded: boolean;
      entityId: string | null;
      resultSummary: string | null;
      provider: string | null;
      model: string | null;
      operationType: "text" | "image" | null;
      createdAt: string;
    }>;
    aiCalls: Array<{
      id: string;
      actorId: string;
      provider: string;
      model: string;
      operationType: "text" | "image";
      inputTokens: number;
      outputTokens: number;
      costMicrocents: number;
      succeeded: boolean;
      pluginId: string | null;
      createdAt: string;
    }>;
  };
  return { requestId, ...v };
};
