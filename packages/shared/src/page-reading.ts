// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 (docs/dev/external-plugin-brokers.md §4.5) — how a page's frame and
 * modules read around each other, for the plugin values inside them.
 *
 * A module's values are checked against its own template read as a
 * `<body>`'s content (`template-contexts.ts`). That holds on the page only
 * where the module stands in plain HTML element content, and only while
 * nothing before it left raw text, SVG, MathML or a `<select>` open. So:
 *
 * - a module in a `<caelo-slot>` of the layout or template that stands
 *   anywhere else (inside `<noscript>`, `<svg>`, `<math>`, a `<select>`, or
 *   where the browser does not read the slot as an element at all) renders
 *   with every plugin value in it refused;
 * - when any module on the page (a nested one included), or the template
 *   that frames the page, does not end in plain HTML content, every plugin
 *   value on the page is refused: what follows it reads otherwise, and the
 *   order of the page's parts is not tracked here, so all of them.
 *
 * Both checks are about plugins' values only: a core value renders as it
 * always has, so a page without plugin values renders exactly as before.
 * The refusals are render failures (listed in the preview, recorded by a
 * Stage, blocking Publish live), so the module that ends outside content
 * gets fixed rather than silently tolerated.
 */

import {
  type DefaultTreeAdapterTypes,
  defaultTreeAdapter,
  html as H,
  parse,
  parseFragment,
} from "parse5";
import { listSlotNames } from "./preview-scanner.js";
import { placeholderContexts } from "./template-contexts.js";

/** The rule a plugin value is refused with when its module is placed outside plain content. */
export const SLOT_PLACEMENT_RULE = "context-slot-placement";
/** The rule every plugin value of a page is refused with when part of the page ends outside content. */
export const OPEN_MARKUP_RULE = "context-open-markup";

/** How a layout's or template's slots stand, and how it ends. */
export interface FrameReading {
  /** Names of slots that do not stand in plain HTML element content. */
  readonly slotsOutside: ReadonlySet<string>;
  /** The frame's markup ends in plain HTML content. */
  readonly endsInContent: boolean;
}

const FRAME_CACHE_SIZE = 256;
const frames = new Map<string, FrameReading>();

/** How `html`'s slots stand and whether it ends in content, worked out once per frame text. */
export function frameReading(html: string): FrameReading {
  const hit = frames.get(html);
  if (hit) {
    frames.delete(html);
    frames.set(html, hit);
    return hit;
  }
  const read: FrameReading = {
    slotsOutside: slotsOutside(html),
    endsInContent: templateEndsInContent(html),
  };
  frames.set(html, read);
  if (frames.size > FRAME_CACHE_SIZE) {
    const oldest = frames.keys().next().value;
    if (oldest !== undefined) frames.delete(oldest);
  }
  return read;
}

/** Whether a module's or frame's template ends in plain HTML content (`template-contexts.ts`). */
export function templateEndsInContent(html: string): boolean {
  return placeholderContexts(html).endsInContent;
}

/**
 * The slots the page fills (`applySlotReplacements` finds them) that a
 * browser does not read as an element in plain HTML content: inside SVG,
 * MathML or a `<select>`, or not as an element at all (inside `<noscript>`,
 * a comment, a `<textarea>`).
 */
function slotsOutside(html: string): Set<string> {
  const filled = listSlotNames(html);
  if (filled.length === 0) return new Set();
  const document = /<(?:html|head|body)[\s>]/i.test(html);
  const root: DefaultTreeAdapterTypes.ParentNode = document
    ? parse(html, { scriptingEnabled: true })
    : parseFragment(defaultTreeAdapter.createElement("body", H.NS.HTML, []), html, {
        scriptingEnabled: true,
      });
  const inContent = new Set<string>();
  const outside = new Set<string>();
  type Frame = { readonly node: DefaultTreeAdapterTypes.ParentNode; readonly plain: boolean };
  const stack: Frame[] = [{ node: root, plain: true }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { node, plain } = frame;
    const children =
      "content" in node && node.content
        ? (node.content as DefaultTreeAdapterTypes.DocumentFragment).childNodes
        : node.childNodes;
    for (const child of children) {
      if (!("tagName" in child)) continue;
      const element = child as DefaultTreeAdapterTypes.Element;
      const html5 = element.namespaceURI === H.NS.HTML;
      if (html5 && element.tagName === "caelo-slot") {
        const name = element.attrs.find((a) => a.name === "name")?.value ?? "";
        (plain ? inContent : outside).add(name);
      }
      stack.push({ node: element, plain: plain && html5 && element.tagName !== "select" });
    }
  }
  return new Set(filled.filter((name) => outside.has(name) || !inContent.has(name)));
}

/**
 * Where a page's frame (its layout and template) puts the modules, for
 * their plugins' values.
 */
export interface PageFrame {
  /**
   * The template ends outside plain content inside the layout, so the
   * layout's later parts read otherwise: every plugin value on the page is
   * refused.
   */
  readonly open: boolean;
  /**
   * The rule a module in `block` (a template block, or a layout block when
   * `inLayout`) refuses its plugin values with, or undefined. `open`: a
   * part of the page ends outside content, so every module refuses them.
   */
  refusalFor(block: string, inLayout: boolean, open: boolean): string | undefined;
}

/** How the page's layout (when it has one) and template place its modules. */
export function pageFrame(input: {
  readonly templateHtml: string;
  readonly layoutHtml?: string;
}): PageFrame {
  const template = frameReading(input.templateHtml);
  const layout = input.layoutHtml !== undefined ? frameReading(input.layoutHtml) : null;
  const contentOutside = layout?.slotsOutside.has("content") ?? false;
  const frameOpen = layout !== null && !template.endsInContent;
  return {
    open: frameOpen,
    refusalFor(block, inLayout, open) {
      if (open || frameOpen) return OPEN_MARKUP_RULE;
      const outside = inLayout
        ? (layout?.slotsOutside.has(block) ?? false)
        : contentOutside || template.slotsOutside.has(block);
      return outside ? SLOT_PLACEMENT_RULE : undefined;
    },
  };
}

/** How much of the markup {@link markupLeavingContent} shows. */
const EXCERPT_LENGTH = 80;

/**
 * #1787 — the markup that keeps a module's or frame's template from ending
 * in plain HTML content, as an excerpt the AI can find and rewrite (`…`
 * marks text cut off), or null when it ends in content: from the first
 * section, partial or value that can change how what follows reads, or the
 * template's end when that is left open (`<textarea>`, `<svg>`, a comment).
 */
export function markupLeavingContent(html: string): string | null {
  const at = placeholderContexts(html).endsOutsideFrom;
  if (at === null) return null;
  if (at >= html.length) {
    const from = Math.max(0, html.length - EXCERPT_LENGTH);
    return `${from > 0 ? "…" : ""}${html.slice(from)}`;
  }
  const end = Math.min(html.length, at + EXCERPT_LENGTH);
  return `${html.slice(at, end)}${end < html.length ? "…" : ""}`;
}

/**
 * Whether one of the templates a page's render used ends outside plain
 * content. The caller passes what the renderer itself rendered: each
 * placed module's template and the template of every module the render
 * embedded at any depth, whatever carried the reference (a `module` field,
 * a module list, a shared or local list entry, a plugin list source, a
 * content variant), as the renderer reports them. When one does, the
 * page is rendered again with every plugin value refused
 * ({@link OPEN_MARKUP_RULE}).
 */
export function anyEndsOutsideContent(templates: Iterable<string>): boolean {
  for (const html of templates) if (!templateEndsInContent(html)) return true;
  return false;
}
