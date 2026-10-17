// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #849 — the pure half of the core `links` check: read the URLs a
 * staged page really references, decide which are same-site, and resolve
 * them against the build's pages and the redirect table.
 *
 * Only real attributes count. The page is parsed with htmlparser2 and a
 * URL is taken from the attribute that holds it (`a[href]`, `img[srcset]`,
 * …), never from text: a path printed as copy ("/shop/xyz" inside an alert
 * graphic, #846) is not a link and is never checked.
 *
 * Every URL is resolved the way a browser resolves it — against the page's
 * URL on the staged origin, or its `<base href>`. It is same-site when it
 * is http(s) on one of the site's own hosts (the staged origin, the staging
 * host operators see, the site base URL, the site's public domains);
 * everything else (other hosts, `mailto:`, `tel:`, `data:`, fragment-only
 * `#x`) is out of scope.
 *
 * Paths the static build never contains are excluded: `/api/*` is the
 * public gateway on every provider (LB URL map / Firebase rewrite / Caddy
 * `handle /api/*`, CLAUDE.md §11.B Tier 3) — forms, plugin operations, the
 * captcha. Plugin PAGES are ordinary pages of the build and are checked.
 */

import { Parser } from "htmlparser2";

/** A reference to a page (navigation, canonical, hreflang) or to a file. */
export type LinkKind = "page" | "asset";

/** One URL-carrying attribute of a staged page. */
export interface ExtractedLink {
  /** The attribute value as the page carries it (entities decoded). */
  readonly raw: string;
  /** `a[href]`, `img[srcset]`, … — for messages. */
  readonly where: string;
  readonly kind: LinkKind;
  /** A visitor can follow it (`a`, `area`) — what makes a page reachable. */
  readonly navigational: boolean;
  /** The module root (`data-caelo-module-id`) it sits in, if any. */
  readonly moduleId: string | null;
  /** The plugin output (`data-caelo-plugin`) it sits in, if any. */
  readonly pluginSlug: string | null;
}

export interface ExtractedPage {
  readonly links: readonly ExtractedLink[];
  /** The first `<base href>`, as written. */
  readonly baseHref: string | null;
  /** More URLs than {@link MAX_LINKS_PER_PAGE}; the rest was not read. */
  readonly truncated: boolean;
}

/** Most URLs read from one page. */
export const MAX_LINKS_PER_PAGE = 5_000;

/** `<link rel>` values that reference a PAGE, not a file. */
const PAGE_RELS = new Set(["canonical", "alternate", "prev", "next"]);
/** `<link rel>` values that name an origin, not a resource. */
const ORIGIN_RELS = new Set(["preconnect", "dns-prefetch"]);
/** `<meta>` properties whose `content` is an image URL. */
const IMAGE_META = new Set([
  "og:image",
  "og:image:url",
  "og:image:secure_url",
  "twitter:image",
  "twitter:image:src",
]);

/** Attributes that hold one asset URL, per tag. */
const ASSET_ATTRS: Readonly<Record<string, readonly string[]>> = {
  img: ["src"],
  source: ["src"],
  script: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  embed: ["src"],
  iframe: ["src"],
  object: ["data"],
  input: ["src"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
};

/** Tags whose `srcset` lists image candidates. */
const SRCSET_TAGS = new Set(["img", "source"]);

interface Scope {
  readonly moduleId: string | null;
  readonly pluginSlug: string | null;
}

/**
 * Every URL-carrying attribute of `html`, in document order.
 *
 * @example
 *   extractLinks('<p>/shop/xyz</p><a href="/about">x</a>').links
 *   // → [{ raw: "/about", where: "a[href]", kind: "page", … }] — the text is no link
 */
export function extractLinks(html: string): ExtractedPage {
  const links: ExtractedLink[] = [];
  const stack: Scope[] = [];
  let baseHref: string | null = null;
  let truncated = false;
  const top = (): Scope => stack[stack.length - 1] ?? { moduleId: null, pluginSlug: null };
  const add = (raw: string | undefined, where: string, kind: LinkKind, nav: boolean) => {
    if (raw === undefined) return;
    if (links.length >= MAX_LINKS_PER_PAGE) {
      truncated = true;
      return;
    }
    const scope = top();
    links.push({
      raw,
      where,
      kind,
      navigational: nav,
      moduleId: scope.moduleId,
      pluginSlug: scope.pluginSlug,
    });
  };
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const parent = top();
        const moduleId = attrs["data-caelo-module-id"];
        const pluginSlug = attrs["data-caelo-plugin"];
        // Scopes push BEFORE the element's own attributes are read: a
        // module root's own href belongs to that module.
        stack.push({
          moduleId: moduleId ?? parent.moduleId,
          pluginSlug: pluginSlug ?? parent.pluginSlug,
        });
        if (name === "base") {
          if (baseHref === null && attrs.href !== undefined) baseHref = attrs.href;
          return;
        }
        if (name === "a" || name === "area") {
          add(attrs.href, `${name}[href]`, "page", true);
          return;
        }
        if (name === "link") {
          const rels = (attrs.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
          if (rels.some((r) => ORIGIN_RELS.has(r))) return;
          const kind: LinkKind = rels.some((r) => PAGE_RELS.has(r)) ? "page" : "asset";
          add(attrs.href, `link[rel=${rels.join(" ") || "?"}]`, kind, false);
          return;
        }
        if (name === "meta") {
          const prop = (attrs.property ?? attrs.name ?? "").toLowerCase();
          if (IMAGE_META.has(prop)) add(attrs.content, `meta[${prop}]`, "asset", false);
          return;
        }
        for (const attr of ASSET_ATTRS[name] ?? []) {
          add(attrs[attr], `${name}[${attr}]`, "asset", false);
        }
        if (SRCSET_TAGS.has(name) && attrs.srcset !== undefined) {
          for (const url of srcsetUrls(attrs.srcset)) add(url, `${name}[srcset]`, "asset", false);
        }
      },
      onclosetag() {
        stack.pop();
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return { links, baseHref, truncated };
}

/**
 * The URLs of a `srcset` (HTML's candidate-string grammar: a URL is a run
 * of non-whitespace; trailing commas end the candidate; descriptors follow
 * up to the next top-level comma). A comma INSIDE a URL stays part of it.
 */
export function srcsetUrls(srcset: string): string[] {
  const urls: string[] = [];
  let i = 0;
  const n = srcset.length;
  const isSpace = (c: string | undefined) =>
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  while (i < n) {
    while (i < n && (isSpace(srcset[i]) || srcset[i] === ",")) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSpace(srcset[i])) i++;
    let url = srcset.slice(start, i);
    let ended = false;
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
      ended = true;
    }
    if (url.length > 0) urls.push(url);
    if (ended) continue;
    // Skip the descriptors ("2x", "640w") up to the next comma.
    let depth = 0;
    while (i < n) {
      const c = srcset[i];
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (c === "," && depth === 0) break;
      i++;
    }
  }
  return urls;
}

/** Why a URL is not checked. */
export type SkipReason = "empty" | "fragment" | "scheme" | "external" | "runtime" | "malformed";

/** A URL resolved on the site. */
export interface SameSiteUrl {
  readonly kind: "same-site";
  /** The URL path as a browser would request it (percent-encoded, no query). */
  readonly requestPath: string;
  /** The path to compare with pages and redirects ({@link pathKey}). */
  readonly key: string;
}

/** The hosts that are this site, lower-case `host[:port]` (as `URL.host`). */
export type SiteHosts = ReadonlySet<string>;

/** The path prefix the public API gateway owns on every provider. */
export const GATEWAY_PATH_PREFIX = "/api/";

/** Paths served by the gateway, not the static build. */
export function isRuntimePath(path: string): boolean {
  return path === "/api" || path.startsWith(GATEWAY_PATH_PREFIX);
}

/**
 * Resolve one attribute value the way a browser does, and decide whether
 * the check looks at it.
 *
 * @param raw - the attribute value.
 * @param documentBase - the page URL, or its `<base href>` resolved against it.
 * @param hosts - the site's own hosts.
 */
export function resolveLink(
  raw: string,
  documentBase: string,
  hosts: SiteHosts,
): SameSiteUrl | { readonly kind: "skip"; readonly reason: SkipReason } {
  const value = raw.trim();
  if (value === "") return { kind: "skip", reason: "empty" };
  if (value.startsWith("#")) return { kind: "skip", reason: "fragment" };
  let url: URL;
  try {
    url = new URL(value, documentBase);
  } catch {
    return { kind: "skip", reason: "malformed" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "skip", reason: "scheme" };
  }
  if (!hosts.has(url.host.toLowerCase())) return { kind: "skip", reason: "external" };
  if (isRuntimePath(url.pathname)) return { kind: "skip", reason: "runtime" };
  return { kind: "same-site", requestPath: url.pathname, key: pathKey(url.pathname) };
}

/**
 * The comparable form of a site path: percent-decoded, no trailing slash
 * (except the root), `…/index.html` folded into its directory — the forms
 * one page answers to on every provider (`/about`, `/about/`,
 * `/about/index.html`).
 */
export function pathKey(path: string): string {
  let p: string;
  try {
    p = decodeURIComponent(path);
  } catch {
    p = path;
  }
  if (p.endsWith("/index.html")) p = p.slice(0, -"index.html".length);
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p === "" ? "/" : p;
}

/** The site's own hosts from the origins and domains that serve it. */
export function siteHostsOf(urls: readonly (string | null | undefined)[]): Set<string> {
  const hosts = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      hosts.add(new URL(u.includes("://") ? u : `https://${u}`).host.toLowerCase());
    } catch {
      // A malformed domain row cannot be a link target either.
    }
  }
  return hosts;
}

