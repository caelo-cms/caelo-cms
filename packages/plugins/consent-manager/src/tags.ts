// SPDX-License-Identifier: MPL-2.0

/**
 * Tracking tags — third-party code the site wants to run, each pinned
 * to a consent category so it cannot run before the visitor agrees.
 *
 * ## Why the runtime injects them rather than the page
 *
 * A tag written into the page's HTML has already run by the time any
 * script could decide whether it should. So no tag reaches the document
 * at build time: the runtime holds them and injects the ones whose
 * category is granted. The check therefore happens before the request,
 * not after it.
 *
 * ## `necessary` is not a shortcut
 *
 * A tag in the `necessary` category runs for everyone, unasked. That is
 * correct for a session cookie and wrong for anything that measures or
 * follows a visitor, so registering one there requires a written
 * justification — enforced at the operation, not left to reviewer
 * discipline. Without it, "necessary" is simply the category that makes
 * the banner stop being an obstacle.
 *
 * ## A tag is also a declaration
 *
 * The same row says which cookies the tag sets, who the vendor is and
 * where data goes (#1133). The cookie declaration on the privacy page,
 * the banner copy and the withdrawal that deletes those cookies (#1136)
 * all read it, so they cannot drift apart the way three hand-kept copies
 * do.
 */

import { z } from "@caelo-cms/plugin-sdk";
import { parseVendorConfig, VENDOR_TEMPLATES } from "./vendors.js";

/** One cookie a tag sets. `pattern` makes `name` a prefix (`_ga_` covers `_ga_ABC123`). */
export const cookieDeclSchema = z
  .object({
    // RFC 6265 token characters, which is what any real cookie name uses.
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "a cookie name (letters, digits, _ . -)"),
    pattern: z.boolean().optional(),
    lifetime: z.string().min(1).max(64),
    purpose: z.string().min(1).max(500),
  })
  .strict();
export type CookieDecl = z.infer<typeof cookieDeclSchema>;

/** Who receives the data — what a cookie declaration must say about a vendor. */
export const vendorInfoSchema = z
  .object({
    name: z.string().max(200).optional(),
    /** Registered address. */
    seat: z.string().max(500).optional(),
    purpose: z.string().max(1000).optional(),
    legalBasis: z.string().max(300).optional(),
    /** Country outside the EU/EEA the data reaches; empty when none. */
    thirdCountry: z.string().max(200).optional(),
    /** Adequacy decision, Data Privacy Framework, SCCs, … */
    transferBasis: z.string().max(300).optional(),
    privacyPolicyUrl: z.string().url().max(2000).optional(),
  })
  .strict();
export type VendorInfo = z.infer<typeof vendorInfoSchema>;

