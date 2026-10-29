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
 *   - iframe → parent: `caelo:navigate` (#946) — load another preview page
 *     (a link click) or the same one again (the answer to `caelo:reload`);
 *     the parent navigates the iframe.
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
 *   - iframe → parent: `caelo:cookies` — the preview's cookie jar after
 *     the page changed a cookie, kept for the next load (a consent
 *     decision survives a reload; `preview-cookie-jar.ts`).
 *   - parent → iframe: `caelo:page-paths` (#918) — the site's pages, for
 *     link-target suggestions.
 *   - parent → iframe: `caelo:reload` to refetch the iframe's source
 *     after a tool result lands a new branch snapshot.
 *
 * Issue #946 — isolation. The preview runs the site's (untrusted) module
 * scripts, so it is sandboxed WITHOUT `allow-same-origin`: its origin is
 * opaque, it cannot touch the editor's DOM or the operator's session, and
 * this protocol is the ONLY way the two sides talk.
 *
 *   - Preview → editor: every message carries the editor's random per-mount
 *     `channel`, which only the iframe URL holds. The editor accepts a
 *     message only when it comes from the preview window, from an opaque
 *     origin (`"null"`), on its channel, and parses against the schemas
 *     below. An external page the preview navigated to IS the iframe's
 *     window and IS opaque too (the sandbox follows the frame) — only the
 *     channel tells it apart. So the channel must never reach another
 *     document: the preview response sends no Referer, and the editor never
 *     puts it in a message.
 *   - Editor → preview: the editor must address the opaque preview with
 *     target `"*"`, so whatever document the frame holds receives it — the
 *     messages carry nothing secret. The preview trusts one only when its
 *     source is its parent window and its origin is the editor's.
 *
 * The site's own scripts share the preview document and so can read the
 * channel and post these messages too. That is inherent and bounded: a
 * reference chip is not an instruction, and in-place edits are ordinary
 * branch writes the operator sees and can undo.
 */

import { LIST_ITEM_ATTR_RE } from "@caelo-cms/shared";
import { z } from "zod";
import { previewCookieJarSchema } from "./preview-cookie-jar.js";

/** A fresh channel id (a v4 UUID — the runtime accepts `/^[0-9a-f-]{36}$/`) for one editor mount. */
export function newPreviewChannel(): string {
  return crypto.randomUUID();
}

const readySchema = z.object({ kind: z.literal("caelo:ready") });

const navigatedSchema = z.object({
  kind: z.literal("caelo:navigated"),
  pageId: z.string().min(1).max(100),
  slug: z.string().max(2000),
  /** The page's composed URL path — what the URL bar shows (a nested
   *  page's address is its parent chain + slug, not "/<slug>"). */
  path: z.string().max(2000),
});

// Bounds match `chatChipSchema` (the iframe clips to `REFERENCE_LIMITS`).
const elementReferencedSchema = z.object({
  kind: z.literal("caelo:element-referenced"),
  moduleId: z.string().min(1).max(100),
  /** Element path from the module root, e.g. `section.hero > h1`. */
  selector: z.string().max(500),
  label: z.string().min(1).max(200),
  /** The text the operator had selected, when the reference came from a selection. */
  selectedText: z.string().min(1).max(2000).optional(),
  /** Text of the block the reference sits in (paragraph, heading, list item, …). */
  context: z.string().min(1).max(500).optional(),
  /** #917 — the marked placement field the reference sits in, when there is one. */
  blockName: z.string().min(1).max(80).optional(),
  position: z.number().int().nonnegative().optional(),
  field: z.string().min(1).max(200).optional(),
  /** Entry id and entry field of a local `list` field (epic #1107). */
  item: z.string().uuid().optional(),
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
  /**
   * Epic #1107 — `data-caelo-list-item` of the list entry the element sits
   * in, so the chip names the entry (shared list or a module's own list).
   */
  listItem: z.string().max(200).regex(LIST_ITEM_ATTR_RE).optional(),
  /** Ask AI: the parent focuses the chat composer for the operator's instruction. */
  ask: z.literal(true).optional(),
});

/** One changed value of a placement, as `page_module_content.patch_fields` takes it. */
const fieldEditSchema = z.object({
  field: z.string().min(1).max(200),
  /** Entry id and entry field of a local `list` field (epic #1107). */
  item: z.string().uuid().optional(),
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
  /** `href`: the target of a link value instead of its text. */
  part: z.literal("href").optional(),
  text: z.string().max(100_000),
});

const scopeSchema = z.enum(["everywhere", "here"]).optional();

/** #917 / #918 — the operator changed marked values of one placement in place. */
const fieldEditMessageSchema = z.object({
  kind: z.literal("caelo:field-edit"),
  pageId: z.string().min(1).max(100),
  blockName: z.string().min(1).max(80),
  position: z.number().int().nonnegative(),
  edits: z.array(fieldEditSchema).min(1).max(200),
  /** Shared content: change it on every page, or detach and change it only here. */
  scope: scopeSchema,
});

/**
 * #918 — "Replace image…": the iframe cannot show the media library, so
 * the editor opens its picker and saves the picked image into `src` (and
 * its alt text into `alt`, when that is a marked field too). The edits'
 * `text` is empty here; the editor fills it from the pick.
 */
const imageReplaceMessageSchema = z.object({
  kind: z.literal("caelo:image-replace"),
  pageId: z.string().min(1).max(100),
  blockName: z.string().min(1).max(80),
  position: z.number().int().nonnegative(),
  src: fieldEditSchema,
  alt: fieldEditSchema.optional(),
  scope: scopeSchema,
});

/**
 * #946 — the preview asks the editor to navigate it (a link click, or the
 * answer to `caelo:reload`). In the opaque-origin sandbox the iframe's OWN
 * navigations carry no session cookie, so only the editor can load another
 * preview page into it; see `previewNavigationTarget` for what it accepts.
 */
const navigateSchema = z.object({
  kind: z.literal("caelo:navigate"),
  /** Path + query + hash on the admin origin, e.g. `/edit/preview-by-path/about?branch=…`. */
  href: z.string().min(1).max(4000),
});

/**
 * The preview's cookie jar after the page set or deleted a cookie; the
 * editor keeps it for the next load (`preview-cookie-jar.ts`).
 */
const cookiesSchema = z.object({
  kind: z.literal("caelo:cookies"),
  cookies: previewCookieJarSchema,
});

/** Every message the preview may send the editor. Unknown keys are stripped. */
export const iframeToParentSchema = z.discriminatedUnion("kind", [
  readySchema,
  navigatedSchema,
  navigateSchema,
  elementReferencedSchema,
  fieldEditMessageSchema,
  imageReplaceMessageSchema,
  cookiesSchema,
]);

export type FieldEdit = z.infer<typeof fieldEditSchema>;
export type FieldEditMessage = z.infer<typeof fieldEditMessageSchema>;
export type ImageReplaceMessage = z.infer<typeof imageReplaceMessageSchema>;
export type IframeToParent = z.infer<typeof iframeToParentSchema>;

/** #918 — the site's pages, for link-target suggestions in the link editor. */
export interface PagePathsMessage {
  kind: "caelo:page-paths";
  pages: { path: string; title: string }[];
}

export interface ReloadMessage {
  kind: "caelo:reload";
}

export type ParentToIframe = ReloadMessage | PagePathsMessage;

/**
 * The Caelo message a `message` event carries when it comes from the
 * live-edit preview on this editor's channel, else null (see the file
 * comment for why each check is needed). The returned message never
 * includes the channel or any key the schema does not name.
 *
 * @param preview - the preview iframe's `contentWindow`.
 * @param channel - the channel this editor put in the iframe URL.
 */
export function previewMessage(
  ev: Pick<MessageEvent, "source" | "origin" | "data">,
  preview: Window | null | undefined,
  channel: string,
): IframeToParent | null {
  if (!preview || ev.source !== preview) return null;
  // The sandboxed preview has an opaque origin. Anything else — the admin
  // origin included — is not the sandboxed preview.
  if (ev.origin !== "null") return null;
  const data = ev.data as { channel?: unknown } | null;
  if (!data || typeof data !== "object" || data.channel !== channel) return null;
  const parsed = iframeToParentSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * Send a message to the preview. The target origin has to be `"*"`: an
 * opaque origin cannot be named, so the frame's document — whichever it
 * is — receives it. Nothing sent here is secret, and the channel is never
 * included (it is what proves the preview's own messages).
 */
export function postToPreview(preview: Window | null | undefined, msg: ParentToIframe): void {
  preview?.postMessage(msg, "*");
}

const PREVIEW_PATH_PREFIXES = ["/edit/preview-by-path/", "/edit/preview/"];

/**
 * The URL the editor loads into its preview for a `caelo:navigate`
 * request, or null when the request is not a preview page. The request
 * comes from the preview document — which runs the site's untrusted
 * scripts — so it may only move the iframe to another preview page of this
 * admin: same origin, a preview path, and the editor's OWN channel (any
 * channel in the request is replaced).
 *
 * @param href - the requested path (+ query + hash).
 * @param channel - this editor's channel.
 * @param editorOrigin - `window.location.origin`.
 */
export function previewNavigationTarget(
  href: string,
  channel: string,
  editorOrigin: string,
): string | null {
  // A relative reference only: "//host/…" or "https://…" would leave the origin.
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(href, editorOrigin);
  } catch {
    return null;
  }
  if (url.origin !== editorOrigin) return null;
  const path = url.pathname === "/edit/preview-by-path" ? `${url.pathname}/` : url.pathname;
  if (!PREVIEW_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;
  url.searchParams.set("channel", channel);
  return url.pathname + url.search + url.hash;
}

/**
 * Whether two preview URLs show the same page of the same branch. The
 * editor's own `previewSrc` follows the page the preview reports after a
 * `caelo:navigate`; that URL has no fragment, scroll position or extra query
 * of the link the operator followed, and must not reload the page at the top
 * (PR #957 review). The path (trailing slash aside) and `branch`/`exclude`
 * decide; everything else is presentation.
 */
export function samePreviewDocument(a: string | null, b: string, editorOrigin: string): boolean {
  if (a === null) return false;
  try {
    const ua = new URL(a, editorOrigin);
    const ub = new URL(b, editorOrigin);
    const path = (u: URL) => u.pathname.replace(/\/+$/, "");
    return (
      path(ua) === path(ub) &&
      ua.searchParams.get("branch") === ub.searchParams.get("branch") &&
      ua.searchParams.get("exclude") === ub.searchParams.get("exclude")
    );
  } catch {
    return false;
  }
}

/**
 * The URL of a sandboxed preview document with the editor's channel (and
 * the chat branch, when there is one) attached.
 *
 * @param path - the page's composed path (`/` for the root page).
 */
export function previewUrl(
  path: string,
  opts: { channel: string; branch?: string; exclude?: readonly string[] },
): string {
  const params = new URLSearchParams();
  if (opts.branch) params.set("branch", opts.branch);
  if (opts.exclude && opts.exclude.length > 0) params.set("exclude", opts.exclude.join(","));
  params.set("channel", opts.channel);
  return `/edit/preview-by-path${path === "/" ? "" : path}?${params.toString()}`;
}
