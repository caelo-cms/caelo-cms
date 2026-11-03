// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #359 — where the transcript loads an AI-produced chat image (a tool's
 * screenshot) after a reload. Served by
 * `routes/(authed)/content/chat/[sessionId]/images/[messageId]/[index]`.
 */

/** The address of one stored image: a message of a chat and its attachment index. */
export interface ChatImageAddress {
  chatSessionId: string;
  messageId: string;
  index: number;
}

/** The transcript URL of a message's stored image. */
export function chatImageUrl(address: ChatImageAddress): string {
  return `/content/chat/${address.chatSessionId}/images/${address.messageId}/${address.index}`;
}

/** Loose shape of a persisted attachment as the transcript receives it. */
interface StoredAttachment {
  storageKey?: string;
  mime?: string;
}

/**
 * The URL + type of the first AI-produced image on a persisted tool row, or
 * undefined when the row has none (an older row, or the sweep cleared it).
 * Operator uploads (`assetId`) never sit on tool rows and are not matched.
 */
export function storedToolImage(
  chatSessionId: string,
  message: { id: string; attachments?: readonly StoredAttachment[] | null },
): { src: string; mediaType: string } | undefined {
  const index = (message.attachments ?? []).findIndex(
    (a) => typeof a.storageKey === "string" && typeof a.mime === "string",
  );
  if (index < 0) return undefined;
  const att = message.attachments?.[index];
  return {
    src: chatImageUrl({ chatSessionId, messageId: message.id, index }),
    mediaType: att?.mime ?? "",
  };
}
