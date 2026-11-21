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
