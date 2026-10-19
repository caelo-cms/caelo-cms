// SPDX-License-Identifier: MPL-2.0

/**
 * Write-time canonicalisation of internal links (epic #724, rollout C):
 * the pure core. Authors — operators and the AI — keep writing `/about`,
 * `https://<own domain>/about#team` or `/_caelo/media/hero`; this turns
 * every such link into its stored reference (`caelo:page/<id>#team`,
 * `caelo:media/<id>`) so renaming or moving the target changes no stored
 * link. External URLs, `mailto:`, `tel:`, fragments, template
 * placeholders and non-page files stay literal.
 *
 * Where a link can live, and what is looked at:
 *
 *   - a WHOLE value that is a URL: `url` / `link` / `image` fields, any
 *     field or object key named `href` / `src` / `url` / `link` or ending
 *     in `_href` / `_url` / `_link` / `_src` (`primary_cta_href`), the
 *     `href` of `link-list` items and structured-set items (any depth);
 *   - HTML anywhere (module HTML, rich text, any string value carrying
 *     markup): `href` (pages and media), `src` / `poster` / `srcset`
 *     (media only — a `src="/x"` that is not media is not a page link).
 *
 * A plain text value is never canonicalised as a whole: "/month" in a
 * price label is text, not a link.
 *
 * Failure policy (CLAUDE.md §2, §11): an internal path that matches no
 * page, a media URL that matches no asset and a reference whose target
 * is gone are collected as {@link LinkCanonicaliseIssue}s; the write op
 * turns them into one AI-actionable error. Two exceptions keep editing
 * possible around content that predates this rule:
 *
 *   - grandfathering: a literal that was ALREADY in the stored value
 *     (pre-#724 content, rollout E migrates it) is left as it is — an
 *     edit must not introduce a broken link, but it need not fix an
 *     unrelated old one. The reference-integrity check (rollout F)
 *     reports those.
 *   - report mode: imports keep unresolved literals and report them
 *     (maintainer decision 3 on #724) instead of failing the import.
 */

import { formatLinkRef, type LinkRef, parseLinkRef } from "./link-refs.js";
import { MEDIA_URL_PREFIX } from "./media.js";

/** What the canonicaliser needs to know about the site. */
export interface LinkTargetLookup {
  /**
   * The page served at `path` (leading slash, no trailing slash except
   * the root "/"), following one redirect hop when the path is an old
   * URL whose redirect lands on a page. Null when no page answers it.
   */
  pageIdForPath(path: string): string | null;
  /** The live media asset with this slug, or null. */
  mediaIdForSlug(slug: string): string | null;
  pageExists(pageId: string): boolean;
  mediaExists(mediaId: string): boolean;
  /** True when `host` (lowercase, may carry a port) is the site's own. */
  isOwnHost(host: string): boolean;
}

/** One link the canonicaliser could not turn into a reference. */
export interface LinkCanonicaliseIssue {
  readonly kind:
    | "unknown-page-path"
    | "unknown-media"
    | "dangling-page-ref"
    | "dangling-media-ref"
    | "unsupported-link-form";
  /** The link exactly as written. */
  readonly value: string;
  /** Where it was found: `values.cta_href`, `html`, `fields.nav.default[2].href`, `items[0].href`. */
  readonly where: string;
}

/** A canonicalisation run over one write. */
export interface LinkCanonicaliseRun {
  readonly lookup: LinkTargetLookup;
  /**
   * `strict` (actor writes): unknown targets are issues the op refuses.
   * `report` (imports): unknown targets stay literal and are reported.
   * Either way they land in {@link issues}.
   */
  readonly mode: "strict" | "report";
  /** Link literals already present in the stored state; see file header. */
  readonly grandfathered: ReadonlySet<string>;
  readonly issues: LinkCanonicaliseIssue[];
}

/** Start a run. */
export function linkCanonicaliseRun(
  lookup: LinkTargetLookup,
  opts: { mode?: "strict" | "report"; grandfathered?: ReadonlySet<string> } = {},
): LinkCanonicaliseRun {
  return {
    lookup,
    mode: opts.mode ?? "strict",
    grandfathered: opts.grandfathered ?? new Set(),
    issues: [],
  };
}

