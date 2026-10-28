// SPDX-License-Identifier: MPL-2.0

/**
 * #1216 — one page of a chat transcript for the editor views.
 *
 * The views render the newest {@link CHAT_TRANSCRIPT_PAGE} messages and load
 * older pages on demand ("Show earlier messages"). They never ask for the
 * SDK `response_messages` (only the chat runner replays those) and never
 * ship thinking signatures to the browser: the reasoning text is flattened
 * into `thinkingText`, the signed blocks stay server-side.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { ChatMessage, ChatSession } from "#lib/components/chat/types.js";
import { getQueryContext } from "#lib/server/query.js";

/** Messages per transcript page. */
export const CHAT_TRANSCRIPT_PAGE = 200;

/** A transcript page: the session, its messages oldest-first, and whether older ones exist. */
export interface TranscriptPage {
  session: ChatSession;
  messages: ChatMessage[];
  hasMore: boolean;
}

type StoredMessage = ChatMessage & {
  thinkingBlocks?: { thinking: string; signature: string }[] | null;
};

/** Flatten thinking blocks to display text and drop the signed blocks. */
function forDisplay(m: StoredMessage): ChatMessage {
  const { thinkingBlocks, ...rest } = m;
  const thinkingText =
    Array.isArray(thinkingBlocks) && thinkingBlocks.length > 0
      ? thinkingBlocks.map((b) => b.thinking).join("\n\n")
      : undefined;
  return thinkingText ? { ...rest, thinkingText } : rest;
}

/**
 * Read one transcript page the caller owns, or null when the session is
 * not theirs / does not exist (`chat.get_session` filters by owner).
 *
 * @param before message id cursor: the page ends just before this message.
 */
export async function loadTranscriptPage(
  ctx: ExecutionContext,
  chatSessionId: string,
  before?: string,
): Promise<TranscriptPage | null> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, "chat.get_session", {
    chatSessionId,
    limit: CHAT_TRANSCRIPT_PAGE,
    ...(before ? { before } : {}),
  });
  if (!r.ok) return null;
  const v = r.value as { session: ChatSession; messages: StoredMessage[]; hasMore: boolean };
  return { session: v.session, messages: v.messages.map(forDisplay), hasMore: v.hasMore };
}
