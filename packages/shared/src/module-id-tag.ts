// SPDX-License-Identifier: MPL-2.0

/**
 * The `data-caelo-module-id` stamp on a module's root element. Every
 * module root carries it, page placements (the composer) and nested
 * modules in `module` / `module-list` fields (nested-module-render.ts)
 * alike, so anything reading rendered HTML — the live-edit overlay, the
 * core `structure` and `links` quality checks — can tell which module
 * rendered which element without another mapping (#1027).
 *
 * Its own file because both the composer and the nested renderer use
 * it, and the composer already imports the nested renderer.
 */

import { Parser } from "htmlparser2";

/** The attribute every module root carries. */
export const MODULE_ID_ATTRIBUTE = "data-caelo-module-id";

/**
 * Insert `data-caelo-module-id="<id>"` into the first opening tag of
 * the module's HTML. Idempotent — an already-tagged first element keeps
 * its id, so a nested module that renders as its parent's first element
 * stays attributed to itself. Comments / DOCTYPE / leading whitespace
 * before the first tag are tolerated. HTML without an opening tag (pure
 * text, a failure comment) returns unchanged because there's nothing to
 * attach to. A self-closing root (`<line … />`, common for SVG parts)
 * gets the attribute before its `/` (#1099) — after it, the tag would no
 * longer self-close and swallow every following sibling.
 *
 * @example tagModuleId("<p>hi</p>", "abc") // '<p data-caelo-module-id="abc">hi</p>'
 * @example tagModuleId('<line x1="0"/>', "abc") // '<line x1="0" data-caelo-module-id="abc"/>'
 */
export function tagModuleId(html: string, moduleId: string): string {
  return tagRoot(html, MODULE_ID_ATTRIBUTE, moduleId);
}

/**
 * Epic #1644 — the content instance a placement shows, on its root next to
 * the module id, for page-output observers only: two placements of one
 * design with different content are two blocks to an index. The generator
 * stamps it when an observer reads the page and strips it
 * ({@link stripContentInstances}) before the file is written, so the
 * published HTML never carries it.
 */
export const CONTENT_INSTANCE_ATTRIBUTE = "data-caelo-content-instance";

/** {@link CONTENT_INSTANCE_ATTRIBUTE} on the module's root (idempotent, like {@link tagModuleId}). */
export function tagContentInstance(html: string, contentInstanceId: string): string {
  return tagRoot(html, CONTENT_INSTANCE_ATTRIBUTE, contentInstanceId);
}

const STAMP = new RegExp(` ${CONTENT_INSTANCE_ATTRIBUTE}="[0-9a-f-]{36}"`, "g");

/** The HTML without the observers' content-instance stamps (a fixed-width pattern: linear). */
export function stripContentInstances(html: string): string {
  return html.includes(CONTENT_INSTANCE_ATTRIBUTE) ? html.replace(STAMP, "") : html;
}

/** Elements Google reads `data-nosnippet` on. */
const NOSNIPPET_ROOTS = new Set(["div", "section", "span"]);

/** The one element that encloses a whole fragment, and where its opening tag is. */
interface SoleRoot {
  readonly tag: string;
  /** Index of the opening tag's `<`. */
  readonly start: number;
  /** Index of the opening tag's `>`. */
  readonly end: number;
}

/**
 * How a fragment's top level reads: its one enclosing element, or null when
 * it has several top-level elements, text outside its element, or none
 * (comments and whitespace aside); and whether it shows any text at all.
 * Parsed, so markup inside a comment is never taken for an element.
 */
function readTopLevel(html: string): { root: SoleRoot | null; empty: boolean } {
  let depth = 0;
  let roots = 0;
  let root: SoleRoot | null = null;
  let looseText = false;
  const parser = new Parser({
    onopentag(name) {
      if (depth === 0) {
        roots += 1;
        root = { tag: name, start: parser.startIndex, end: parser.endIndex };
      }
      depth += 1;
    },
    onclosetag() {
      depth = Math.max(0, depth - 1);
    },
    ontext(text) {
      if (depth === 0 && text.trim().length > 0) looseText = true;
    },
  });
  parser.write(html);
  parser.end();
  return { root: roots === 1 && !looseText ? root : null, empty: roots === 0 && !looseText };
}

/**
 * #1752 — keep a placement's content out of search snippets (and the AI
 * answers built from them): `data-nosnippet` on its root when one `div`,
 * `section` or `span` encloses the whole placement, the only elements search
 * engines read it on; anything else (another root element, several
 * top-level elements, text) is wrapped in a `<div data-nosnippet>`, so the
 * whole placement is covered. A placement that shows nothing is left as it
 * is. Idempotent.
 *
 * @example markNosnippet("<section>x</section>") // '<section data-nosnippet="">x</section>'
 * @example markNosnippet("<article>x</article>") // '<div data-nosnippet=""><article>x</article></div>'
 */
export function markNosnippet(html: string): string {
  const { root, empty } = readTopLevel(html);
  if (empty) return html;
  if (root !== null && NOSNIPPET_ROOTS.has(root.tag.toLowerCase())) {
    const openTag = html.slice(root.start, root.end + 1);
    // A supported root that already carries it (this wrapper, say) is done.
    if (/\sdata-nosnippet\b/.test(openTag)) return html;
    return (
      html.slice(0, root.start) + tagRoot(openTag, "data-nosnippet", "") + html.slice(root.end + 1)
    );
  }
  return `<div data-nosnippet="">${html}</div>`;
}

/** `name="value"` on the first opening tag of `html`, unless that tag has `name` already. */
function tagRoot(html: string, name: string, value: string): string {
  if (!html) return html;
  const firstOpen = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/;
  const m = firstOpen.exec(html);
  if (!m) return html;
  const tagAttrs = m[2] ?? "";
  if (new RegExp(`\\s${name}\\s*=`).test(tagAttrs)) return html;
  // String ops, not a `\s*\/\s*$` regex: that backtracks polynomially on
  // long whitespace runs (CodeQL js/polynomial-redos).
  const trimmed = tagAttrs.trimEnd();
  const selfClosing = trimmed.endsWith("/");
  const attrs = selfClosing ? trimmed.slice(0, -1).trimEnd() : tagAttrs;
  const close = selfClosing ? "/>" : ">";
  const replaced = `<${m[1]}${attrs} ${name}="${value}"${close}`;
  return html.slice(0, m.index) + replaced + html.slice(m.index + m[0].length);
}
