// SPDX-License-Identifier: MPL-2.0

/**
 * The facts of a staged page that plugins check (`PluginAuditPageFacts`
 * in the plugin SDK): language, head signals (canonical, robots,
 * hreflang, og:locale), the sitemap's alternates for the page, every
 * body link, the visible text, and (#1755, ./page-facts-collectors.ts)
 * headings, images, JSON-LD and Open Graph / Twitter tags — each
 * attributed to the module, list entry or plugin output it sits in. One
 * parser pass reads all of them.
 *
 * Why core extracts them: a plugin's backend runs in the sandbox, whose
 * bundle resolves nothing but the plugin entry and the SDK — no HTML
 * parser. And one extractor means every plugin reads a page the same way
 * the core checks do (htmlparser2, real attributes only, URLs resolved
 * like a browser resolves them, see ./links-analysis.ts).
 *
 * Long pages are cut at the SDK's `AUDIT_FACT_LIMITS` and flagged
 * `truncated`, with the facts that were cut in `truncatedFacts`, so a
 * plugin can say it saw part of a page instead of reporting on a guess.
 */

import {
  AUDIT_FACT_LIMITS,
  type PluginAuditFactName,
  type PluginAuditPageFacts,
  type PluginAuditUrl,
} from "@caelo-cms/plugin-sdk";
import { Parser } from "htmlparser2";
import type { StagedPage } from "./check.js";
import { resolveLink, type SiteHosts } from "./links-analysis.js";
import { type CollectorScope, createPageFactCollectors } from "./page-facts-collectors.js";

/** The order `truncatedFacts` lists cut facts in. */
const FACT_ORDER: readonly PluginAuditFactName[] = [
  "links",
  "texts",
  "headings",
  "images",
  "jsonLd",
  "socialMeta",
];

/** Elements whose content is never visible text. */
const INVISIBLE = new Set(["script", "style", "noscript", "template", "head"]);

/**
 * Elements whose text is a literal, not language: code, commands and what a
 * visitor types. It reads the same in every language, so a plugin that
 * judges language must be able to leave it out.
 */
const LITERAL = new Set(["code", "pre", "kbd", "samp", "var"]);

/** Attributes whose value a visitor reads (or a screen reader announces). */
const VISIBLE_ATTRS = ["alt", "placeholder", "aria-label", "title"] as const;

/** `<input type>`s whose `value` is the button label. */
const BUTTON_INPUTS = new Set(["submit", "button", "reset"]);

type Alternate = PluginAuditUrl & { readonly hreflang: string };

/** Sitemap alternates per page path key, or "no-sitemap". */
export type SitemapAlternates = ReadonlyMap<string, readonly Alternate[]> | "no-sitemap";

interface Scope extends CollectorScope {
  readonly tag: string;
  /** Inside a {@link LITERAL} element. */
  readonly code: boolean;
  /** The `translate` state: `no` holds until a descendant says `yes`. */
  readonly noTranslate: boolean;
}

interface OpenLink {
  readonly href: string;
  readonly hreflang: string | null;
  readonly label: string | null;
  readonly scope: Scope;
  text: string;
  /** The `alt` of the images inside it: an image link's name (a linked logo). */
  imageAlt: string;
  readonly depth: number;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cut(s: string): string {
  return s.length > AUDIT_FACT_LIMITS.textLength ? s.slice(0, AUDIT_FACT_LIMITS.textLength) : s;
}

function urlOf(raw: string, base: string, hosts: SiteHosts): PluginAuditUrl {
  const r = resolveLink(raw, base, hosts);
  return { href: raw, path: r.kind === "same-site" ? r.key : null };
}

/**
 * The sitemap's `<xhtml:link rel="alternate">` entries per `<loc>` path.
 *
 * @param xml the staged `sitemap.xml`, or null when the build has none.
 */
export function parseSitemapAlternates(xml: string | null, hosts: SiteHosts): SitemapAlternates {
  if (xml === null) return "no-sitemap";
  const out = new Map<string, Alternate[]>();
  let loc: string | null = null;
  let inLoc = false;
  let current: Alternate[] = [];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "url") {
          loc = null;
          current = [];
        } else if (name === "loc") {
          inLoc = true;
          loc = "";
        } else if (name === "xhtml:link" && (attrs.rel ?? "").toLowerCase() === "alternate") {
          if (attrs.hreflang !== undefined && attrs.href !== undefined) {
            current.push({
              hreflang: attrs.hreflang,
              ...urlOf(attrs.href, attrs.href, hosts),
            });
          }
        }
      },
      ontext(text) {
        if (inLoc) loc = `${loc ?? ""}${text}`;
      },
      onclosetag(name) {
        if (name === "loc") inLoc = false;
        if (name === "url" && loc !== null) {
          const l = loc.trim();
          const r = resolveLink(l, l, hosts);
          if (r.kind === "same-site") out.set(r.key, current);
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml);
  parser.end();
  return out;
}

