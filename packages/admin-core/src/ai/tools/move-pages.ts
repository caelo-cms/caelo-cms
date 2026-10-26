// SPDX-License-Identifier: MPL-2.0

/**
 * Nested page URLs — `move_pages`: put pages under other pages (or back
 * at the top level), optionally renaming them in the same step. The
 * operator says "put Alerts under SEO Monitoring"; the AI makes ONE call
 * and the op moves the whole subtree with redirects. Links on the site
 * are page references (epic #724), so they follow without a rewrite.
 *
 * Approval gate (CLAUDE.md §11.A): a call that would move
 * {@link PAGE_MOVE_APPROVAL_THRESHOLD}+ URLs (moved pages AND every page
 * below them) pauses for one Owner click. A subtree move's blast radius
 * is invisible in the call itself ("move Docs under Resources" can move
 * 60 URLs), and undoing it is not one clean call: every moved URL is
 * public (search engines, bookmarks, other sites), and moving back
 * leaves a second generation of 301s. Below the threshold it stays
 * routine, like a single slug change. Same spirit as the
 * `redirects.delete_many` ≥10 cap.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import { resolvePageRefs } from "./_page-ref.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";

/** URLs a single call may move before an Owner click is required. */
export const PAGE_MOVE_APPROVAL_THRESHOLD = 10;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** A page reference: its UUID or its URL path ("/seo-monitoring"). */
const pageRef = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => v.startsWith("/") || z.string().uuid().safeParse(v).success, {
    message: "a page id (UUID) or a URL path starting with '/'",
  });

const moveItem = z
  .object({
    page: pageRef,
    /** New parent (id or path), or null for the top level. */
    parent: pageRef.nullable(),
    newSlug: z.string().regex(SLUG_RE).optional(),
  })
  .strict();
const moveInput = z
  .object({
    moves: z.array(moveItem).min(1).max(200),
    redirectFromOld: z.enum(["auto", "skip"]).default("auto"),
  })
  .strict();
type MoveInput = z.infer<typeof moveInput>;

interface ResolvedMove {
  pageId: string;
  parentPageId: string | null;
  newSlug?: string;
}

/**
 * Resolve id-or-path references against the caller's view of the site
 * (a chat sees its own pending moves) — one shared resolver
 * ({@link resolvePageRefs}) for every tool that addresses pages.
 */
export async function resolveMoveRefs(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  moves: MoveInput["moves"],
): Promise<{ ok: true; moves: ResolvedMove[] } | { ok: false; message: string }> {
  const refs = moves.flatMap((m) => (m.parent === null ? [m.page] : [m.page, m.parent]));
  const resolved = await resolvePageRefs(ctx, toolCtx, refs);
  const out: ResolvedMove[] = [];
  let i = 0;
  for (const m of moves) {
    const page = resolved[i++];
    if (!page?.ok) return { ok: false, message: page?.message ?? "unresolved page" };
    let parentPageId: string | null = null;
    if (m.parent !== null) {
      const parent = resolved[i++];
      if (!parent?.ok) {
        return {
          ok: false,
          message: `parent ${m.parent}: ${parent?.message ?? "unresolved"} (or pass null to move to the top level)`,
        };
      }
      parentPageId = parent.pageId;
    }
    out.push({ pageId: page.pageId, parentPageId, ...(m.newSlug ? { newSlug: m.newSlug } : {}) });
  }
  return { ok: true, moves: out };
}

/**
 * How many URLs a set of page moves / renames would change (moved pages
 * plus every page below them), via the `pages.plan_moves` dry run. A
 * refused plan counts 0 — the real call returns the refusal, nothing to
 * approve.
 */
export async function countMovedUrls(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  moves: ReadonlyArray<{ pageId: string; parentPageId?: string | null; newSlug?: string }>,
): Promise<{ count: number; sample: { from: string; to: string }[] }> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.plan_moves", { moves });
  if (!r.ok) throw new Error(`pages.plan_moves failed: ${describeError(r.error)}`);
  const v = r.value as { ok: boolean; moved: { from: string; to: string }[] };
  return { count: v.moved.length, sample: v.moved.slice(0, 5) };
}

export const movePagesTool: ToolDefinitionWithHandler<MoveInput> = {
  name: "move_pages",
  description:
    "Nest pages under other pages or back to top level, 1..N moves in one transaction ('put Alerts under SEO Monitoring').\n" +
    "DO NOT USE FOR: only renaming name/title/slug -> `update_pages_many`; new page under a parent -> `build_page` with `page.parentPageId`.\n" +
    "CORE RULES: URL = parent URL + '/' + slug; subpages move along. 301s from old URLs are automatic; on-site links follow on their own (no link-update step). " +
    "Target URL taken -> nothing changes, clash named -> retry with `newSlug`. Homepage can't move under a page or have children; max 6 levels. " +
    `${PAGE_MOVE_APPROVAL_THRESHOLD}+ moved URLs (incl. subtrees) pause for one Owner click in chat.`,
  needsApproval: async (input, ctx, toolCtx) => {
    const resolved = await resolveMoveRefs(ctx, toolCtx, input.moves);
    if (!resolved.ok) return false;
    const { count } = await countMovedUrls(ctx, toolCtx, resolved.moves);
    return count >= PAGE_MOVE_APPROVAL_THRESHOLD;
  },
  approverPermissions: ["content.write"],
  buildApprovalPreview: async (input, ctx, toolCtx) => {
    const resolved = await resolveMoveRefs(ctx, toolCtx, input.moves);
    if (!resolved.ok) return { op: "move_pages", moves: input.moves.length };
    const { count, sample } = await countMovedUrls(ctx, toolCtx, resolved.moves);
    return { op: "move_pages", movedUrlCount: count, sampleMoves: sample };
  },
  schema: moveInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["moves"],
    properties: {
      moves: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["page", "parent"],
          properties: {
            page: {
              type: "string",
              description: "Id or current URL path (e.g. '/alerts').",
            },
            parent: {
              type: ["string", "null"],
              description: "Id or URL path; null = top level.",
            },
            newSlug: {
              type: "string",
              pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
              description: "Rename in the same step; needed when the target URL is taken.",
            },
          },
        },
      },
      redirectFromOld: {
        type: "string",
        enum: ["auto", "skip"],
        description: "'skip' = no 301s; only when the operator wants old URLs to 404.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const resolved = await resolveMoveRefs(ctx, toolCtx, input.moves);
    if (!resolved.ok) return { ok: false, content: resolved.message };
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.move_many", {
      moves: resolved.moves,
      redirectFromOld: input.redirectFromOld,
    });
    if (!r.ok) return { ok: false, content: `move_pages refused: ${describeError(r.error)}` };
    const v = r.value as {
      moved: { from: string; to: string }[];
      pendingPublish: boolean;
      redirectsCreated: number;
    };
    const list = v.moved
      .slice(0, 20)
      .map((m) => `- ${m.from} → ${m.to}`)
      .join("\n");
    const more = v.moved.length > 20 ? `\n- … and ${v.moved.length - 20} more` : "";
    const when = v.pendingPublish
      ? "These are this chat's pending changes: the live URLs and their 301s apply when the chat is published; this chat's preview already shows the new URLs."
      : `Created ${v.redirectsCreated} redirects from the old URLs.`;
    return {
      ok: true,
      content: `Moved ${v.moved.length} URL(s):\n${list}${more}\n${when} Links on the site follow automatically; nothing else to update.`,
    };
  },
};
