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
 * The refusal a page's plugin values get, if any: a part of the page that
 * ends outside content refuses all of them, a slot outside content the
 * ones of the modules it holds.
 */
export interface PagePlacement {
  /** Every plugin value on the page is refused with {@link OPEN_MARKUP_RULE}. */
  readonly refuseAll: boolean;
  /** The rule for a module in `block` (a template block, or a layout block when `inLayout`), or undefined. */
  refusalFor(block: string, inLayout: boolean): string | undefined;
}

/**
 * What the page's frame and its modules' templates say about where the
 * modules' plugin values may stand.
 *
 * @param moduleHtml the html of every module the page places (a template,
 *   or an already rendered module's output), its nested modules' included
 *   when they are known.
 * @param refuseAll set when the caller already knows the page ends outside
 *   content somewhere (a nested module found open after a first render).
 */
export function pagePlacement(input: {
  readonly templateHtml: string;
  readonly layoutHtml?: string;
  readonly moduleHtml: Iterable<string>;
  readonly refuseAll?: boolean;
}): PagePlacement {
  const template = frameReading(input.templateHtml);
  const layout = input.layoutHtml !== undefined ? frameReading(input.layoutHtml) : null;
  let refuseAll = input.refuseAll === true || (layout !== null && !template.endsInContent);
  if (!refuseAll) {
    for (const html of input.moduleHtml) {
      if (!templateEndsInContent(html)) {
        refuseAll = true;
        break;
      }
    }
  }
  const contentOutside = layout?.slotsOutside.has("content") ?? false;
  return {
    refuseAll,
    refusalFor(block, inLayout) {
      if (refuseAll) return OPEN_MARKUP_RULE;
      const outside = inLayout
        ? (layout?.slotsOutside.has(block) ?? false)
        : contentOutside || template.slotsOutside.has(block);
      return outside ? SLOT_PLACEMENT_RULE : undefined;
    },
  };
}