const pathGlob = z
  .string()
  .max(512)
  .regex(/^\/[A-Za-z0-9\-._~/*%]*$/, 'a site path starting with "/", `*` as wildcard');
const localeTag = z
  .string()
  .regex(/^[a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'a language tag such as "de" or "de-AT"');

/**
 * Where a tag runs. Empty means every page. Page and template ids are
 * resolved to paths at build time, so the runtime only compares
 * `location.pathname` and `<html lang>` (#1138).
 */
export const tagScopeSchema = z
  .object({
    paths: z.array(pathGlob).max(200).optional(),
    excludePaths: z.array(pathGlob).max(200).optional(),
    pageIds: z.array(z.string().uuid()).max(1000).optional(),
    excludePageIds: z.array(z.string().uuid()).max(1000).optional(),
    templateIds: z.array(z.string().uuid()).max(100).optional(),
    excludeTemplateIds: z.array(z.string().uuid()).max(100).optional(),
    locales: z.array(localeTag).max(50).optional(),
  })
  .strict();
export type TagScope = z.infer<typeof tagScopeSchema>;

/** The writable fields of a tag, as `add_tag` and each `update_tags_many` item take them. */
export const tagFieldsSchema = z
  .object({
    vendor: z.string().max(64).optional(),
    category: z.string().max(64).optional(),
    config: z.record(z.string().max(64), z.string().max(500)).optional(),
    scriptSrc: z.string().max(2000).optional(),
    inlineSnippet: z.string().max(50_000).optional(),
    position: z.enum(["head", "body_end"]).optional(),
    justification: z.string().max(2000).optional(),
    cookies: z.array(cookieDeclSchema).max(50).optional(),
    vendorInfo: vendorInfoSchema.optional(),
    scope: tagScopeSchema.optional(),
  })
  .strict();
export type TagFields = z.infer<typeof tagFieldsSchema>;

export interface TagRow {
  id: string;
  name: string;
  vendor: string;
  category_key: string;
  script_src: string;
  inline_snippet: string;
  position: string;
  justification: string;
  enabled: boolean;
  /** Null on rows written before #1135. */
  config: Record<string, string> | null;
  cookies: CookieDecl[] | null;
  vendor_info: VendorInfo | null;
  scope: TagScope | null;
}

/** The stored columns a resolved tag writes. */
export interface TagColumns {
  vendor: string;
  category_key: string;
  config: Record<string, string>;
  script_src: string;
  inline_snippet: string;
  position: "head" | "body_end";
  justification: string;
  cookies: CookieDecl[];
  vendor_info: VendorInfo;
  scope: TagScope;
}

/** What the runtime needs to inject one tag and clean up after it. */
export interface BakedTag {
  readonly name: string;
  readonly category: string;
  readonly src: string;
  readonly inline: string;
  readonly position: "head" | "body_end";
  /** First-party cookies to expire when the category is withdrawn (#1136). */
  readonly cookies: ReadonlyArray<{ readonly name: string; readonly prefix: boolean }>;
  /** Resolved scope; `include: null` means every path, `locales: null` every language. */
  readonly scope: {
    readonly include: ReadonlyArray<string> | null;
    readonly exclude: ReadonlyArray<string>;
    readonly locales: ReadonlyArray<string> | null;
  };
}

/**
 * The legal basis a declaration states when the operator gave none. A
 * tag outside `necessary` runs only after the visitor's consent, so that
 * IS its basis; a `necessary` one runs without it and rests on the
 * justification the operation demands.
 */
export function defaultLegalBasis(category: string): string {
  return category === "necessary"
    ? "Strictly necessary for the service the visitor requested (Art. 6(1)(f) GDPR; exempt from consent under Art. 5(3) ePrivacy Directive)"
    : "Consent (Art. 6(1)(a) GDPR; storing and reading data on the device: Art. 5(3) ePrivacy Directive)";
}

/** Zod issues as one line the AI can act on. */
export function describeIssues(tool: string, error: z.ZodError): string {
  return `${tool}: ${error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "input"}: ${i.message}`)
    .join("; ")}`;
}

/**
 * Turn a tag's fields into the columns to store — the one place the
 * rules live, for adding and updating alike.
 *
 * A known vendor builds its code from `config` and supplies cookie and
 * vendor defaults; any other vendor brings its own `scriptSrc` or
 * snippet. Throws with the next step on anything the runtime could not
 * use or the operator could not defend.
 *
 * @param tool the calling tool's name, for the error prefix
 * @param fields the merged fields (for an update: the stored row with the patch applied)
 * @param categories the category keys that exist
 */
export function resolveTagColumns(
  tool: string,
  fields: TagFields,
  categories: ReadonlySet<string>,
): TagColumns {
  const vendorKey = (fields.vendor ?? "").trim();
  const template = VENDOR_TEMPLATES[vendorKey];
  const categoryKey = fields.category ?? template?.category;
  if (!categoryKey || !categories.has(categoryKey)) {
    throw new Error(
      `${tool}: \`category\` must be one of ${[...categories].join(", ")}${
        template ? ` (${vendorKey} is normally ${template.category})` : ""
      }`,
    );
  }

  let src: string;
  let inline: string;
  let config: Record<string, string> = {};
  if (template) {
    if ((fields.scriptSrc ?? "") !== "" || (fields.inlineSnippet ?? "") !== "") {
      throw new Error(
        `${tool}: ${vendorKey} is a known vendor — its code is built from \`config\` (${Object.keys(template.config).join(", ")}). Drop \`scriptSrc\`/\`inlineSnippet\` and pass the ids in \`config\`.`,
      );
    }
    config = parseVendorConfig(tool, vendorKey, template, fields.config);
    ({ src, inline } = template.build(config));
  } else {
    if (fields.config && Object.keys(fields.config).length > 0) {
      throw new Error(
        `${tool}: \`config\` is only for the known vendors (${Object.keys(VENDOR_TEMPLATES).join(", ")}); for "${vendorKey || "(no vendor)"}" pass \`scriptSrc\` or \`inlineSnippet\` instead.`,
      );
    }
    src = fields.scriptSrc ?? "";
    inline = fields.inlineSnippet ?? "";
    if (src.length === 0 && inline.length === 0) {
      throw new Error(
        `${tool}: give the tag something to load — \`scriptSrc\` or \`inlineSnippet\`, or a known \`vendor\` with its \`config\``,
      );
    }
    if (src.length > 0 && !/^https:\/\//i.test(src)) {
      throw new Error(`${tool}: \`scriptSrc\` must be an https URL — got "${src}"`);
    }
  }
  assertInlineSnippetIsJs(tool, inline);

  const reason = (fields.justification ?? "").trim();
  // A `necessary` tag runs for everyone, unasked. That is right for a
  // session cookie and wrong for anything that measures or follows a
  // visitor, so claiming it costs a written reason.
  if (categoryKey === "necessary" && reason.length < 20) {
    throw new Error(
      `${tool}: a tag in \`necessary\` runs before the visitor is asked, so it needs a written \`justification\` saying why it is strictly required. If it measures or follows visitors, it belongs in analytics or marketing instead.`,
    );
  }

  const vendorInfo: VendorInfo = { ...(template?.vendorInfo ?? {}), ...(fields.vendorInfo ?? {}) };
  if (!vendorInfo.legalBasis) vendorInfo.legalBasis = defaultLegalBasis(categoryKey);
  return {
    vendor: vendorKey,
    category_key: categoryKey,
    config,
    script_src: src,
    inline_snippet: inline,
    position: fields.position ?? "body_end",
    justification: reason,
    cookies: [...(fields.cookies ?? template?.cookies ?? [])],
    vendor_info: vendorInfo,
    scope: fields.scope ?? {},
  };
}

