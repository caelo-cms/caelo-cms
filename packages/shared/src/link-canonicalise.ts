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
 *   - pending: while a chat rebuilds a site import, a link to a page of
 *     that run not built yet is kept and listed in `run.pending`; the
 *     caller records it and the run's finalisation converts it (or
 *     reports it) once the run's pages exist.
 *   - the site root: `/` (with an optional `#anchor` / `?query`) while no
 *     page serves it yet is kept literal, not refused. Every site has a
 *     root page by the time it ships — the staged build refuses one
 *     without — so the link cannot dangle, and site chrome (the brand
 *     link, `/#features` nav items) is routinely written before the
 *     homepage. Once the homepage exists, `/` canonicalises as usual.
 */

import {
  findMalformedLinkRefs,
  formatLinkRef,
  LINK_REF_PART_PATTERNS,
  type LinkRef,
  parseLinkRef,
} from "./link-refs.js";
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
  /**
   * True when `path` names a page that does not exist YET but is planned:
   * a page of the site import the writing chat is rebuilding, not built
   * so far (#724 rollout C, maintainer decision on open point 1). Such a
   * link keeps its literal path and lands in
   * {@link LinkCanonicaliseRun.pending} instead of being an issue; the
   * import converts it once the page exists. Absent = nothing is pending
   * (every write outside an import run).
   */
  isPendingPagePath?(path: string): boolean;
}

/** A link to a planned (not yet built) page, kept literal for now. */
export interface PendingLinkTarget {
  /** The link exactly as written (trimmed). */
  readonly value: string;
  /** Its normalised path: the planned page's path. */
  readonly path: string;
  readonly where: string;
}

/** One link the canonicaliser could not turn into a reference. */
export interface LinkCanonicaliseIssue {
  readonly kind:
    | "unknown-page-path"
    | "unknown-media"
    | "dangling-page-ref"
    | "dangling-media-ref"
    | "unknown-file"
    | "unsupported-link-form"
    | "malformed-link-ref";
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
  /** Links to planned pages (see {@link LinkTargetLookup.isPendingPagePath}). */
  readonly pending: PendingLinkTarget[];
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
    pending: [],
  };
}

// The reference grammar's own part patterns (link-refs.ts): a query,
// anchor or variant they accept always round-trips through
// `formatLinkRef`, and one they reject is an issue, never a throw (a
// thrown error would turn bad author input into a 500).
const QUERY_OK = LINK_REF_PART_PATTERNS.query;
const ANCHOR_OK = LINK_REF_PART_PATTERNS.anchor;
const VARIANT_RE = LINK_REF_PART_PATTERNS.variant;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEDIA_SEGMENT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Text that starts like a reference. When the grammar rejects it, it is
// a broken reference, not some other URL (`malformed-link-ref`).
const REF_LIKE_RE = /^caelo:(?:page|media)\//;
// A last path segment with a file extension names a file, not a page —
// unless a page or an old-URL redirect answers it (`/about.html` an import
// redirected), which is checked first.
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
// Files the static build itself serves at the site root; a link to one
// is a plain URL. Any other file path must come from the media library.
const SITE_SERVED_FILES: ReadonlySet<string> = new Set(["/robots.txt", "/sitemap.xml"]);

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

/**
 * Record every malformed reference in `text` (HTML or a plain value).
 * The render flags exactly these (`link-ref-malformed`, via the shared
 * `findMalformedLinkRefs`), so a write that would ship one is refused up
 * front. A snippet already recorded at the same position (the
 * whole-value check in {@link canonicaliseUrl} saw it first) is not
 * reported twice.
 */
function reportMalformedRefs(text: string, run: LinkCanonicaliseRun, where: string): void {
  for (const raw of findMalformedLinkRefs(text)) {
    if (run.grandfathered.has(raw)) continue;
    const seen = run.issues.some(
      (i) => i.kind === "malformed-link-ref" && i.where === where && i.value.startsWith(raw),
    );
    if (!seen) issue(run, "malformed-link-ref", raw, where);
  }
}

/**
 * Canonicalise a `/_caelo/media/<slug>[/<variant>]` path, or null when it
 * is not one.
 *
 * @param hasSuffix the link carries a `?query` or `#anchor`. A media
 *   reference cannot carry either (`caelo:media/<id>` has no suffix), so
 *   such a link is an `unsupported-link-form` issue instead of a
 *   reference that silently drops `#page=3`.
 */