/**
 * The facts of one staged page.
 *
 * @param hosts the site's own hosts (see `siteHostsOf`): a URL on one of
 *   them gets a `path`.
 * @param sitemap the parsed staged sitemap.
 *
 * @example
 *   extractPageFacts(page, hosts, "no-sitemap").links
 *   // → [{ href: "/en/", path: "/en", hreflang: "en", text: "English", moduleId: "…", … }]
 */
export function extractPageFacts(
  page: StagedPage,
  hosts: SiteHosts,
  sitemap: SitemapAlternates,
): PluginAuditPageFacts {
  let lang: string | null = null;
  let title: string | null = null;
  let metaDescription: string | null = null;
  let canonical: PluginAuditUrl | null = null;
  let robots: string | null = null;
  let ogLocale: string | null = null;
  const ogLocaleAlternates: string[] = [];
  const alternates: Alternate[] = [];
  const links: PluginAuditPageFacts["links"][number][] = [];
  const texts: PluginAuditPageFacts["texts"][number][] = [];
  const cutFacts = new Set<PluginAuditFactName>();
  let base = page.url;
  let inTitle = false;
  let titleText = "";
  const stack: Scope[] = [];
  const open: OpenLink[] = [];
  const top = (): Scope =>
    stack[stack.length - 1] ?? {
      tag: "",
      moduleId: null,
      listItem: null,
      pluginSlug: null,
      invisible: false,
      inert: false,
      ariaHidden: false,
      code: false,
      noTranslate: false,
    };
  const collectors = createPageFactCollectors(
    (raw) => urlOf(raw, base, hosts),
    (fact) => cutFacts.add(fact),
  );
  const addText = (raw: string, scope: Scope, source: string) => {
    const text = collapse(raw);
    if (text === "" || !/\p{L}/u.test(text)) return;
    if (texts.length >= AUDIT_FACT_LIMITS.texts) {
      cutFacts.add("texts");
      return;
    }
    texts.push({
      text: cut(text),
      moduleId: scope.moduleId,
      listItem: scope.listItem,
      pluginSlug: scope.pluginSlug,
      source: scope.code || scope.noTranslate ? "literal" : source,
    });
  };
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const parent = top();
        const moduleId = attrs["data-caelo-module-id"];
        const translate = attrs.translate?.toLowerCase();
        const scope: Scope = {
          tag: name,
          moduleId: moduleId ?? parent.moduleId,
          // A nested module root starts outside every list entry.
          listItem:
            attrs["data-caelo-list-item"] ?? (moduleId === undefined ? parent.listItem : null),
          pluginSlug: attrs["data-caelo-plugin"] ?? parent.pluginSlug,
          invisible: parent.invisible || INVISIBLE.has(name),
          inert: parent.inert || name === "template",
          ariaHidden: parent.ariaHidden || attrs["aria-hidden"]?.trim().toLowerCase() === "true",
          code: parent.code || LITERAL.has(name),
          noTranslate: translate === "no" || (translate !== "yes" && parent.noTranslate),
        };
        stack.push(scope);
        collectors.open(name, attrs, scope, stack.length);
        if (name === "html" && attrs.lang !== undefined) lang = attrs.lang;
        if (name === "base" && attrs.href !== undefined && base === page.url) {
          try {
            base = new URL(attrs.href, page.url).toString();
          } catch {
            // A malformed <base> leaves the page URL as the base, as browsers do.
          }
        }
        if (name === "title" && stack.some((s) => s.tag === "head")) {
          inTitle = true;
          titleText = "";
        }
        if (name === "meta") {
          const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
          const content = attrs.content;
          if (content !== undefined) {
            if (key === "description") metaDescription = content;
            else if (key === "robots") robots = content.toLowerCase();
            else if (key === "og:locale") ogLocale = content;
            else if (key === "og:locale:alternate") ogLocaleAlternates.push(content);
          }
        }
        if (name === "link" && attrs.href !== undefined) {
          const rels = (attrs.rel ?? "").toLowerCase().split(/\s+/);
          if (rels.includes("canonical") && canonical === null) {
            canonical = urlOf(attrs.href, base, hosts);
          }
          if (rels.includes("alternate") && attrs.hreflang !== undefined) {
            alternates.push({ hreflang: attrs.hreflang, ...urlOf(attrs.href, base, hosts) });
          }
        }
        if (scope.invisible) return;
        for (const attr of VISIBLE_ATTRS) {
          const v = attrs[attr];
          if (v !== undefined) addText(v, scope, attr);
        }
        if (name === "img" && attrs.alt !== undefined) {
          for (const l of open) l.imageAlt += ` ${attrs.alt}`;
        }
        if (name === "input" && BUTTON_INPUTS.has((attrs.type ?? "").toLowerCase())) {
          if (attrs.value !== undefined) addText(attrs.value, scope, "value");
        }
        if (name === "a" && attrs.href !== undefined) {
          open.push({
            href: attrs.href,
            hreflang: attrs.hreflang ?? null,
            label: attrs["aria-label"] ?? attrs.title ?? null,
            scope,
            text: "",
            imageAlt: "",
            depth: stack.length,
          });
        }
      },
      ontext(raw) {
        if (inTitle) titleText += raw;
        const scope = top();
        collectors.text(raw, scope);
        if (scope.invisible) return;
        for (const l of open) l.text += raw;
        addText(raw, scope, "text");
      },
      onclosetag(name) {
        if (name === "title" && inTitle) {
          inTitle = false;
          if (title === null) title = collapse(titleText);
        }
        const last = open[open.length - 1];
        if (name === "a" && last && last.depth === stack.length) {
          open.pop();
          if (links.length >= AUDIT_FACT_LIMITS.links) cutFacts.add("links");
          else {
            links.push({
              ...urlOf(last.href, base, hosts),
              hreflang: last.hreflang,
              // The link's name: its visible text, else the alt of its
              // images (a linked logo), else aria-label / title.
              text: cut(
                collapse(last.text) || collapse(last.imageAlt) || collapse(last.label ?? ""),
              ),
              moduleId: last.scope.moduleId,
              listItem: last.scope.listItem,
              pluginSlug: last.scope.pluginSlug,
            });
          }
        }
        collectors.close(name, stack.length);
        stack.pop();
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(page.html);
  parser.end();
  return {
    pageId: page.pageId,
    path: page.path,
    lang,
    title,
    metaDescription,
    canonical,
    robots,
    ogLocale,
    ogLocaleAlternates,
    alternates,
    sitemapAlternates:
      sitemap === "no-sitemap" ? "no-sitemap" : (sitemap.get(resolvePathKey(page, hosts)) ?? null),
    links,
    texts,
    ...collectors.result(),
    truncated: cutFacts.size > 0,
    truncatedFacts: FACT_ORDER.filter((f) => cutFacts.has(f)),
  };
}

/** The page's own path key, as the sitemap's `<loc>` resolves to. */
function resolvePathKey(page: StagedPage, hosts: SiteHosts): string {
  const r = resolveLink(page.path, page.url, hosts);
  return r.kind === "same-site" ? r.key : page.path;
}