/** The writable fields a stored row stands for — the base an update patches. */
export function fieldsOfRow(row: TagRow): TagFields {
  const templated = Boolean(VENDOR_TEMPLATES[row.vendor]) && row.config !== null;
  return {
    vendor: row.vendor,
    category: row.category_key,
    // A templated tag's code is derived from its config; carrying the
    // generated code into the merge would read as hand-written.
    ...(templated
      ? { config: row.config ?? {} }
      : { scriptSrc: row.script_src, inlineSnippet: row.inline_snippet }),
    position: row.position === "head" ? "head" : "body_end",
    justification: row.justification,
    ...(row.cookies ? { cookies: row.cookies } : {}),
    ...(row.vendor_info ? { vendorInfo: row.vendor_info } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
  };
}

/**
 * What a cookie declaration still lacks for this tag, worded as the
 * question to ask the operator. Empty when the declaration is complete.
 */
export function declarationGaps(
  tag: Pick<TagColumns, "cookies" | "vendor_info" | "vendor">,
): string[] {
  const v = tag.vendor_info;
  const gaps: string[] = [];
  if (!v.name) gaps.push("vendorInfo.name: who receives the data");
  if (!v.seat) gaps.push("vendorInfo.seat: the vendor's registered address");
  if (!v.purpose) gaps.push("vendorInfo.purpose: what the tag is used for");
  if (!v.privacyPolicyUrl) gaps.push("vendorInfo.privacyPolicyUrl: the vendor's privacy policy");
  if (v.thirdCountry && !v.transferBasis) {
    gaps.push(`vendorInfo.transferBasis: the legal basis for the transfer to ${v.thirdCountry}`);
  }
  if (tag.cookies.length === 0 && tag.vendor !== "google-tag-manager") {
    gaps.push(
      "cookies: none declared — if the tag sets cookies, list them so a withdrawal deletes them",
    );
  }
  return gaps;
}

/** The cookie name as a declaration shows it: `_ga_*` for a prefix. */
export function cookieLabel(c: CookieDecl): string {
  return c.pattern ? `${c.name}*` : c.name;
}

/**
 * Reject vendor HTML in `inlineSnippet`. Vendors hand out
 * `<script>…</script><noscript><img …></noscript>`; the runtime runs the
 * snippet as JavaScript, so HTML there is a syntax error and the tag
 * silently never fires.
 */
export function assertInlineSnippetIsJs(tool: string, inline: string): void {
  if (/<\/?(script|noscript)\b/i.test(inline)) {
    throw new Error(
      `${tool}: \`inlineSnippet\` must be the JavaScript INSIDE the vendor's <script> tag, without the <script>/<noscript> wrappers. Strip the tags and pass only the code between them; a <noscript> tracking pixel is dropped, since it only fires for visitors without JavaScript and cannot wait for consent.`,
    );
  }
}

/**
 * JSON safe to place inside an inline `<script>`: `<` is escaped so a
 * `</script>` in the data cannot end the element early, and the two
 * line separators JavaScript treats as line breaks are escaped too.
 */
export function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/**
 * The injector, appended to the runtime with the site's tags baked in.
 *
 * Paths compare normalised (`/a/`, `/a/index.html` and `/a.html` are the
 * page `/a`) because the deploy target decides which of those the
 * browser shows. `*` in a path matches anything, `/` included. A locale
 * matches the `<html lang>` itself and its regional variants (`de`
 * covers `de-AT`).
 */
export function buildTagInjector(tags: ReadonlyArray<BakedTag>): string {
  return [
    `var TAGS = ${jsonForInlineScript(tags)};`,
    `var loadedTags = {};`,
    `function normPath(p) {`,
    `  p = String(p || "/").replace(/\\/index\\.html?$/, "/").replace(/\\.html?$/, "");`,
    `  if (p.length > 1 && p.charAt(p.length - 1) === "/") p = p.slice(0, -1);`,
    `  return p || "/";`,
    `}`,
    `function pathMatches(glob, path) {`,
    `  var parts = normPath(glob).split("*");`,
    `  for (var i = 0; i < parts.length; i++) parts[i] = parts[i].replace(/[.+?^\${}()|[\\]\\\\]/g, "\\\\$&");`,
    `  return new RegExp("^" + parts.join(".*") + "$").test(path);`,
    `}`,
    `function anyPath(globs, path) {`,
    `  for (var i = 0; i < globs.length; i++) if (pathMatches(globs[i], path)) return true;`,
    `  return false;`,
    `}`,
    `function inScope(scope) {`,
    `  var path = normPath(location.pathname);`,
    `  if (scope.locales) {`,
    `    var lang = String(document.documentElement.lang || "").toLowerCase();`,
    `    var ok = false;`,
    `    for (var i = 0; i < scope.locales.length; i++) {`,
    `      var l = scope.locales[i].toLowerCase();`,
    `      if (lang === l || lang.indexOf(l + "-") === 0) ok = true;`,
    `    }`,
    `    if (!ok) return false;`,
    `  }`,
    `  if (scope.include && !anyPath(scope.include, path)) return false;`,
    `  return !anyPath(scope.exclude, path);`,
    `}`,
    `function loadTags() {`,
    `  for (var i = 0; i < TAGS.length; i++) {`,
    `    var tag = TAGS[i];`,
    `    if (loadedTags[tag.name]) continue;`,
    `    if (!isGranted(tag.category)) continue;`,
    `    if (!inScope(tag.scope)) continue;`,
    `    loadedTags[tag.name] = true;`,
    `    var target = tag.position === "head" ? document.head : document.body;`,
    `    if (tag.src) {`,
    `      var el = document.createElement("script");`,
    `      el.async = true;`,
    `      el.src = tag.src;`,
    `      el.setAttribute("data-caelo-tag", tag.name);`,
    `      target.appendChild(el);`,
    `    }`,
    `    if (tag.inline) {`,
    `      var inline = document.createElement("script");`,
    `      inline.text = tag.inline;`,
    `      inline.setAttribute("data-caelo-tag", tag.name);`,
    `      target.appendChild(inline);`,
    `    }`,
    `  }`,
    `}`,
    // Withdrawal must be as effective as consent (Art. 7(3) GDPR): the
    // cookies a withdrawn category's tags set go too. A script cannot
    // know which domain a vendor set its cookie on, nor where the
    // registrable domain starts (no public suffix list in the browser),
    // so it expires the name on the host and on every parent with at
    // least two labels; the browser ignores the attempt on a public
    // suffix.
    `function cookieDomains() {`,
    `  var labels = String(location.hostname || "").split(".");`,
    `  var out = [""];`,
    `  for (var i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));`,
    `  return out;`,
    `}`,
    `function expireCookie(name) {`,
    `  var domains = cookieDomains();`,
    `  for (var i = 0; i < domains.length; i++) {`,
    `    try {`,
    `      document.cookie = name + "=;path=/;max-age=0;expires=Thu, 01 Jan 1970 00:00:00 GMT" + (domains[i] ? ";domain=" + domains[i] : "");`,
    `    } catch (e) {`,
    `      return;`,
    `    }`,
    `  }`,
    `}`,
    `function expireWithdrawnCookies(keptKeys) {`,
    `  var jar = cookieJar();`,
    `  if (!jar) return;`,
    `  var names = [];`,
    `  var parts = jar.split("; ");`,
    `  for (var p = 0; p < parts.length; p++) names.push(parts[p].split("=")[0]);`,
    `  for (var i = 0; i < TAGS.length; i++) {`,
    `    var tag = TAGS[i];`,
    `    if (keptKeys.indexOf(tag.category) !== -1) continue;`,
    `    for (var c = 0; c < tag.cookies.length; c++) {`,
    `      var decl = tag.cookies[c];`,
    `      for (var n = 0; n < names.length; n++) {`,
    `        var hit = decl.prefix ? names[n].indexOf(decl.name) === 0 : names[n] === decl.name;`,
    `        if (hit) expireCookie(names[n]);`,
    `      }`,
    `    }`,
    `  }`,
    `}`,
  ].join("\n");
}