// Same character classes as the reference grammar (link-refs.ts), so a
// canonicalised query / anchor always round-trips through the parser.
const QUERY_OK = /^[A-Za-z0-9_\-.~%=&;+/:@!$()*]{1,512}$/;
const ANCHOR_OK = /^[A-Za-z0-9_\-.~%:]{1,256}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEDIA_SEGMENT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VARIANT_RE = /^[a-z][a-z0-9-]{0,63}$/;
// A last path segment with a file extension names a file, not a page.
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;

/** Key / field names whose whole value is a URL. */
export function isLinkKeyName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "href" ||
    n === "src" ||
    n === "url" ||
    n === "link" ||
    n.endsWith("_href") ||
    n.endsWith("_url") ||
    n.endsWith("_link") ||
    n.endsWith("_src")
  );
}

/** Split `/a/b?q#h` into its parts (no URL parser: it must stay path-shaped). */
function splitPathTail(v: string): { path: string; query: string | null; anchor: string | null } {
  let rest = v;
  let anchor: string | null = null;
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    anchor = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  let query: string | null = null;
  const q = rest.indexOf("?");
  if (q !== -1) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  return { path: rest, query: query === "" ? null : query, anchor: anchor === "" ? null : anchor };
}

/** `/a/b/` → `/a/b`; `/` stays `/`. Linear, no regex backtracking. */
export function normaliseLinkPath(path: string): string {
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === 47) end -= 1;
  return path.slice(0, end) || "/";
}

function issue(
  run: LinkCanonicaliseRun,
  kind: LinkCanonicaliseIssue["kind"],
  value: string,
  where: string,
): void {
  run.issues.push({ kind, value, where });
}

/** Canonicalise a `/_caelo/media/<slug>[/<variant>]` path, or null when it is not one. */
function canonicaliseMediaPath(
  path: string,
  raw: string,
  run: LinkCanonicaliseRun,
  where: string,
): string | null {
  if (!path.startsWith(`${MEDIA_URL_PREFIX}/`)) return null;
  const segs = path.slice(MEDIA_URL_PREFIX.length + 1).split("/");
  const first = segs[0] ?? "";
  const variant = segs[1] ?? null;
  if (segs.length > 2 || !MEDIA_SEGMENT_RE.test(first) || (variant && !VARIANT_RE.test(variant))) {
    return null;
  }
  // Legacy `/_caelo/media/<uuid>/<variant>` names the asset by id.
  const id = UUID_RE.test(first) && variant ? first : run.lookup.mediaIdForSlug(first);
  if (id === null || !run.lookup.mediaExists(id)) {
    if (!run.grandfathered.has(raw)) issue(run, "unknown-media", raw, where);
    return raw;
  }
  return formatLinkRef({ kind: "media", mediaId: id, variant });
}

/**
 * Canonicalise one URL value. Returns the stored form: a reference, or
 * the value unchanged (external, non-page, or an issue was recorded).
 *
 * @param scope `pages+media` for link positions (`href`, link fields);
 *   `media` for image positions (`src`, `srcset`, `poster`).
 */