function canonicaliseMediaPath(
  path: string,
  raw: string,
  hasSuffix: boolean,
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
  if (hasSuffix) {
    if (!run.grandfathered.has(raw)) issue(run, "unsupported-link-form", raw, where);
    return raw;
  }
  // `orig` is the original, which a reference expresses as no variant.
  return formatLinkRef({
    kind: "media",
    mediaId: id,
    variant: variant === "orig" ? null : variant,
  });
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
  // Starts like a reference but breaks the grammar (a truncated id,
  // stray characters after it): passing it through would store a link
  // no render resolves (CLAUDE.md §2).
  if (REF_LIKE_RE.test(v)) {
    if (!run.grandfathered.has(v)) issue(run, "malformed-link-ref", v, where);
    return value;
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
  const media = canonicaliseMediaPath(path, v, query !== null || anchor !== null, run, where);
  if (media !== null) return media;
  if (scope === "media") return value;
  // Not a page: other reserved surfaces (`/_assets/…`, `/_caelo/fonts/…`)
  // and the gateway (`/api/…`).
  if (path.startsWith("/_") || path === "/api" || path.startsWith("/api/")) return value;

  const normalised = normaliseLinkPath(path);
  const pageId = run.lookup.pageIdForPath(normalised);
  if (pageId === null && run.lookup.isPendingPagePath?.(normalised)) {
    // A page the import run will still build: kept as written and
    // recorded by the caller; the run's finalisation converts it.
    run.pending.push({ value: v, path: normalised, where });
    return value;
  }
  if (pageId === null && normalised === "/") {
    // The site root before its page exists (a header built ahead of the
    // homepage). It cannot dangle: the staged build refuses a site with
    // no page at "/" (CLAUDE.md §2: loud there, not here). Kept literal;
    // the next save after the homepage exists stores its reference.
    if ((query !== null && !QUERY_OK.test(query)) || (anchor !== null && !ANCHOR_OK.test(anchor))) {
      if (!run.grandfathered.has(v)) issue(run, "unsupported-link-form", v, where);
    }
    return value;
  }
  if (pageId === null) {
    const lastSegment = path.slice(path.lastIndexOf("/") + 1);
    const isFile = FILE_EXT_RE.test(lastSegment);
    if (isFile && SITE_SERVED_FILES.has(path)) return value;
    if (!run.grandfathered.has(v))
      issue(run, isFile ? "unknown-file" : "unknown-page-path", v, where);
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
  if (!html.includes("=")) {
    reportMalformedRefs(html, run, where);
    return html;
  }
  // Attributes are only read inside a start tag, so escaped markup in a
  // code sample (`&lt;a href="/x"&gt;` is text, not a link) is left alone.
  let out = "";
  let from = 0;
  for (const [start, end] of startTags(html)) {
    out += html.slice(from, start) + canonicaliseTagAttributes(html.slice(start, end), run, where);
    from = end;
  }
  // Broken references anywhere the render looks (any attribute, a srcset
  // entry), not only in the four attributes canonicalised above.
  reportMalformedRefs(html, run, where);
  return from === 0 ? html : out + html.slice(from);
}

/**
 * `[start, end)` of every start tag (`<` + letter … `>`), quoted values
 * allowed to contain `>`. One linear pass; an unterminated quote runs to
 * the end of the input instead of being rescanned.
 */
function* startTags(html: string): Generator<[number, number]> {
  let i = html.indexOf("<");
  while (i !== -1 && i < html.length - 1) {
    const c = html.charCodeAt(i + 1);
    const isLetter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!isLetter) {
      i = html.indexOf("<", i + 1);
      continue;
    }
    let j = i + 2;
    let quote = 0;
    while (j < html.length) {
      const ch = html.charCodeAt(j);
      if (quote !== 0) {
        if (ch === quote) quote = 0;
      } else if (ch === 34 || ch === 39) {
        quote = ch;
      } else if (ch === 62) {
        break;
      }
      j += 1;
    }
    const end = Math.min(j + 1, html.length);
    yield [i, end];
    i = html.indexOf("<", end);
  }
}

// A whole attribute value that is exactly one placeholder: `{{name}}`,
// `{{{name}}}`, `{{&name}}`, or a list item `{{.}}` / `{{item}}`.
const WHOLE_PLACEHOLDER_RE = /^\s*\{\{\{?\s*&?\s*([A-Za-z][A-Za-z0-9_]*|\.)\s*\}?\}\}\s*$/;
// Section open / close tags, to name the list a `{{.}}` iterates.
const SECTION_TAG_RE = /\{\{\s*([#^/])\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * The fields module HTML puts WHOLE into a link attribute
 * (`href="{{cta}}"`, `src="{{photo}}"`, `<a href="{{.}}">` inside
 * `{{#links}}…{{/links}}`), lowercased as the template engine looks them
 * up. Such a value renders as a link whatever kind the field declares
 * (`text`), and even when no field declares it at all (the engine puts
 * every stored value into its view), so link checks and write-time
 * canonicalisation read it as a URL (#852). A placeholder that is only
 * part of the value (`href="{{base}}/docs"`, `mailto:{{email}}`) is not:
 * the value is not a link on its own. `srcset` is a list of candidates,
 * never one URL, and stays out.
 *
 * @example
 *   urlFieldNamesInHtml('<a href="{{cta_target}}">{{label}}</a>'); // Set { "cta_target" }
 */
export function urlFieldNamesInHtml(html: string): Set<string> {
  const out = new Set<string>();
  if (!html.includes("{{")) return out;
  // Open sections by position, so a `{{.}}` names its innermost list.
  const sections: { name: string; start: number; end: number }[] = [];
  const open: { name: string; start: number }[] = [];
  for (const m of html.matchAll(SECTION_TAG_RE)) {
    const name = (m[2] as string).toLowerCase();
    if (m[1] !== "/") {
      open.push({ name, start: m.index });
      continue;
    }
    for (let k = open.length - 1; k >= 0; k -= 1) {
      const o = open[k] as { name: string; start: number };
      if (o.name !== name) continue;
      sections.push({ name, start: o.start, end: m.index });
      open.length = k;
      break;
    }
  }
  const innermostSection = (at: number): string | null => {
    let best: { name: string; start: number; end: number } | null = null;
    for (const s of sections) {
      if (s.start < at && at < s.end && (best === null || s.start > best.start)) best = s;
    }
    return best?.name ?? null;
  };
  for (const [start, end] of startTags(html)) {
    const tag = html.slice(start, end);
    for (const m of tag.matchAll(ATTR_RE)) {
      const attr = (m[1] as string)
        .trim()
        .replace(/\s*=\s*$/, "")
        .toLowerCase();
      if (attr === "srcset") continue;
      const placeholder = WHOLE_PLACEHOLDER_RE.exec(m[2] ?? m[3] ?? "")?.[1];
      if (placeholder === undefined) continue;
      if (placeholder !== "." && placeholder.toLowerCase() !== "item") {
        out.add(placeholder.toLowerCase());
        continue;
      }
      const list = innermostSection(start + m.index);
      if (list !== null) out.add(list);
    }
  }
  return out;
}

function canonicaliseTagAttributes(tag: string, run: LinkCanonicaliseRun, where: string): string {
  return tag.replace(ATTR_RE, (whole, prefix: string, dq?: string, sq?: string) => {
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
    if (value.includes("<")) return canonicaliseHtmlLinks(value, run, where);
    // A text value is never a link as a whole, but one that starts like a
    // reference and breaks the grammar renders as a dead `caelo:` href
    // wherever a module puts it in an attribute.
    reportMalformedRefs(value, run, where);
    return value;
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
  urlNames: ReadonlySet<string> | undefined,
): unknown {
  if (field && NESTED_KINDS.has(field.kind)) return value;
  const asUrl =
    (field !== undefined && URL_KINDS.has(field.kind)) ||
    isLinkKeyName(name) ||
    urlNames?.has(name.toLowerCase()) === true;
  return canonicaliseJsonLinks(value, run, where, asUrl);
}

/**
 * Canonicalise a content instance's values against its module's fields.
 * Values without a declared field are still scanned (key-name rule +
 * HTML): the template engine renders every stored value a placeholder
 * names, declared or not.
 *
 * @param urlNames fields the module HTML puts whole into a link
 *   attribute ({@link urlFieldNamesInHtml}); their values are URLs
 *   whatever their declared kind.
 */
export function canonicaliseContentValues(
  fields: readonly CanonicaliseField[],
  values: Readonly<Record<string, unknown>>,
  run: LinkCanonicaliseRun,
  urlNames?: ReadonlySet<string>,
): Record<string, unknown> {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = canonicaliseFieldValue(byName.get(k), k, v, run, `values.${k}`, urlNames);
  }
  return out;
}

/**
 * Canonicalise every field's `default` (layout chrome content lives there).
 *
 * @param urlNames as for {@link canonicaliseContentValues}.
 */
export function canonicaliseFieldDefaults<F extends CanonicaliseField>(
  fields: readonly F[],
  run: LinkCanonicaliseRun,
  urlNames?: ReadonlySet<string>,
): F[] {
  return fields.map((f) => {
    if (f.default === undefined || f.default === null) return f;
    const next = canonicaliseFieldValue(
      f,
      f.name,
      f.default,
      run,
      `fields.${f.name}.default`,
      urlNames,
    );
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
  "unknown-file":
    "is a file path nothing on this site serves (files are served from the media library: upload it, then link its media URL from find_media)",
  "unsupported-link-form":
    "has a query or #anchor a stored link cannot carry (page links allow plain query/anchor characters only; media links allow neither)",
  "malformed-link-ref":
    "starts like an internal reference (caelo:page/ or caelo:media/) but is broken, e.g. a truncated id or extra characters after it; write the page's path (/about#team) or the media URL (/_caelo/media/<slug>) instead, never a caelo: reference",
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
    "if the page does not exist yet, create it first (build_page with `modules: []` makes an empty page " +
    "shell) or leave the link out and add it once the page exists. The site root `/` is always valid. " +
    "For a link to another site, write the full https:// URL."
  );
}
