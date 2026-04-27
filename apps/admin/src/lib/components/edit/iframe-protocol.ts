// SPDX-License-Identifier: MPL-2.0

/**
 * Typed postMessage protocol between the live-edit iframe (the
 * rendered preview of the user's site) and the parent page (the /edit
 * route + its overlay). Four messages:
 *
 *   - iframe → parent: `caelo:ready` after first paint.
 *   - iframe → parent: `caelo:navigated` whenever the iframe loads
 *     a new path (covers initial load + click-through navigation).
 *     Carries the resolved pageId/locale/slug so the parent can sync
 *     its activePageId + URL display + chat-branch context.
 *   - iframe → parent: `caelo:element-clicked` when the editor clicks
 *     a hover-affordanced element with the modifier combo held.
 *     Carries the data-caelo-module-id for the click target.
 *   - parent → iframe: `caelo:reload` to refetch the iframe's source
 *     after a tool result lands a new branch snapshot.
 */

export interface ReadyMessage {
  kind: "caelo:ready";
}

export interface NavigatedMessage {
  kind: "caelo:navigated";
  pageId: string;
  locale: string;
  slug: string;
}

export interface ElementClickedMessage {
  kind: "caelo:element-clicked";
  moduleId: string;
  selector: string;
  label: string;
}

export interface ReloadMessage {
  kind: "caelo:reload";
}

export type IframeToParent = ReadyMessage | NavigatedMessage | ElementClickedMessage;
export type ParentToIframe = ReloadMessage;
export type CaeloMessage = IframeToParent | ParentToIframe;

export function isCaeloMessage(value: unknown): value is CaeloMessage {
  if (!value || typeof value !== "object") return false;
  const k = (value as { kind?: unknown }).kind;
  return (
    k === "caelo:ready" ||
    k === "caelo:navigated" ||
    k === "caelo:element-clicked" ||
    k === "caelo:reload"
  );
}
