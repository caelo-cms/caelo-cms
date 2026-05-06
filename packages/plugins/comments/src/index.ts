// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-comments — Tier-1 plugin: moderated comments with locale awareness.
 *
 * P12 PR2.5 — first AI-moderation user. Visitor submits → status='pending' →
 * AI classifies → Owner/AI flips to approved/rejected/spam. Static-render at
 * deploy bakes approved comments; deltas land via api.list({since}).
 *
 * Schema (cms_public.plugin_comments.*):
 *   comments — page_id + locale + parent_id (3-level threads) + author + status
 *   comment_meta — page_id + locale + last_approved_at + count (delta-fetch since)
 */

import {
  attachCaptchaProof,
  escapeHtml,
  honeypotFieldHtml,
  isHoneypotTripped,
  KIT_CSS,
  postPluginJson,
  readBakeTimestamp,
  setStatus,
} from "@caelo-cms/plugin-component-kit";
import { defineComponent, definePlugin, type PluginContextTier1 } from "@caelo-cms/plugin-sdk";

const MAX_THREAD_DEPTH = 3;

interface SubmitInput {
  pageId: string;
  locale: string;
  parentId?: string | null;
  authorName: string;
  content: string;
  captchaToken?: string | null;
}

interface CommentRow {
  id: string;
  page_id: string;
  locale: string;
  parent_id: string | null;
  author_name: string;
  content: string;
  status: string;
  submitted_at: string;
}

/**
 * v0.2.18 / Fix D — three-step drain for one moderated comment:
 *   1. Read full row from cms_public so the data is in hand before
 *      it disappears from the public DB.
 *   2. Insert into cms_admin's comment_archive. Idempotent via
 *      UNIQUE(public_row_id) so a retry can't double-archive.
 *   3. Delete the public-DB row. Best-effort: if step 2 succeeded but
 *      step 3 failed, the next moderation attempt re-runs cleanly
 *      (insert is no-op, delete retries).
 *
 * Throws on input row not found OR ctx.cms unavailable. Errors from
 * the archive insert propagate up so the moderation tool surfaces
 * them honestly instead of silently failing.
 */
async function archiveAndDeletePublic(
  ctx: PluginContextTier1,
  commentId: string,
  decision: "approved" | "rejected" | "spam",
): Promise<void> {
  if (!ctx.cms) {
    throw new Error("comments.moderate: cms capability required to drain to admin");
  }
  // 1. Read the comment's data before deleting.
  const matches = await ctx.query.list<"comments", CommentRow>("comments", {
    id: commentId,
    limit: 1,
  });
  const row = matches[0];
  if (!row) {
    // Already drained or never existed — nothing to do (and no error
    // since a retry of an already-completed moderate is harmless).
    return;
  }
  // 2. Insert into cms_admin archive. Idempotent.
  await ctx.cms.call<
    {
      publicRowId: string;
      pageId: string;
      locale: string;
      parentId: string | null;
      authorName: string;
      content: string;
      status: "approved" | "rejected" | "spam";
      submittedAt: string;
    },
    { archiveId: string | null }
  >("comment_archive.insert", {
    publicRowId: row.id,
    pageId: row.page_id,
    locale: row.locale,
    parentId: row.parent_id && row.parent_id.length > 0 ? row.parent_id : null,
    authorName: row.author_name,
    content: row.content,
    status: decision,
    // submitted_at may come back as a Date from the driver; coerce
    // to an ISO string so the archive op's z.string().datetime()
    // validator accepts it.
    submittedAt:
      typeof row.submitted_at === "string"
        ? row.submitted_at
        : new Date(row.submitted_at as unknown as Date).toISOString(),
  });
  // 3. Delete from cms_public.
  await ctx.query.delete("comments", row.id);
}

