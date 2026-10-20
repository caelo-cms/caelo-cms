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
 *     selected text + its surrounding text, the marked field it sits in
 *     (#917), and whether it was Ask AI. It never carries an instruction
 *     for the AI: the preview runs the site's own scripts, so the
 *     instruction is typed in the editor.
 *   - iframe → parent: `caelo:field-edit` when the operator finished
 *     editing marked values in place (#917, #918); the parent saves them
 *     and reloads the iframe.
 *   - iframe → parent: `caelo:image-replace` (#918) — open the media
 *     picker for a marked image, then save the pick.
 *   - parent → iframe: `caelo:page-paths` (#918) — the site's pages, for
 *     link-target suggestions.
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
  /** #917 — the marked placement field the reference sits in, when there is one. */
  blockName?: string;
  position?: number;
  field?: string;
  /** List item index for a `text-list` / `link-list` field. */
  index?: number;
  /** Ask AI: the parent focuses the chat composer for the operator's instruction. */
  ask?: true;
}

/** One changed value of a placement, as `page_module_content.patch_fields` takes it. */
export interface FieldEdit {
  field: string;
  /** List item of a `text-list` / `link-list` field. */
  index?: number;
  /** Part of a `link-list` item: its text (default) or its target. */
  part?: "label" | "href";
  text: string;
}

/** #917 / #918 — the operator changed marked values of one placement in place. */
export interface FieldEditMessage {
  kind: "caelo:field-edit";
  pageId: string;
  blockName: string;
  position: number;
  edits: FieldEdit[];
  /** Shared content: change it on every page, or detach and change it only here. */
  scope?: "everywhere" | "here";
}

/**
 * #918 — "Replace image…": the iframe cannot show the media library, so
 * the editor opens its picker and saves the picked image into `src` (and
 * its alt text into `alt`, when that is a marked field too). The edits'
 * `text` is empty here; the editor fills it from the pick.
 */
export interface ImageReplaceMessage {
  kind: "caelo:image-replace";
  pageId: string;
  blockName: string;
  position: number;
  src: FieldEdit;
  alt?: FieldEdit;
  scope?: "everywhere" | "here";
}

/** #918 — the site's pages, for link-target suggestions in the link editor. */
export interface PagePathsMessage {
  kind: "caelo:page-paths";
  pages: { path: string; title: string }[];
}

export interface ReloadMessage {
  kind: "caelo:reload";
}

export type IframeToParent =
  | ReadyMessage
  | NavigatedMessage
  | ElementReferencedMessage
  | FieldEditMessage
  | ImageReplaceMessage;
export type ParentToIframe = ReloadMessage | PagePathsMessage;
export type CaeloMessage = IframeToParent | ParentToIframe;

export function isCaeloMessage(value: unknown): value is CaeloMessage {
  if (!value || typeof value !== "object") return false;
  const k = (value as { kind?: unknown }).kind;
  return (
    k === "caelo:ready" ||
    k === "caelo:navigated" ||
    k === "caelo:element-referenced" ||
    k === "caelo:field-edit" ||
    k === "caelo:image-replace" ||
    k === "caelo:page-paths" ||
    k === "caelo:reload"
  );
}

/**
 * The Caelo message a `message` event carries when it comes from the
 * live-edit preview, else null. Both the sender window AND its origin must
 * match: the preview follows external links (they are not intercepted), and
 * the external page then IS `iframe.contentWindow` — the source check alone
 * would let it post `caelo:field-edit` / `caelo:image-replace`, which the
 * editor saves with the operator's CSRF token. Mirrors the iframe side,
 * which checks source and origin on `caelo:reload` (inject-script).
 *
 * @param preview - the preview iframe's `contentWindow`.
 * @param editorOrigin - the origin the preview is served from: the editor's
 *   own (`window.location.origin`).
 */
export function previewMessage(
  ev: Pick<MessageEvent, "source" | "origin" | "data">,
  preview: Window | null | undefined,
  editorOrigin: string,
): CaeloMessage | null {
  if (!preview || ev.source !== preview) return null;
  if (ev.origin !== editorOrigin) return null;
  return isCaeloMessage(ev.data) ? ev.data : null;
}
