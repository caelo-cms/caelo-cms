// SPDX-License-Identifier: MPL-2.0

/**
 * P13 ideas-pass — SSE stream of gateway analytics.
 * Polls `gateway.list_analytics` every 5s in-process, emits a diff
 * frame to all connected clients. Owner-gated.
 */

import { execute } from "@caelo/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

const POLL_INTERVAL_MS = 5_000;

export const GET: RequestHandler = async ({ locals, request }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const ctx = locals.ctx;
  if (!ctx) throw error(401, "no execution context");

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      let stopped = false;

      async function tick(): Promise<void> {
        if (stopped) return;
        try {
          const r = await execute(registry, adapter, ctx, "gateway.list_analytics", {
            windowSec: 3600,
            topN: 10,
          });
          if (r.ok) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(r.value)}\n\n`));
          }
        } catch {
          // best-effort
        }
      }

      void tick();
      const interval = setInterval(tick, POLL_INTERVAL_MS);

      // Clean up on client disconnect.
      request.signal.addEventListener("abort", () => {
        stopped = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
};