/** A row of the redirects table. */
export interface RedirectRow {
  readonly fromPath: string;
  readonly toPath: string;
  readonly statusCode: number;
}

/** One hop of a redirect chain. */
export interface RedirectHop {
  readonly from: string;
  readonly to: string;
  readonly status: number;
}

/** Most hops followed before a chain counts as a loop. */
export const MAX_REDIRECT_HOPS = 20;

/** Where a same-site path leads once the redirect table has had its say. */
export type RedirectOutcome =
  | { readonly kind: "none" }
  | {
      readonly kind: "redirect";
      readonly hops: readonly RedirectHop[];
      /** The final target: a same-site key to resolve, or off-site. */
      readonly end:
        | { readonly kind: "same-site"; readonly requestPath: string; readonly key: string }
        | { readonly kind: "off-site" }
        | { readonly kind: "gone" };
    }
  | { readonly kind: "loop"; readonly hops: readonly RedirectHop[] };

/** The redirect table keyed by {@link pathKey} of the from path. */
export function indexRedirects(rows: readonly RedirectRow[]): Map<string, RedirectRow> {
  const byKey = new Map<string, RedirectRow>();
  for (const r of rows) byKey.set(pathKey(r.fromPath), r);
  return byKey;
}

/**
 * Follow the redirect table from `key`. Pages win over redirects (#575: the
 * build never serves a redirect over a live page), so a hop that lands on a
 * page stops there.
 *
 * @param isPage - whether a key is a page of the staged build.
 * @param siteBase - absolute URL to resolve redirect targets against.
 */
export function followRedirects(
  key: string,
  redirects: ReadonlyMap<string, RedirectRow>,
  isPage: (key: string) => boolean,
  siteBase: string,
  hosts: SiteHosts,
): RedirectOutcome {
  if (isPage(key) || !redirects.has(key)) return { kind: "none" };
  const hops: RedirectHop[] = [];
  const seen = new Set<string>();
  let current = key;
  for (;;) {
    const row = redirects.get(current);
    if (!row || isPage(current)) break;
    if (seen.has(current) || hops.length >= MAX_REDIRECT_HOPS) return { kind: "loop", hops };
    seen.add(current);
    if (row.statusCode === 410) {
      return { kind: "redirect", hops, end: { kind: "gone" } };
    }
    hops.push({ from: row.fromPath, to: row.toPath, status: row.statusCode });
    const next = resolveLink(row.toPath, siteBase, hosts);
    if (next.kind === "skip") {
      return { kind: "redirect", hops, end: { kind: "off-site" } };
    }
    current = next.key;
    if (!redirects.has(current) || isPage(current)) {
      return {
        kind: "redirect",
        hops,
        end: { kind: "same-site", requestPath: next.requestPath, key: next.key },
      };
    }
  }
  return { kind: "none" };
}
