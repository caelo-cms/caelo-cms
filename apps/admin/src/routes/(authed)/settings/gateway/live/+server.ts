// SPDX-License-Identifier: MPL-2.0

/**
 * P13 ideas-pass — SSE stream of gateway analytics.
 * Polls `gateway.list_analytics` every 5s in-process, emits a diff
 * frame to all connected clients. Owner-gated.
 *
 * #1361 — one stream lives at most {@link STREAM_LIFETIME_MS}, then ends
 * with an `end` event. The admin runs on request-billed CPU, so an open
 * stream bills an instance for as long as it is open: the page reopens it
 * only while someone is at the tab (lib/live/live-stream.ts), and a tab
 * left open is closed by the next end at the latest.
 */

import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

const POLL_INTERVAL_MS = 5_000;
/** How long one stream runs before it ends and the page decides whether to reopen it. */
const STREAM_LIFETIME_MS = 2 * 60_000;

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
          if (r.ok && !stopped) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(r.value)}\n\n`));
          }
        } catch {
          // best-effort
        }
      }

      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        clearTimeout(lifetime);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      void tick();
      const interval = setInterval(tick, POLL_INTERVAL_MS);
      // The stream's end: the page reopens it if someone is still there.
      const lifetime = setTimeout(() => {
        if (stopped) return;
        try {
          controller.enqueue(enc.encode("event: end\ndata: {}\n\n"));
        } catch {
          /* already closed */
        }
        stop();
      }, STREAM_LIFETIME_MS);

      // Clean up on client disconnect.
      request.signal.addEventListener("abort", stop);
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
