// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1717 — what `{{page.*}}` can answer, and the markers of a tag or
 * section it cannot (`docs/lists.md` §8).
 *
 * The page object's keys are a fixed set, and each value answers a fixed
 * set of paths, so a name outside them is a broken placeholder, never
 * copy. Unlike `field-not-declared` (a module-level `{{name}}` that can be
 * literal text), these markers block Publish live: the preview lists them,
 * a Stage ships the spot raw and records it, the audit files
 * `render/page-key-unknown` / `render/page-path-unknown`, and Publish live
 * and every other build refuse it (#1604).
 *
 * - `page-key-unknown:<key>` — `{{page.<key>}}` where `<key>` is none of
 *   {@link PAGE_KEY_TYPES} (`{{page.titel}}`).
 * - `page-path-unknown:<path>:<type>` — `{{page.<path>.…}}` where the value
 *   at `<path>` cannot answer the rest (`{{page.props.stand.formatted}}` on
 *   a `text` property is `page-path-unknown:props.stand:text`), or cannot
 *   render as a tag (`{{page.props}}`, `{{page.terms.tags}}`). `<type>` is
 *   what the value is: a page key's type from {@link PAGE_KEY_TYPES}, a
 *   property's declared type (`link|text` when page types disagree), or
 *   the kind of a value deeper down.
 *
 * A property no page type declares stays `page-prop-unknown` (#1561,
 * `page-props.ts`).
 */

/** Marker kind of a `{{page.<key>}}` the page object has no key for. */
export const PAGE_KEY_UNKNOWN = "page-key-unknown";

/** Marker kind of a `{{page.<path>.…}}` the value at `<path>` cannot answer. */
export const PAGE_PATH_UNKNOWN = "page-path-unknown";

/**
 * Every key of `{{page.*}}` and what its value is (`lists/resolve.ts`
 * `pageValue`): `text` and `boolean` have no paths, `link`, `media` and
 * `date` the ones {@link PAGE_VALUE_PATHS} names, `props` and `terms` are
 * keyed by property name and vocabulary slug.
 */
export const PAGE_KEY_TYPES: Readonly<Record<string, string>> = {
  id: "text",
  title: "text",
  short_title: "text",
  link: "link",
  published_at: "date",
  updated_at: "date",
  summary: "text",
  image: "media",
  page_type: "text",
  props: "props",
  terms: "terms",
  is_current: "boolean",
  is_ancestor: "boolean",
};

/** The dot paths a value of each field type answers; a type not listed answers none. */
export const PAGE_VALUE_PATHS: Readonly<Record<string, readonly string[]>> = {
  link: ["href", "target", "title"],
  media: ["url", "alt", "width", "height"],
  date: ["formatted"],
};

/** The marker of `{{page.<key>}}` when the page object has no `<key>`. */
export function pageKeyUnknownMarker(key: string): string {
  return `${PAGE_KEY_UNKNOWN}:${key}`;
}

/** The marker of a path below `page.<path>` that its value (a `<type>`) cannot answer. */
export function pagePathUnknownMarker(path: string, type: string): string {
  return `${PAGE_PATH_UNKNOWN}:${path}:${type}`;
}

/** `<path>` and `<type>` of a {@link pagePathUnknownMarker} body (what follows the kind). */
export function parsePagePathUnknown(body: string): { path: string; type: string } {
  const at = body.lastIndexOf(":");
  return at < 0 ? { path: body, type: "" } : { path: body.slice(0, at), type: body.slice(at + 1) };
}
