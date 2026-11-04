// SPDX-License-Identifier: MPL-2.0
/**
 * #965 — the live editor pins its active chat into `?chat=` before it
 * re-runs the server load. Without the parameter the load picks "the most
 * recent unpublished chat" again, and another chat (an experiment on its
 * own branch, say) can have become that since the page loaded: the preview
 * then switched branches and showed the old text right after an in-place
 * save landed on this one.
 *
 * On a page switch the editor drops its own pin again, so the load picks the
 * destination page's chat as before. Only its own: a chat the operator chose
 * (the overlay's chat picker also sets `?chat=`) stays, even after the
 * editor pinned a different one earlier.
 */
/**
 * Pin `chatId` into `url` unless it already names that chat.
 *
 * @returns true when this call wrote the parameter; the caller remembers
 *   `chatId` as its pin only then.
 */
export function pinChatParam(url, chatId) {
    if (url.searchParams.get("chat") === chatId)
        return false;
    url.searchParams.set("chat", chatId);
    return true;
}
/**
 * Drop the editor's own pin from `url`: the parameter goes only while it
 * still names `pinnedChatId`, the chat the editor wrote there.
 *
 * @param pinnedChatId the chat {@link pinChatParam} last wrote, or null.
 */
export function unpinChatParam(url, pinnedChatId) {
    if (pinnedChatId !== null && url.searchParams.get("chat") === pinnedChatId) {
        url.searchParams.delete("chat");
    }
}
/**
 * #1156 — the URL a refresh of the live editor loads: the editor's chat
 * pinned (see {@link pinChatParam}) and `?page=` following the page the
 * editor shows. The preview can switch pages on the client (an AI tool
 * result naming another page); the server load reads `?page=`, so without
 * this the refreshed data (the page's SEO, its chats) stayed on the old
 * page while the preview showed the new one.
 *
 * @returns the URL, whether this call pinned the chat, and whether the URL
 *   changed at all (unchanged = a plain refresh of the current URL).
 */
export function editorRefreshUrl(href, chatId, pageId) {
    const url = new URL(href);
    const repaged = pageId !== null && url.searchParams.get("page") !== pageId;
    if (repaged)
        url.searchParams.set("page", pageId);
    const pinned = pinChatParam(url, chatId);
    return { url, pinned, changed: repaged || pinned };
}
