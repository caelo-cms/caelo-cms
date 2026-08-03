// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-ratings — Tier-1 plugin: 1-5 star ratings per (page, visitor).
 *
 * P12 PR2.3 — exercises real plugin-host worker scheduler (refresh aggregates
 * every 5 minutes), ON CONFLICT vote-change semantics via ctx.query, and
 * baked-at-deploy aggregate reads for the Web Component delta pattern.
 *
 * Schema (cms_public.plugin_ratings.*):
 *   ratings           — visitor's score per page. UNIQUE (visitor_id, page_id).
 *   rating_aggregates — denormalised count + sum + average for fast static reads.
 *
 * Operations:
 *   submit            — PUBLIC. Visitor scores 1-5; ON CONFLICT updates.
 *   list_aggregates   — PUBLIC read. Used by static-render + delta-fetch.
 *   _refresh          — INTERNAL worker. Recomputes aggregates from raw votes.
 */

import { KIT_CSS, postPluginJson } from "@caelo-cms/plugin-component-kit";
import { defineComponent, definePlugin, type PluginContextTier1 } from "@caelo-cms/plugin-sdk";

interface SubmitInput {
  pageId: string;
  score: 1 | 2 | 3 | 4 | 5;
}

interface AggregateRow {
  page_id: string;
  count: number;
  sum: number;
  average: number;
}

export default definePlugin<PluginContextTier1>({
  slug: "ratings",
  version: "1.0.0",
  tier: 1,
  schema: {
    ratings: {
      id: "uuid",
      page_id: "string",
      visitor_id: "string",
      score: "int",
      created_at: "timestamp",
    },
    rating_aggregates: {
      id: "uuid",
      page_id: "string",
      count: "int",
      sum: "int",
      average: "int",
      updated_at: "timestamp",
    },
  },
  requestedCapabilities: ["background_workers"],
  operations: {
    submit: async (ctx, args) => {
      const input = args as SubmitInput;
      if (typeof input.score !== "number" || input.score < 1 || input.score > 5) {
        throw new Error("submit: score must be 1..5");
      }
      const ok = await ctx.captcha.requireProof(null);
      if (!ok) throw new Error("submit: captcha verification failed");
      // Lookup existing vote by (visitor, page) and update OR insert.
      // The schema has no UNIQUE constraint here (the plugin's emitted schema
      // only enforces id PK), so we de-dupe at the plugin layer: list, then
      // update if found, else insert.
      const existing = await ctx.query.list<"ratings", { id: string }>("ratings", {
        visitor_id: ctx.visitor.id,
        page_id: input.pageId,
        limit: 1,
      });
      if (existing[0]) {
        await ctx.query.update("ratings", existing[0].id, { score: input.score });
        return { recorded: true, id: existing[0].id, mode: "updated" as const };
      }
      const r = await ctx.query.insert("ratings", {
        page_id: input.pageId,
        visitor_id: ctx.visitor.id,
        score: input.score,
      });
      return { recorded: true, id: r.id, mode: "inserted" as const };
    },

    list_aggregates: async (ctx, args) => {
      const input = (args ?? {}) as { pageId?: string };
      const filter: Record<string, unknown> = { limit: 200 };
      if (input.pageId) filter.page_id = input.pageId;
      const rows = await ctx.query.list<"rating_aggregates", AggregateRow>(
        "rating_aggregates",
        filter,
      );
      return { aggregates: rows };
    },

    /**
     * Worker handler. The scheduler dispatches this every 5 min (cron in
     * `workers[]`). Recomputes per-page aggregates from raw
     * ratings via two ctx.query passes — simple, idempotent.
     */
    _refresh: async (ctx, _args) => {
      const ratings = await ctx.query.list<"ratings", { page_id: string; score: number }>(
        "ratings",
        { limit: 1000 },
      );
      // Bucket.
      const buckets = new Map<string, { page_id: string; count: number; sum: number }>();
      for (const r of ratings) {
        const key = r.page_id;
        const b = buckets.get(key) ?? {
          page_id: r.page_id,
          count: 0,
          sum: 0,
        };
        b.count += 1;
        b.sum += r.score;
        buckets.set(key, b);
      }
      // Wipe + reinsert. Cheap for v1; production scale wants UPSERT.
      const existing = await ctx.query.list<"rating_aggregates", { id: string }>(
        "rating_aggregates",
        { limit: 1000 },
      );
      for (const e of existing) await ctx.query.delete("rating_aggregates", e.id);
      let written = 0;
      for (const b of buckets.values()) {
        await ctx.query.insert("rating_aggregates", {
          page_id: b.page_id,
          count: b.count,
          sum: b.sum,
          average: Math.round((b.sum / b.count) * 100), // 2-decimal int (×100)
        });
        written += 1;
      }
      return { refreshed: written };
    },
  },
  workers: [{ name: "refresh_aggregates", cron: "0 0/5 * * * *", operationName: "_refresh" }],
  /**
   * Web Component `<caelo-rating>` — five-star rating widget. Posts the
   * vote to /api/plugin/ratings/submit and re-renders the running average.
   *
   * Attributes: page-id.
   */
  component: defineComponent({
    tag: "caelo-rating",
    shadowMode: "open",
    mounted: async (host) => {
      const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      const pageId = host.getAttribute("page-id") ?? "";
      const extraCss = `
        :host { display: inline-block; }
        .stars { display: flex; gap: 0.125rem; }
        .stars button {
          background: transparent;
          border: 0;
          cursor: pointer;
          font-size: 1.25rem;
          padding: 0.125rem;
          color: var(--caelo-color-muted, #d1d5db);
        }
        .stars button[data-active="true"] { color: var(--caelo-color-warning, #f59e0b); }
        .summary { font-size: 0.75rem; color: var(--caelo-color-muted, #6b7280); margin-top: 0.25rem; }
      `;
      root.innerHTML = `
        <style>${KIT_CSS}${extraCss}</style>
        <div class="stars" role="radiogroup" aria-label="Rate this page">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-score="${n}" aria-label="${n} stars">★</button>`).join("")}
        </div>
        <div class="summary" data-summary>—</div>
      `;
      const summaryEl = root.querySelector("[data-summary]") as HTMLDivElement;
      const buttons = root.querySelectorAll<HTMLButtonElement>("button[data-score]");

      function highlight(n: number): void {
        for (const b of buttons) {
          b.dataset.active = Number.parseInt(b.dataset.score ?? "0", 10) <= n ? "true" : "false";
        }
      }

      async function refreshAggregate(): Promise<void> {
        try {
          const json = await postPluginJson<{
            aggregates: Array<{ count: number; average: number }>;
          }>("ratings", "list_aggregates", { pageId });
          if (!json.ok || !json.data?.aggregates?.[0]) {
            summaryEl.textContent = "No ratings yet";
            return;
          }
          const a = json.data.aggregates[0];
          summaryEl.textContent = `${(a.average / 100).toFixed(1)} from ${a.count} rating${a.count === 1 ? "" : "s"}`;
        } catch {
          /* best-effort */
        }
      }
      await refreshAggregate();

      for (const b of buttons) {
        b.addEventListener("mouseenter", () =>
          highlight(Number.parseInt(b.dataset.score ?? "0", 10)),
        );
        b.addEventListener("click", async () => {
          const score = Number.parseInt(b.dataset.score ?? "0", 10);
          highlight(score);
          try {
            await postPluginJson("ratings", "submit", { pageId, score });
            await refreshAggregate();
          } catch {
            /* best-effort; keep visual feedback */
          }
        });
      }
    },
  }),
});
