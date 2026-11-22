// SPDX-License-Identifier: MPL-2.0

/**
 * Core building block `comment-thread.read` (#1340): a page's approved
 * comments, newest page first, from what the admin publishes after
 * moderation (core's `comment_archive.list_for_page`, backed by cms_public
 * on the gateway, v0.2.18 Fix D). The inbox of new comments is never read
 * back to visitors.
 *
 * The answer is the row shape the comments runtime reads: `{ nextCursor,
 * comments: [{ id, page_id, author_name, content, status, submitted_at }] }`.
 */

import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";

/** Comments per page of a thread (the runtime's "Show older comments" step). */
export const COMMENT_THREAD_PAGE_SIZE = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ThreadCursor {
  readonly archivedAt: string;
  readonly id: string;
}

interface ApprovedComment {
  readonly publicRowId: string;
  readonly authorName: string;
  readonly content: string;
  readonly submittedAt: string;
}

async function read(ctx: PluginContextTier1, args: unknown): Promise<unknown> {
  const input = args as { pageId: string; since?: string; before?: ThreadCursor };
  // A page id that is no UUID has no thread (pages are UUIDs).
  if (!ctx.cms || !UUID_RE.test(input.pageId)) return { nextCursor: null, comments: [] };
  const page = await ctx.cms.call<
    { pageId: string; status: "approved"; limit: number; since?: string; before?: ThreadCursor },
    { comments: ApprovedComment[]; nextCursor: ThreadCursor | null }
  >("comment_archive.list_for_page", {
    pageId: input.pageId,
    status: "approved",
    limit: COMMENT_THREAD_PAGE_SIZE,
    ...(input.since ? { since: input.since } : {}),
    ...(input.before ? { before: input.before } : {}),
  });
  return {
    nextCursor: page.nextCursor,
    comments: page.comments.map((c) => ({
      id: c.publicRowId,
      page_id: input.pageId,
      author_name: c.authorName,
      content: c.content,
      status: "approved" as const,
      submitted_at: c.submittedAt,
    })),
  };
}

/** The comment-thread blocks. */
export const COMMENT_THREAD_BLOCKS = { "comment-thread.read": read } as const;
