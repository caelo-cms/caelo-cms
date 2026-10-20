// SPDX-License-Identifier: MPL-2.0

/**
 * Typed postMessage protocol between the live-edit iframe (the
 * rendered preview of the user's site) and the parent page (the /edit
 * route + its overlay). Messages:
 *
 *   - iframe → parent: `caelo:ready` after first paint.
 *   - iframe → parent: `caelo:navigated` whenever the iframe loads
 *     a new path (covers initial load + click-through navigation).
 *     Carries the resolved pageId/slug so the parent can sync
 *     its activePageId + URL display + chat-branch context.
 *   - iframe → parent: `caelo:element-referenced` when the operator
 *     picks "Ask AI" or "Add to chat" from the right-click menu or the
 *     selection toolbar. Carries the module id, the element path, the
 *     selected text + its surrounding text, and (Ask AI) the prompt.
 *   - parent → iframe: `caelo:reload` to refetch the iframe's source
 *     after a tool result lands a new branch snapshot.
 */

export interface ReadyMessage {
  kind: "caelo:ready";
}

export interface NavigatedMessage {
  kind: "caelo:navigated";
  pageId: string;
  slug: string;
  /** The page's composed URL path — what the URL bar shows (a nested
   *  page's address is its parent chain + slug, not "/<slug>"). */
  path: string;
}

export interface ElementReferencedMessage {
  kind: "caelo:element-referenced";
  moduleId: string;
  /** Element path from the module root, e.g. `section.hero > h1`. */
  selector: string;
  label: string;
  /** The text the operator had selected, when the reference came from a selection. */
  selectedText?: string;
  /** Text of the block the reference sits in (paragraph, heading, list item, …). */
  context?: string;
  /** Ask AI: what the operator typed; the parent sends it into the current chat. */
  prompt?: string;
}

export interface ReloadMessage {
  kind: "caelo:reload";
}

export type IframeToParent = ReadyMessage | NavigatedMessage | ElementReferencedMessage;
export type ParentToIframe = ReloadMessage;
export type CaeloMessage = IframeToParent | ParentToIframe;

export function isCaeloMessage(value: unknown): value is CaeloMessage {
  if (!value || typeof value !== "object") return false;
  const k = (value as { kind?: unknown }).kind;
  return (
    k === "caelo:ready" ||
    k === "caelo:navigated" ||
    k === "caelo:element-referenced" ||
    k === "caelo:reload"
  );
}