export function canonicaliseUrl(
  value: string,
  run: LinkCanonicaliseRun,
  where: string,
  scope: "pages+media" | "media" = "pages+media",
): string {
  const v = value.trim();
  if (v.length === 0 || v.includes("{{")) return value;

  const ref = parseLinkRef(v);
  if (ref) {
    if (!targetExists(ref, run.lookup) && !run.grandfathered.has(v)) {
      issue(run, ref.kind === "page" ? "dangling-page-ref" : "dangling-media-ref", v, where);
    }
    return v;
  }

  let local: string;
  if (/^https?:\/\//i.test(v)) {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return value;
    }
    if (!run.lookup.isOwnHost(u.host.toLowerCase())) return value;
    local = `${u.pathname}${u.search}${u.hash}`;
  } else if (v.startsWith("/") && !v.startsWith("//")) {
    local = v;
  } else {
    return value;
  }

  const { path, query, anchor } = splitPathTail(local);
  const media = canonicaliseMediaPath(path, v, run, where);
  if (media !== null) return media;
  if (scope === "media") return value;
  // Not a page: other reserved surfaces (`/_assets/…`, `/_caelo/fonts/…`),
  // the gateway (`/api/…`) and files (`/robots.txt`, `/guide.pdf`).
  if (path.startsWith("/_") || path === "/api" || path.startsWith("/api/")) return value;
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  if (FILE_EXT_RE.test(lastSegment)) return value;

  const pageId = run.lookup.pageIdForPath(normaliseLinkPath(path));
  if (pageId === null) {
    if (!run.grandfathered.has(v)) issue(run, "unknown-page-path", v, where);
    return value;
  }
  if ((query !== null && !QUERY_OK.test(query)) || (anchor !== null && !ANCHOR_OK.test(anchor))) {
    if (!run.grandfathered.has(v)) issue(run, "unsupported-link-form", v, where);
    return value;
  }
  return formatLinkRef({ kind: "page", pageId, query, anchor });
}

function targetExists(ref: LinkRef, lookup: LinkTargetLookup): boolean {
  return ref.kind === "page" ? lookup.pageExists(ref.pageId) : lookup.mediaExists(ref.mediaId);
}

