// SPDX-License-Identifier: MPL-2.0

/**
 * #917 — field markers for the Live Edit preview. They let the preview
 * iframe tell which placement + field a piece of visible text came from,
 * so the operator can edit that text in place.
 *
 * Two steps around the normal module render:
 *
 *   1. {@link wrapEditableValues} wraps every plain-text value of a
 *      placement's content instance in private-use sentinels that carry
 *      the field path. The template engine substitutes the wrapped value
 *      like any other string (its escape is the identity), so the
 *      sentinels land wherever the module author put `{{field}}`.
 *   2. {@link finalizeEditMarkers} scans the rendered HTML. A sentinel in
 *      text content becomes a pair of HTML comments around the value:
 *      `<!--caelo:f p=<placement> s=<0|1> f=<path>-->value<!--/caelo:f-->`.
 *      Comments do not affect layout or CSS selectors. A sentinel in a
 *      tag (an attribute), a comment, or a raw-text element (`<script>`,
 *      `<style>`, `<title>`, `<textarea>`) is removed and the value stays
 *      as it was, so attributes and scripts render byte-identical.
 *
 * Only the editor preview runs this. Published output never carries
 * markers: the static generator and every other caller of
 * `pages.render_preview` leave `editMarkers` off.
 *
 * Only values without `<` are wrapped: a value that carries markup cannot
 * be edited as plain text without destroying that markup.
 */

const START = "\uE000";
const SEP = "\uE001";
const END = "\uE002";
const SENTINELS = /[\uE000-\uE002]/g;

/** Comment prefix of an opening marker; the closing marker is `/caelo:f`. */
export const EDIT_MARKER_PREFIX = "caelo:f";

/** Field kinds whose text can be edited in place (`link-list`: each label). */
const EDITABLE_KINDS = new Set(["text", "text-list", "link-list"]);

/** Field shape {@link wrapEditableValues} needs: name + kind. */
export interface EditableFieldDef {
  readonly name: string;
  readonly kind?: string;
}

function editable(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("<");
}

function wrap(path: string, value: string): string {
  return `${START}${path}${SEP}${value.replace(SENTINELS, "")}${END}`;
}

/**
 * Wrap the editable text of a content instance's values in sentinels.
 * Returns a new object; non-editable values pass through untouched.
 *
 * Paths: `<field>` for a `text` field, `<field>.<i>` for a `text-list`
 * item, `<field>.<i>.label` for a `link-list` item's label.
 *
 * @example
 * wrapEditableValues({ hero_title: "Hi" }, [{ name: "hero_title", kind: "text" }]);
 * // → { hero_title: "\uE000hero_title\uE001Hi\uE002" }
 */
export function wrapEditableValues(
  values: Readonly<Record<string, unknown>>,
  fields: readonly EditableFieldDef[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  for (const f of fields) {
    const kind = f.kind ?? "text";
    if (!EDITABLE_KINDS.has(kind)) continue;
    const v = values[f.name];
    if (kind === "text") {
      if (editable(v)) out[f.name] = wrap(f.name, v);
    } else if (kind === "text-list" && Array.isArray(v)) {
      out[f.name] = v.map((item, i) => (editable(item) ? wrap(`${f.name}.${i}`, item) : item));
    } else if (kind === "link-list" && Array.isArray(v)) {
      out[f.name] = v.map((item, i) => {
        const label = (item as { label?: unknown } | null)?.label;
        return editable(label) ? { ...item, label: wrap(`${f.name}.${i}.label`, label) } : item;
      });
    }
  }
  return out;
}

/** Comment-safe encoding: no `--`, no `>`, no whitespace. */
function attr(value: string): string {
  return encodeURIComponent(value).replace(/-/g, "%2D");
}

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "title", "textarea"]);

/** End index (exclusive) of the tag starting at `i`, honouring quoted attribute values. */
function tagEnd(html: string, i: number): number {
  let quote: string | null = null;
  for (let j = i + 1; j < html.length; j += 1) {
    const c = html[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return j + 1;
    }
  }
  return html.length;
}

/**
 * Turn sentinels in rendered module HTML into marker comments (text
 * content) or drop them (everywhere else). See the file header.
 *
 * @param placement The placement key, `<blockName>#<position>`.
 * @param synced Whether the placement is bound to a synced (shared) instance.
 */
export function finalizeEditMarkers(html: string, placement: string, synced: boolean): string {
  if (!html.includes(START)) return html;
  const open = (path: string) =>
    `<!--${EDIT_MARKER_PREFIX} p=${attr(placement)} s=${synced ? 1 : 0} f=${attr(path)}-->`;
  const close = `<!--/${EDIT_MARKER_PREFIX}-->`;
  let out = "";
  let i = 0;
  while (i < html.length) {
    const c = html[i];
    if (c === "<" && html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      const stop = end === -1 ? html.length : end + 3;
      out += stripSentinels(html.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "<" && /[a-zA-Z/!?]/.test(html[i + 1] ?? "")) {
      const stop = tagEnd(html, i);
      const tag = html.slice(i, stop);
      out += stripSentinels(tag);
      i = stop;
      const name = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1]?.toLowerCase();
      if (name && RAW_TEXT_ELEMENTS.has(name) && !tag.endsWith("/>")) {
        const closeAt = html.toLowerCase().indexOf(`</${name}`, i);
        const rawStop = closeAt === -1 ? html.length : closeAt;
        out += stripSentinels(html.slice(i, rawStop));
        i = rawStop;
      }
      continue;
    }
    if (c === START) {
      const sep = html.indexOf(SEP, i);
      const end = html.indexOf(END, i);
      if (sep !== -1 && end !== -1 && sep < end) {
        out += `${open(html.slice(i + 1, sep))}${html.slice(sep + 1, end)}${close}`;
        i = end + 1;
        continue;
      }
    }
    if (c !== SEP && c !== END && c !== START) out += c;
    i += 1;
  }
  return out;
}

/** Drop sentinels and the path they carry, keeping the wrapped value. */
function stripSentinels(s: string): string {
  return s.replace(/\uE000[^\uE001]*\uE001/g, "").replace(SENTINELS, "");
}

/** A parsed opening marker. */
export interface EditMarker {
  readonly blockName: string;
  readonly position: number;
  readonly synced: boolean;
  readonly field: string;
  readonly index?: number;
}

/**
 * Parse an opening marker's comment text (without `<!--`/`-->`), or null.
 * Mirrors what the preview runtime does in the browser.
 */
export function parseEditMarker(comment: string): EditMarker | null {
  const m = /^caelo:f p=(\S+) s=([01]) f=(\S+)$/.exec(comment.trim());
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const placement = decodeURIComponent(m[1]);
  const hash = placement.lastIndexOf("#");
  const position = Number(placement.slice(hash + 1));
  if (hash <= 0 || !Number.isInteger(position)) return null;
  const [field, index] = decodeURIComponent(m[3]).split(".");
  if (!field) return null;
  return {
    blockName: placement.slice(0, hash),
    position,
    synced: m[2] === "1",
    field,
    ...(index !== undefined ? { index: Number(index) } : {}),
  };
}
