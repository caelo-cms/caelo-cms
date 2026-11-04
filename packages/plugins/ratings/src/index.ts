// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-ratings — Tier-1 plugin: 1-5 star ratings per (page, visitor).
 *
 * Votes are an inbox, averages are published (#1333, epic #763 E10): a
 * visitor only adds a vote (`ratings`, INSERT only for the visitor role),
 * and the admin recomputes the averages on its scheduler tick and writes
 * them into `rating_aggregates`, which visitors can only read. A
 * compromised gateway can therefore not rewrite an average, and cannot
 * read, change or delete anyone's vote.
 *
 * The recompute runs once per public database (`publicDatabases: "each"`):
 * the live averages come from live votes, the staging averages from the
 * staging site's test votes, and neither crosses into the other or into
 * cms_admin.
 *
 * Schema (cms_public.plugin_ratings.*):
 *   ratings           — one row per vote. A visitor who consented to the
 *                       visitor-id cookie votes again with the same
 *                       visitor_id: the recompute counts their newest vote
 *                       per page and deletes the older ones. visitor_id is
 *                       NULL (never de-duplicated) for the rest.
 *
 * Consent: ratings is the plugin the gateway's visitor id (an entry of its
 * `__session` cookie) exists for.
 * It declares the `visitor_id` purpose (`functional`: it serves the
 * visitor's own rating action — a second vote replaces the first — and
 * measures nothing) and requires the consent-manager plugin, which asks
 * the visitor. Without consent the vote still counts, as a new one.
 *   rating_aggregates — denormalised count + sum + average for fast static reads.
 *
 * Operations:
 *   submit            — PUBLIC. Visitor scores 1-5; adds a vote.
 *   list_aggregates   — PUBLIC read of the published averages.
 *   _refresh          — worker (every 5 min, each public database) + owner
 *                       panel + AI tool (live). Recomputes the averages from
 *                       the votes; idempotent.
 *
 * AI tools:
 *   list_rating_aggregates   — per-page count + average. Read.
 *   refresh_rating_aggregates — recompute now instead of waiting for the
 *                               worker. Direct: idempotent, derived data only.
 */

import { attachCaptchaProof, KIT_CSS, postPluginJson } from "@caelo-cms/plugin-component-kit";
import {
  defineComponent,
  definePlugin,
  type PluginContextTier1,
  PublicOperationError,
  VISITOR_ID_COOKIE,
  z,
} from "@caelo-cms/plugin-sdk";

/** A visitor's vote (#1332): validated by the host before `submit` runs. */
const submitInput = z
  .object({
    pageId: z.string().trim().min(1).max(200),
    score: z.number().int().min(1).max(5),
  })
  .strict();

/** Which page's aggregate a visitor reads; all pages without one. */
const listAggregatesInput = z.object({ pageId: z.string().max(200).optional() }).strict();

/** Most rows one `ctx.query.list` returns (the SDK's cap). */
const QUERY_LIST_CAP = 1000;

/**
 * Most votes one recompute reads (pages of {@link QUERY_LIST_CAP}). Past it
 * the run rewrites nothing and fails loudly (it only prunes); the pruning
 * of superseded votes keeps a site well below it.
 */
const REFRESH_VOTE_PAGES = 50;

