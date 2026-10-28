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
  if (!html) return html;
  const firstOpen = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/;
  const m = firstOpen.exec(html);
  if (!m) return html;
  const tagAttrs = m[2] ?? "";
  if (/\sdata-caelo-module-id\s*=/.test(tagAttrs)) return html;
  const selfClosing = /\s*\/\s*$/.exec(tagAttrs);
  const attrs = selfClosing ? tagAttrs.slice(0, selfClosing.index) : tagAttrs;
  const close = selfClosing ? "/>" : ">";
  const replaced = `<${m[1]}${attrs} ${MODULE_ID_ATTRIBUTE}="${moduleId}"${close}`;
  return html.slice(0, m.index) + replaced + html.slice(m.index + m[0].length);
}