export default definePlugin<PluginContextTier1>({
  slug: "comments",
  version: "1.1.0",
  tier: 1,
  schema: {
    comments: {
      id: "uuid",
      page_id: "string",
      locale: "string",
      parent_id: "string",
      author_name: "string",
      content: "text",
      status: "enum:pending,approved,rejected,spam",
      submitted_at: "timestamp",
    },
    comment_meta: {
      id: "uuid",
      page_id: "string",
      locale: "string",
      count_approved: "int",
      last_approved_at: "timestamp",
    },
  },
  requestedCapabilities: ["ai_provider", "chat_runner_tools", "cms_admin"],
  operations: {
    submit: async (ctx, args) => {
      const input = args as SubmitInput;
      if (!input.content.trim()) throw new Error("submit: content empty");
      if (!input.authorName.trim()) throw new Error("submit: authorName required");
      const ok = await ctx.captcha.requireProof(input.captchaToken ?? null);
      if (!ok) throw new Error("submit: captcha verification failed");

      // Enforce thread depth.
      if (input.parentId) {
        let depth = 1;
        let cursor: string | null = input.parentId;
        while (cursor && depth <= MAX_THREAD_DEPTH) {
          const parents: Array<{ parent_id: string | null }> = await ctx.query.list<
            "comments",
            { parent_id: string | null }
          >("comments", { id: cursor, limit: 1 });
          if (!parents[0]) break;
          cursor = parents[0].parent_id;
          depth += 1;
        }
        if (depth > MAX_THREAD_DEPTH) {
          throw new Error(`submit: thread depth exceeds ${MAX_THREAD_DEPTH}`);
        }
      }

      const r = await ctx.query.insert("comments", {
        page_id: input.pageId,
        locale: input.locale,
        parent_id: input.parentId ?? "",
        author_name: input.authorName.slice(0, 80),
        content: input.content.slice(0, 4000),
        status: "pending",
      });
      return { commentId: r.id, status: "pending" as const };
    },

    list_approved: async (ctx, args) => {
      // v0.2.18 / Fix D — approved comments live in cms_admin's
      // comment_archive after moderation. cms_public.plugin_comments
      // is now a write-only inbox; reads go through ctx.cms.call so a
      // public-DB compromise leaks at most pending submissions.
      const input = args as { pageId: string; locale: string; since?: string };
      if (!("cms" in ctx) || !ctx.cms) return { comments: [] };
      const r = await ctx.cms.call<
        { pageId: string; locale: string; status: "approved"; since?: string; limit: number },
        {
          comments: ReadonlyArray<{
            publicRowId: string;
            authorName: string;
            content: string;
            submittedAt: string;
          }>;
        }
      >("comment_archive.list_for_page", {
        pageId: input.pageId,
        locale: input.locale,
        status: "approved",
        ...(input.since ? { since: input.since } : {}),
        limit: 200,
      });
      // Reshape to the legacy `CommentRow` shape so the Web Component +
      // tests don't need to know reads moved to cms_admin.
      return {
        comments: r.comments.map((c) => ({
          id: c.publicRowId,
          page_id: input.pageId,
          locale: input.locale,
          parent_id: "",
          author_name: c.authorName,
          content: c.content,
          status: "approved" as const,
          submitted_at: c.submittedAt,
        })),
      };
    },

    list_pending: async (ctx, _args) => {
      const rows = await ctx.query.list<"comments", CommentRow>("comments", {
        status: "pending",
        orderBy: "submitted_at",
        orderDir: "desc",
        limit: 200,
      });
      return { comments: rows };
    },

    moderate: async (ctx, args) => {
      // v0.2.18 / Fix D — moderation drains the row to cms_admin and
      // deletes from cms_public. Three steps in handler-local order:
      //   1. Read full row from cms_public so we have the data to
      //      archive (after delete it's gone).
      //   2. Insert into cms_admin.comment_archive (idempotent via
      //      UNIQUE(public_row_id) — a retry doesn't double-archive).
      //   3. Delete from cms_public so a public-DB compromise leaks
      //      no historical comment data.
      const input = args as { commentId: string; decision: "approved" | "rejected" | "spam" };
      await archiveAndDeletePublic(ctx, input.commentId, input.decision);
      return { commentId: input.commentId, status: input.decision };
    },

    bulk_moderate: async (ctx, args) => {
      const input = args as {
        commentIds: ReadonlyArray<string>;
        decision: "approved" | "rejected" | "spam";
      };
      let updated = 0;
      for (const id of input.commentIds) {
        try {
          await archiveAndDeletePublic(ctx, id, input.decision);
          updated += 1;
        } catch {
          // Per-row failure shouldn't strand the whole batch; the
          // unarchived row stays in cms_public for a retry on the
          // next moderation attempt.
        }
      }
      return { updated };
    },

    /**
     * AI moderation. Classifies a single pending comment as approved /
     * rejected / spam via ctx.ai.complete; flips status on the basis
     * of a confident "spam" or "rejected"; otherwise leaves pending
     * for human review (intentionally cautious by default).
     */
    ai_moderate: async (ctx, args) => {
      const input = args as { commentId: string };
      if (!ctx.ai) throw new Error("ai_moderate: ai_provider capability required");
      const matches = await ctx.query.list<"comments", { content: string; author_name: string }>(
        "comments",
        { id: input.commentId, limit: 1 },
      );
      const target = matches[0];
      if (!target) throw new Error("ai_moderate: comment not found");
      const completion = await ctx.ai.complete({
        system:
          "You moderate visitor comments. Reply with EXACTLY one of: APPROVE, REJECT, SPAM. Approve everything that's a real opinion or question. Reject toxic/abusive but non-spam content. SPAM only for obvious bot/promotional spam.",
        messages: [{ role: "user", content: `${target.author_name} wrote:\n${target.content}` }],
        maxTokens: 8,
      });
      const verdict = completion.text.trim().toUpperCase();
      let decision: "approved" | "rejected" | "spam" = "approved";
      if (verdict.startsWith("SPAM")) decision = "spam";
      else if (verdict.startsWith("REJECT")) decision = "rejected";
      await ctx.query.update("comments", input.commentId, { status: decision });
      return { commentId: input.commentId, status: decision, verdict };
    },
  },
  tools: [
    {
      name: "list_pending_comments",
      description: "Browse unmoderated visitor comments. Returns up to 200 ordered newest first.",
      operationName: "list_pending",
      inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: "moderate_comment",
      description:
        "Moderate one comment. `decision` ∈ approved | rejected | spam. Use `bulk_moderate` for >1 at a time.",
      operationName: "moderate",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["commentId", "decision"],
        properties: {
          commentId: { type: "string" },
          decision: { type: "string", enum: ["approved", "rejected", "spam"] },
        },
      },
    },
    {
      name: "ai_moderate_comment",
      description:
        "Use ctx.ai.complete to classify ONE comment. Returns the AI's verdict + the new status. Cautious by default — uncertain comments stay pending.",
      operationName: "ai_moderate",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["commentId"],
        properties: { commentId: { type: "string" } },
      },
    },
  ],
  /**
   * P13 perf-pass — batched signature for the whole locale at once.
   * The static-generator prefers this over `metaSignature` so a
   * 1000-page site does ONE list query instead of 1000.
   */
  metaSignatureBatch: async (ctx, args) => {
    // v0.2.18 / Fix D — approved comments are in cms_admin's
    // comment_archive after moderation. Per-page batched signature
    // reads from there so a 1000-page deploy still does ONE query
    // per (slug, locale) bucket.
    if (!("cms" in ctx) || !ctx.cms) return new Map();
    const out = new Map<string, string>();
    try {
      // List for each requested page. comment_archive has its own
      // (page_id, locale, status) index, so per-page lookups are
      // cheap even though we issue N. The single-bucket pattern
      // below stays in cms_admin.
      for (const pageId of args.pageIds) {
        const r = await ctx.cms.call<
          { pageId: string; locale: string; status: string; limit: number },
          {
            comments: ReadonlyArray<{ id: string; submittedAt: string }>;
          }
        >("comment_archive.list_for_page", {
          pageId,
          locale: args.locale,
          status: "approved",
          limit: 5000,
        });
        if (r.comments.length === 0) {
          out.set(pageId, "0:0");
        } else {
          let max = r.comments[0]?.submittedAt ?? "0";
          for (const c of r.comments) {
            if (c.submittedAt > max) max = c.submittedAt;
          }
          out.set(pageId, `${r.comments.length}:${max}`);
        }
      }
      return out;
    } catch {
      return out;
    }
  },

  /**
   * P13 audit fix #4 — cheap signature of the (page, locale) thread
   * state. The static-generator folds this into the bake cache key so
   * approving a new comment busts the stale bake even though the
   * page itself didn't change.
   */
  metaSignature: async (ctx, args) => {
    // v0.2.18 / Fix D — read from cms_admin's comment_archive.
    if (!("cms" in ctx) || !ctx.cms) return "";
    try {
      const r = await ctx.cms.call<
        { pageId: string; locale: string; status: string; limit: number },
        {
          comments: ReadonlyArray<{ id: string; submittedAt: string }>;
        }
      >("comment_archive.list_for_page", {
        pageId: args.pageId,
        locale: args.locale,
        status: "approved",
        limit: 1000,
      });
      let max = "0";
      for (const c of r.comments) if (c.submittedAt > max) max = c.submittedAt;
      return `${r.comments.length}:${max}`;
    } catch {
      return "";
    }
  },

  /**
   * P13 — staticRender bakes the approved-comments thread at deploy
   * time. The Web Component picks up `data-baked-at` and only fetches
   * deltas (rows added since the bake) on the client.
   */
  staticRender: async (ctx, args) => {
    // v0.2.18 / Fix D — bake from cms_admin's comment_archive. The
    // public DB only carries pending submissions; serving HTML reads
    // from the admin-side long-term store.
    if (!("cms" in ctx) || !ctx.cms) return "";
    try {
      const r = await ctx.cms.call<
        { pageId: string; locale: string; status: string; limit: number },
        {
          comments: ReadonlyArray<{
            id: string;
            authorName: string;
            content: string;
            submittedAt: string;
          }>;
        }
      >("comment_archive.list_for_page", {
        pageId: args.pageId,
        locale: args.locale,
        status: "approved",
        limit: 200,
      });
      return r.comments
        .map((c) => {
          const safeAuthor = c.authorName
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          const safeContent = c.content
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          return `<article class="comment"><header>${safeAuthor} · ${new Date(c.submittedAt).toISOString()}</header><div class="body">${safeContent}</div></article>`;
        })
        .join("");
    } catch {
      return "";
    }
  },

  /**
   * Web Component `<caelo-comments>` — visitor-facing comments thread.
   * Server-renders approved comments at deploy via staticRender (P13);
   * client-side fetch refreshes after `since` for late comments.
   *
   * Attributes: page-id, locale.
   */
  component: defineComponent({
    tag: "caelo-comments",
    shadowMode: "open",
    mounted: async (host) => {
      const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      const pageId = host.getAttribute("page-id") ?? "";
      const locale = host.getAttribute("locale") ?? "en";

      // Comments-specific CSS extends the kit base.
      const extraCss = `
        .thread { display: grid; gap: 1rem; }
        .comment { border-left: 2px solid var(--caelo-color-border, #e5e7eb); padding-left: 1rem; }
        .comment header { font-size: 0.875rem; color: var(--caelo-color-muted, #6b7280); margin-bottom: 0.25rem; }
        .comment .body { white-space: pre-wrap; }
        form { margin-top: 1.5rem; }
      `;

      root.innerHTML = `
        <style>${KIT_CSS}${extraCss}</style>
        <div data-thread class="thread"></div>
        <form novalidate>
          <h3>Add a comment</h3>
          <input name="authorName" placeholder="Your name" required />
          <textarea name="content" placeholder="Your comment" rows="3" required></textarea>
          ${honeypotFieldHtml()}
          <button type="submit">Post</button>
          <p data-status aria-live="polite"></p>
        </form>
      `;

      const threadEl = root.querySelector("[data-thread]") as HTMLDivElement;
      const form = root.querySelector("form") as HTMLFormElement;
      const status = root.querySelector("[data-status]") as HTMLParagraphElement;

      // P13 — only fetch deltas (rows added since the bake) when the
      // static generator pre-rendered the thread. The placeholder's
      // data-baked-at attribute carries the cutoff. When the bake is
      // missing (preview / dev) we fall back to a full fetch.
      const bakedAt = readBakeTimestamp(host, "comments");

      async function refresh(): Promise<void> {
        try {
          const args: Record<string, unknown> = { pageId, locale };
          if (bakedAt) args.since = bakedAt;
          const json = await postPluginJson<{
            comments: Array<{
              id: string;
              author_name: string;
              content: string;
              submitted_at: string;
            }>;
          }>("comments", "list_approved", args);
          if (!json.ok || !json.data) return;
          // If we're delta-fetching, prepend the new ones; otherwise
          // replace the thread entirely.
          const html = json.data.comments
            .map(
              (c) =>
                `<article class="comment"><header>${escapeHtml(c.author_name)} · ${new Date(c.submitted_at).toLocaleDateString()}</header><div class="body">${escapeHtml(c.content)}</div></article>`,
            )
            .join("");
          if (bakedAt) {
            threadEl.insertAdjacentHTML("afterbegin", html);
          } else {
            threadEl.innerHTML = html;
          }
        } catch {
          // best-effort
        }
      }

      await refresh();

      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        setStatus(status, "clear");
        const fd = new FormData(form);
        if (isHoneypotTripped(fd)) {
          setStatus(status, "ok", "Thanks — pending moderation.");
          form.reset();
          return;
        }
        try {
          // P13 — solve PoW captcha (if enabled by /security/gateway).
          const captcha = await attachCaptchaProof().catch(() => null);
          const json = await postPluginJson("comments", "submit", {
            pageId,
            locale,
            authorName: fd.get("authorName"),
            content: fd.get("content"),
            captchaToken: "dev",
            ...(captcha ? { _caelo_captcha: captcha } : {}),
          });
          if (json.ok) {
            setStatus(status, "ok", "Thanks — pending moderation.");
            form.reset();
          } else {
            setStatus(status, "err", json.error?.message ?? "Submission failed.");
          }
        } catch (e) {
          setStatus(status, "err", `Network error: ${(e as Error).message}`);
        }
      });
    },
  }),
  promptContext: [
    {
      label: "comments",
      render: async (ctx) => {
        if (!("query" in ctx)) return "";
        try {
          const pending = await ctx.query.list<"comments", { id: string }>("comments", {
            status: "pending",
            limit: 200,
          });
          if (pending.length === 0) return "";
          return [
            "# Comments awaiting moderation",
            `${pending.length} comment${pending.length === 1 ? "" : "s"} pending. Use list_pending_comments to browse, ai_moderate_comment to triage.`,
          ].join("\n");
        } catch {
          return "";
        }
      },
    },
  ],
});