// Attribute scanner: `name="…"` / `name='…'` for the four link-bearing
// attributes. The value classes exclude their own quote, so each match
// is linear (no backtracking across attributes).
const ATTR_RE = /(\s(?:href|src|poster|srcset)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;

/** Canonicalise the link-bearing attributes of an HTML fragment. */
export function canonicaliseHtmlLinks(
  html: string,
  run: LinkCanonicaliseRun,
  where: string,
): string {
  if (!html.includes("=")) return html;
  return html.replace(ATTR_RE, (whole, prefix: string, dq?: string, sq?: string) => {
    const quote = dq !== undefined ? '"' : "'";
    const raw = (dq ?? sq) as string;
    const attr = prefix
      .trim()
      .replace(/\s*=\s*$/, "")
      .toLowerCase();
    let next: string;
    if (attr === "href") next = canonicaliseUrl(raw, run, where, "pages+media");
    else if (attr === "srcset") next = canonicaliseSrcset(raw, run, where);
    else next = canonicaliseUrl(raw, run, where, "media");
    return next === raw ? whole : `${prefix}${quote}${next}${quote}`;
  });
}

/** `url 400w, url 800w` — each candidate URL is a media position. */
function canonicaliseSrcset(srcset: string, run: LinkCanonicaliseRun, where: string): string {
  return srcset
    .split(",")
    .map((entry) => {
      const lead = entry.length - entry.trimStart().length;
      const body = entry.slice(lead);
      const sp = body.search(/\s/);
      const url = sp === -1 ? body : body.slice(0, sp);
      const rest = sp === -1 ? "" : body.slice(sp);
      const next = canonicaliseUrl(url, run, where, "media");
      return `${entry.slice(0, lead)}${next}${rest}`;
    })
    .join(",");
}

/**
 * Canonicalise any JSON value: whole-value URLs where the key says so
 * (`asUrl`), HTML attributes in every string, recursing through arrays
 * and objects (object keys decide per {@link isLinkKeyName}).
 */
export function canonicaliseJsonLinks(
  value: unknown,
  run: LinkCanonicaliseRun,
  where: string,
  asUrl = false,
): unknown {
  if (typeof value === "string") {
    if (asUrl) return canonicaliseUrl(value, run, where);
    return value.includes("<") ? canonicaliseHtmlLinks(value, run, where) : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v, i) => {
      const r = canonicaliseJsonLinks(v, run, `${where}[${i}]`, asUrl);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = canonicaliseJsonLinks(v, run, `${where}.${k}`, isLinkKeyName(k));
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}

/** A module field as canonicalisation needs it. */
export interface CanonicaliseField {
  readonly name: string;
  readonly kind: string;
  readonly default?: unknown;
}

/** Field kinds whose whole value is a URL. */
const URL_KINDS: ReadonlySet<string> = new Set(["url", "link", "image"]);
/** Field kinds that hold nested-module refs, never links. */
const NESTED_KINDS: ReadonlySet<string> = new Set(["module", "module-list"]);

function canonicaliseFieldValue(
  field: CanonicaliseField | undefined,
  name: string,
  value: unknown,
  run: LinkCanonicaliseRun,
  where: string,
): unknown {
  if (field && NESTED_KINDS.has(field.kind)) return value;
  const asUrl = (field !== undefined && URL_KINDS.has(field.kind)) || isLinkKeyName(name);
  return canonicaliseJsonLinks(value, run, where, asUrl);
}

/**
 * Canonicalise a content instance's values against its module's fields.
 * Values without a declared field are still scanned (key-name rule +
 * HTML) — a stale value renders nowhere today but may again tomorrow.
 */
export function canonicaliseContentValues(
  fields: readonly CanonicaliseField[],
  values: Readonly<Record<string, unknown>>,
  run: LinkCanonicaliseRun,
): Record<string, unknown> {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = canonicaliseFieldValue(byName.get(k), k, v, run, `values.${k}`);
  }
  return out;
}

/** Canonicalise every field's `default` (layout chrome content lives there). */
export function canonicaliseFieldDefaults<F extends CanonicaliseField>(
  fields: readonly F[],
  run: LinkCanonicaliseRun,
): F[] {
  return fields.map((f) => {
    if (f.default === undefined || f.default === null) return f;
    const next = canonicaliseFieldValue(f, f.name, f.default, run, `fields.${f.name}.default`);
    return next === f.default ? f : { ...f, default: next };
  });
}

/**
 * Every link literal inside a stored state (values, defaults, set items,
 * module HTML) — the {@link LinkCanonicaliseRun.grandfathered} set of the
 * next write. Collected with a lookup that knows nothing, so every
 * candidate surfaces as an "issue" carrying its raw value.
 */
export function collectLinkLiterals(state: unknown): Set<string> {
  const run = linkCanonicaliseRun(NOTHING_RESOLVES, { mode: "report" });
  canonicaliseJsonLinks(state, run, "", false);
  // Whole-value positions are only known with field context; strings
  // that look like a link are therefore also taken verbatim.
  const out = new Set(run.issues.map((i) => i.value));
  collectStrings(state, out);
  return out;
}

function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    const v = value.trim();
    if (v.startsWith("/") || v.startsWith("caelo:") || /^https?:\/\//i.test(v)) out.add(v);
    return;
  }
  if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

const NOTHING_RESOLVES: LinkTargetLookup = {
  pageIdForPath: () => null,
  mediaIdForSlug: () => null,
  pageExists: () => false,
  mediaExists: () => false,
  isOwnHost: () => true,
};

const ISSUE_TEXT: Readonly<Record<LinkCanonicaliseIssue["kind"], string>> = {
  "unknown-page-path": "is not the path of any page on this site",
  "unknown-media": "names no image or file in the media library",
  "dangling-page-ref": "links to a page that was deleted",
  "dangling-media-ref": "links to an image or file that was deleted",
  "unsupported-link-form": "has a query or #anchor with characters a stored link cannot carry",
};

/**
 * One AI-actionable message for a refused write (CLAUDE.md §11): what is
 * wrong with each link and the next step. Paths only — the author never
 * sees reference ids except for a reference that is already broken.
 */
export function describeLinkIssues(issues: readonly LinkCanonicaliseIssue[]): string {
  const lines = issues.slice(0, 10).map((i) => `${i.where}: "${i.value}" ${ISSUE_TEXT[i.kind]}`);
  const more = issues.length > 10 ? ` (and ${issues.length - 10} more)` : "";
  return (
    `Internal link check failed — ${lines.join("; ")}${more}. ` +
    "Internal links must point at an existing page or media asset. Next step: use the exact path " +
    "of an existing page (list_pages shows every page's path) or an existing media URL (find_media); " +
    "if the page does not exist yet, create it first (or leave the link out and add it once the page " +
    "exists). For a link to another site, write the full https:// URL."
  );
}
