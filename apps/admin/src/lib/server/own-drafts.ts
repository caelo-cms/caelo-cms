// SPDX-License-Identifier: MPL-2.0

/**
 * The operator's own conversations with draft changes, read in full:
 * `chat.list_open_changes` (`mineOnly`) pages its answer (100 chats per
 * page), and every reader here needs all of them. The Staging menu and
 * Content → Changes list them, the Stage form is checked against them
 * (stage-selection.ts), and the dashboard counts them. A conversation
 * past the first page must not drop out of any of these.
 */

import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { DraftChat } from "#lib/components/edit/draft-chats.js";
import { getQueryContext } from "./query.js";

/** One page of `chat.list_open_changes`. */
interface OpenChangesPage<T> {
  readonly chats: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * Every chat of a keyset-paged read, page after page. Throws when the
 * read hands back a cursor it already gave: following it would never end.
 */
export async function readAllPages<T>(
  readPage: (cursor: string | undefined) => Promise<OpenChangesPage<T>>,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await readPage(cursor);
    all.push(...page.chats);
    if (page.nextCursor === null) return all;
    if (seen.has(page.nextCursor)) {
      throw new Error("chat.list_open_changes returned the same page cursor twice");
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

/** The operator's own conversations with draft changes, most recently active first. */
export async function readOwnDraftChats(ctx: ExecutionContext): Promise<DraftChat[]> {
  const { adapter, registry } = getQueryContext();
  const chats = await readAllPages<DraftChat>(async (cursor) => {
    const r = await execute(registry, adapter, ctx, "chat.list_open_changes", {
      mineOnly: true,
      ...(cursor ? { cursor } : {}),
    });
    if (!r.ok) {
      console.error("[drafts] chat.list_open_changes failed", { error: r.error });
      throw new Error(`Your draft changes could not be loaded: ${describeError(r.error)}`);
    }
    return r.value as OpenChangesPage<DraftChat>;
  });
  // A conversation that only holds locks has nothing to stage.
  return chats
    .filter((c) => c.pendingCount > 0)
    .map((c) => ({
      chatSessionId: c.chatSessionId,
      title: c.title,
      branchKind: c.branchKind,
      anchorPageId: c.anchorPageId,
      anchorPagePath: c.anchorPagePath,
      pendingCount: c.pendingCount,
      summary: c.summary,
    }));
}
