// SPDX-License-Identifier: MPL-2.0

/**
 * Nested page URLs — `move_pages`: put pages under other pages (or back
 * at the top level), optionally renaming them in the same step. The
 * operator says "put Alerts under SEO Monitoring"; the AI makes ONE call
 * and the op moves the whole subtree with redirects + link rewrites.
 *
 * Approval gate (CLAUDE.md §11.A): a call that would move
 * {@link PAGE_MOVE_APPROVAL_THRESHOLD}+ URLs (moved pages AND every page
 * below them) pauses for one Owner click. A subtree move's blast radius
 * is invisible in the call itself ("move Docs under Resources" can move
 * 60 URLs), and undoing it is not one clean call: moving back leaves a
 * second generation of 301s, and the link rewrites across modules and
 * content cannot be selectively un-rewritten. Below the threshold it
 * stays routine, like a single slug change. Same spirit as the
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
    "Put pages under other pages (nested URLs), or back at the top level — for 1 page or 200 in one call. " +
    "Use for 'put Alerts under SEO Monitoring', 'move the pricing page into Products', 'make this a top-level page again', 'group these 5 guides under /guides'. " +
    "A page's URL is its parent's URL + '/' + its slug, so moving `/alerts` under `/seo-monitoring` makes it `/seo-monitoring/alerts`; every page below a moved page moves with it. " +
    "Each move: `page` = the page's id or current URL path, `parent` = the new parent's id or path, or null for the top level, optional `newSlug` to rename in the same step. " +
    "Everything happens in one transaction: 301s from every old URL, and nav menus, link lists, module and content links are rewritten to the new URLs. " +
    "If the target URL is already taken, the call changes nothing and names the clash — retry with `newSlug`. The homepage can neither move under a page nor have child pages; nesting is limited to 6 levels. " +
    `Moving ${PAGE_MOVE_APPROVAL_THRESHOLD}+ URLs in one call (pages + their subtrees) needs one Owner click in chat before it runs. ` +
    "To change only a page's name/title/slug use update_pages_many; to create a page under a parent use build_page with page.parentPageId.",
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
              description:
                "The page to move: its id (UUID) or its current URL path (e.g. '/alerts').",
            },
            parent: {
              type: ["string", "null"],
              description:
                "The new parent page: id or URL path (e.g. '/seo-monitoring'). null = top level.",
            },
            newSlug: {
              type: "string",
              pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
              description:
                "Optional rename in the same step (lowercase, digits, hyphens). Required when the target URL is already taken.",
            },
          },
        },
      },
      redirectFromOld: {
        type: "string",
        enum: ["auto", "skip"],
        description:
          "'skip' suppresses the 301s from the old URLs — only when the operator says the old URLs should 404.",
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
      rewrittenLinkSets: number;
      rewrittenModules: number;
      rewrittenContentInstances: number;
      blockedLinkSets: string[];
    };
    const list = v.moved
      .slice(0, 20)
      .map((m) => `- ${m.from} → ${m.to}`)
      .join("\n");
    const more = v.moved.length > 20 ? `\n- … and ${v.moved.length - 20} more` : "";
    const when = v.pendingPublish
      ? "These are this chat's pending changes: the live URLs, their 301s and the link rewrites apply when the chat is published."
      : `Created ${v.redirectsCreated} redirects; rewrote links in ${v.rewrittenLinkSets} menus/link lists, ${v.rewrittenModules} modules, ${v.rewrittenContentInstances} content items.`;
    const blocked =
      v.blockedLinkSets.length > 0
        ? ` Not rewritten (held by another chat, old links still work via 301): ${v.blockedLinkSets.join(", ")}.`
        : "";
    return {
      ok: true,
      content: `Moved ${v.moved.length} URL(s):\n${list}${more}\n${when}${blocked}`,
    };
  },
};
