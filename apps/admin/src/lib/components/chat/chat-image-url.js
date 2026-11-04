// SPDX-License-Identifier: MPL-2.0
/** The transcript URL of a message's stored image. */
export function chatImageUrl(address) {
    return `/content/chat/${address.chatSessionId}/images/${address.messageId}/${address.index}`;
}
/**
 * The URL + type of the first AI-produced image on a persisted tool row, or
 * undefined when the row has none (an older row, or the sweep cleared it).
 * Operator uploads (`assetId`) never sit on tool rows and are not matched.
 */
export function storedToolImage(chatSessionId, message) {
    const index = (message.attachments ?? []).findIndex((a) => typeof a.storageKey === "string" && typeof a.mime === "string");
    if (index < 0)
        return undefined;
    const att = message.attachments?.[index];
    return {
        src: chatImageUrl({ chatSessionId, messageId: message.id, index }),
        mediaType: att?.mime ?? "",
    };
}