interface VoteRow {
  id: string;
  page_id: string;
  visitor_id?: string | null;
  score: number;
  created_at: string;
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
  /** #1292 — the panel lists most-rated first; the recompute pages votes by id. */
  indexes: {
    schema: {
      rating_aggregates: [["page_id"], ["count"]],
    },
  },
  requestedCapabilities: ["background_workers", "chat_runner_tools"],
  // The visitor id below exists only with the visitor's consent, and only
  // a consent provider can ask for it.
  requiresPlugins: ["consent-manager"],
  consentPurposes: [
    {
      key: "visitor_id",
      category: "functional",
      purpose:
        "Recognises the visitor's browser so a second rating of the same page replaces their first instead of counting twice.",
      cookies: [
        {
          name: VISITOR_ID_COOKIE,
          lifetime: "30 days",
          purpose:
            "Holds an anonymous id that remembers which ratings this browser gave, so the visitor can change their rating. The id is stored only after the visitor allows functional cookies and removed when they withdraw.",
        },
      ],
    },
  ],
  /** Visitor-facing surface (default deny — everything else is
   *  refused a visitor-context dispatch). */
  publicOperations: [
    {
      name: "submit",
      kind: "write",
      input: submitInput,
      rateLimit: { max: 20, windowSeconds: 60 },
      // Adds a vote; the recompute finds the visitor's earlier one.
      writes: ["ratings"],
    },
    {
      name: "list_aggregates",
      kind: "read",
      captcha: "none",
      input: listAggregatesInput,
      reads: ["rating_aggregates"],
    },
  ],
  /**
   * #1333 — votes are what visitors send in (`inbox`: insert only); the
   * averages are what the admin recomputes and publishes, visitors only
   * read them (`published`).
   */
  tableKinds: { ratings: "inbox", rating_aggregates: "published" },
  operations: {
    submit: async (ctx, args) => {
      const parsed = submitInput.safeParse(args);
      if (!parsed.success) {
        // The host validates visitor calls first (#1332); this words a
        // direct call's refusal the same way.
        throw new PublicOperationError(
          parsed.error.issues.some((i) => i.path[0] === "score")
            ? "submit: score must be 1..5"
            : "submit: pageId must be a non-empty string up to 200 chars",
        );
      }
      const input = parsed.data;
      // One vote row per submit. A consented visitor's id lets the
      // recompute keep only their newest vote per page; without consent
      // (#677) the vote is anonymous and counts on its own, bounded by the
      // gateway's per-address rate limit and the captcha.
      const r = await ctx.query.insert("ratings", {
        page_id: input.pageId,
        visitor_id: ctx.visitor.id,
        score: input.score,
      });
      return { recorded: true, id: r.id };
    },

    list_aggregates: async (ctx, args) => {
      const input = listAggregatesInput.parse(args ?? {});
      // Most-rated first: the admin panel lists them in this order.
      const filter: Record<string, unknown> = { limit: 200, orderBy: "count", orderDir: "desc" };
      if (input.pageId) filter.page_id = input.pageId;
      const rows = await ctx.query.list<"rating_aggregates", AggregateRow>(
        "rating_aggregates",
        filter,
      );
      return { aggregates: rows };
    },

    /**
     * Worker handler, on the admin's scheduler tick (#1140) every 5 minutes,
     * once per public database (#1333). Recomputes per-page averages from
     * the votes: a consented visitor's newest vote per page counts, their
     * older ones are deleted; anonymous votes count each. Idempotent.
     */
    _refresh: async (ctx, _args) => {
      const votes: VoteRow[] = [];
      let afterId: string | undefined;
      let truncated = false;
      for (let page = 0; ; page++) {
        if (page >= REFRESH_VOTE_PAGES) {
          truncated = true;
          break;
        }
        const batch = await ctx.query.list<"ratings", VoteRow>("ratings", {
          orderBy: "id",
          orderDir: "asc",
          limit: QUERY_LIST_CAP,
          ...(afterId ? { afterId } : {}),
        });
        votes.push(...batch);
        if (batch.length < QUERY_LIST_CAP) break;
        afterId = batch[batch.length - 1]?.id;
      }
      // Newest vote per (page, visitor); ties on created_at go to the larger id.
      const newest = new Map<string, VoteRow>();
      const superseded: string[] = [];
      const counted: VoteRow[] = [];
      for (const v of votes) {
        if (typeof v.visitor_id !== "string" || v.visitor_id.length === 0) {
          counted.push(v);
          continue;
        }
        const key = `${v.page_id}\0${v.visitor_id}`;
        const prev = newest.get(key);
        if (!prev) {
          newest.set(key, v);
          continue;
        }
        const at = new Date(v.created_at).getTime();
        const prevAt = new Date(prev.created_at).getTime();
        const later = at > prevAt || (at === prevAt && v.id > prev.id);
        superseded.push(later ? prev.id : v.id);
        if (later) newest.set(key, v);
      }
      if (truncated) {
        // An incomplete read must not rewrite averages: pages past it would
        // lose theirs and the rest would be wrong. The superseded votes it
        // found are still pruned, so the next run reads fewer; then refuse
        // loudly, on the worker's task row and to the panel's caller.
        for (const id of superseded) await ctx.query.delete("ratings", id);
        throw new Error(
          `_refresh: more than ${REFRESH_VOTE_PAGES * QUERY_LIST_CAP} votes to read in one run; the averages were left as they were (${superseded.length} superseded votes pruned, the next run reads fewer)`,
        );
      }
      counted.push(...newest.values());
      const buckets = new Map<string, { page_id: string; count: number; sum: number }>();
      for (const v of counted) {
        const b = buckets.get(v.page_id) ?? { page_id: v.page_id, count: 0, sum: 0 };
        b.count += 1;
        b.sum += v.score;
        buckets.set(v.page_id, b);
      }
      // Upsert per page instead of wipe + reinsert: a refresh that overlaps
      // another (the worker and an on-demand refresh) then never leaves a
      // page without its average, and any duplicate row an overlap did
      // create is removed by the next run.
      const existing = await ctx.query.list<"rating_aggregates", { id: string; page_id: string }>(
        "rating_aggregates",
        { limit: QUERY_LIST_CAP },
      );
      const byPage = new Map<string, string[]>();
      for (const e of existing) byPage.set(e.page_id, [...(byPage.get(e.page_id) ?? []), e.id]);
      let written = 0;
      for (const b of buckets.values()) {
        const row = {
          page_id: b.page_id,
          count: b.count,
          sum: b.sum,
          average: Math.round((b.sum / b.count) * 100), // 2-decimal int (×100)
        };
        const [keep, ...extra] = byPage.get(b.page_id) ?? [];
        if (keep) await ctx.query.update("rating_aggregates", keep, row);
        else await ctx.query.insert("rating_aggregates", row);
        for (const id of extra) await ctx.query.delete("rating_aggregates", id);
        written += 1;
      }
      for (const [pageId, ids] of byPage) {
        if (buckets.has(pageId)) continue;
        for (const id of ids) await ctx.query.delete("rating_aggregates", id);
      }
      // Only once the new averages are written: a run that fails before
      // keeps every vote for the next one.
      for (const id of superseded) await ctx.query.delete("ratings", id);
      return { refreshed: written, pruned: superseded.length };
    },
  },
  workers: [
    {
      name: "refresh_aggregates",
      cron: "*/5 * * * *",
      operationName: "_refresh",
      // #1333 — live averages from live votes, staging from staging votes.
      publicDatabases: "each",
    },
  ],
  /** Page ratings in the admin (rendered from this declaration). */
  adminPanels: [
    {
      slug: "ratings",
      title: "Ratings",
      description: "How visitors rate your pages.",
      icon: "star",
      permission: "settings.write",
      sections: [
        {
          kind: "table",
          id: "aggregates",
          title: "Page ratings",
          description:
            "Most-rated pages first. Ratings are recounted every five minutes; refresh to recount now.",
          operation: "list_aggregates",
          rowsKey: "aggregates",
          emptyMessage: "No ratings yet.",
          columns: [
            { key: "page_id", label: "Page", format: "code" },
            { key: "count", label: "Votes", format: "number" },
            { key: "average", label: "Average", format: "number", divisor: 100, decimals: 2 },
          ],
          actions: [
            {
              id: "refresh",
              label: "Refresh now",
              operation: "_refresh",
              variant: "secondary",
              successMessage: "Recounted the ratings of {refreshed} pages.",
            },
          ],
        },
      ],
    },
  ],
  tools: [
    {
      name: "list_rating_aggregates",
      description:
        "Read visitor star ratings per page: vote count, sum and average (average is ×100, so 437 = 4.37 stars). Optional pageId to scope to one page. " +
        "Aggregates are recomputed every 5 minutes; call refresh_rating_aggregates first if the operator needs the very latest votes.",
      operationName: "list_aggregates",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: { pageId: { type: "string" } },
      },
    },
    {
      name: "refresh_rating_aggregates",
      description:
        "Recompute the per-page rating aggregates from the raw votes now, instead of waiting for the 5-minute refresh. Safe to repeat; it only rebuilds derived numbers. If the site has more votes than one refresh can read, it changes no average and says so.",
      operationName: "_refresh",
      requiredPermission: "settings.write",
      inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
    },
  ],
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
            const captcha = await attachCaptchaProof("ratings", "submit").catch(() => null);
            await postPluginJson("ratings", "submit", {
              pageId,
              score,
              ...(captcha ? { _caelo_captcha: captcha } : {}),
            });
            await refreshAggregate();
          } catch {
            /* best-effort; keep visual feedback */
          }
        });
      }
    },
  }),
});
