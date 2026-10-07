// SPDX-License-Identifier: MPL-2.0

/**
 * Pure URL-shape rules of the `international-site` plugin: the
 * `path-prefix` encode/decode pair the #390 composition point calls.
 * Kept free of I/O and module state so every rule is unit-testable.
 *
 * The default behaviour serves the default locale BARE (`/pricing`,
 * `/en/pricing`). With the site-wide `prefixDefaultLocale` setting the
 * default locale is prefixed too (`/de/preise`, `/en/pricing`) — except
 * the default-locale HOME, which keeps serving at `/` so the bare domain
 * answers 200 without a redirect hop. `/de` then 301s to `/` (one
 * canonical root); that redirect row is written by `set_locales`.
 */

/** The slice of a registered locale the URL rules read. */
export interface UrlLocale {
  readonly code: string;
  readonly url_strategy: "none" | "subdirectory" | "subdomain" | "domain";
  readonly is_default: boolean;
}

/** Annotation key `url_annotations` sets on default-locale pages while
 *  the `prefixDefaultLocale` setting is on. */
export const PREFIX_DEFAULT_LOCALE_ANNOTATION = "prefixDefaultLocale";

/**
 * Leading path segments for a page. `annotations` come from the
 * plugin's `url_annotations` op; `isHomePage` is core's verdict that the
 * page is the root of its URL space (the designated home, or a locale
 * root the plugin annotated).
 */
export function encodeLocalePrefix(page: {
  readonly isHomePage: boolean;
  readonly annotations: Readonly<Record<string, unknown>>;
}): string[] {
  const { annotations } = page;
  const locale = annotations.locale;
  if (typeof locale !== "string") return [];
  // Only the subdirectory strategy produces a path prefix (subdomain /
  // domain ride the host slot; "none" opts a locale out of URL shaping).
  if (annotations.urlStrategy !== "subdirectory") return [];
  if (annotations.isDefaultLocale !== true) return [locale];
  // Default locale: bare unless the site opted into prefixing it. Its
  // home stays at "/" either way — the whole point of the setting is a
  // root that answers without a redirect.
  if (annotations[PREFIX_DEFAULT_LOCALE_ANNOTATION] !== true) return [];
  return page.isHomePage ? [] : [locale];
}

/**
 * Inverse of {@link encodeLocalePrefix}: does the path's first segment
 * name a subdirectory locale? The default locale only counts while
 * `prefixDefaultLocale` is on — otherwise `/en/x` is an ordinary slug.
 */
export function decodeLocalePrefix(
  segments: ReadonlyArray<string>,
  locales: ReadonlyMap<string, UrlLocale>,
  prefixDefaultLocale: boolean,
): { consumed: number; annotations: { locale: string } } | null {
  const head = segments[0];
  if (head === undefined) return null;
  const locale = locales.get(head);
  if (locale?.url_strategy !== "subdirectory") return null;
  if (locale.is_default && !prefixDefaultLocale) return null;
  return { consumed: 1, annotations: { locale: locale.code } };
}

/**
 * Validate a requested `prefixDefaultLocale` against the locale list it
 * will apply to. Returns an AI-actionable error message, or null when
 * the combination is valid.
 */
export function prefixDefaultLocaleError(
  prefixDefaultLocale: boolean,
  locales: ReadonlyArray<{
    code: string;
    urlStrategy: UrlLocale["url_strategy"];
    isDefault: boolean;
  }>,
): string | null {
  if (!prefixDefaultLocale) return null;
  const def = locales.find((l) => l.isDefault);
  if (!def) return "set_locales: exactly one locale must be isDefault";
  if (def.urlStrategy !== "subdirectory") {
    return (
      `set_locales: prefixDefaultLocale needs the default locale "${def.code}" to use the subdirectory strategy ` +
      `(it uses "${def.urlStrategy}"). Set its urlStrategy to "subdirectory", or pass prefixDefaultLocale: false ` +
      `(omitting it keeps the stored value).`
    );
  }
  return null;
}

/** The redirect that makes `/` the single canonical default-locale
 *  root while `prefixDefaultLocale` is on: `/<code>` → `/`. */
export function defaultLocaleRootRedirect(defaultLocaleCode: string): {
  fromPath: string;
  toPath: string;
  statusCode: 301;
} {
  return { fromPath: `/${defaultLocaleCode}`, toPath: "/", statusCode: 301 };
}
