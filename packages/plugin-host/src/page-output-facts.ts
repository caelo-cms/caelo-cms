// SPDX-License-Identifier: MPL-2.0

/**
 * What a staged page shows, for build observers (epic #1644, R1, #1647).
 *
 * The generator calls this on each page's final HTML, exactly as Publish
 * live ships it, for the pages whose output changed. Unlike the audit's
 * facts (admin-core quality/checks/page-facts.ts), nothing is cut: an
 * observer indexes the whole page. Every text run says where it sits:
 *
 * - the module (`data-caelo-module-id`, inherited by nested modules), its
 *   list entry and baked plugin region, as the audit facts do;
 * - the zone of the placement it belongs to (layout chrome or the page's own
 *   placements), from the composition: a module nested in another module's
 *   field inherits its parent's zone;
 * - the heading level when it is inside `h1`–`h6`, and the anchor of its
 *   section: the `id` of the nearest heading or `section`/`article` at or
 *   before it, so a search hit can link to the section;
 * - whether it is inside a `<form>`, whose labels and buttons are form text.
 *
 * The host adds what the HTML does not say (page type, properties, terms,
 * short title, module kinds and placement counts) before an observer sees
 * the facts.
 */

import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";

/** Where a module sits in a page's composition. */
export type PageOutputZone = "layout" | "template" | "page";

/** One module the composition placed on the page. */
export interface ComposedModuleRef {
  readonly moduleId: string;
  readonly zone: PageOutputZone;
  readonly contentInstanceId: string | null;
}

/** One visible text run. */
export interface PageHtmlText {
  readonly text: string;
  readonly moduleId: string | null;
  readonly listItem: string | null;
  readonly pluginSlug: string | null;
  readonly source: string;
  readonly heading: number | null;
  readonly anchor: string | null;
  readonly inForm: boolean;
}

/** One link of the body. */
export interface PageHtmlLink {
  readonly href: string;
  /** The site path it names (`/de/preise`), null for an external link. */
  readonly path: string | null;
  readonly text: string;
  readonly moduleId: string | null;
  readonly zone: PageOutputZone | null;
  readonly pluginSlug: string | null;
}

/** The facts of one page as the generator reads them from the HTML. */
export interface PageHtmlFacts {
  readonly pageId: string;
  /** The page's public path (`/de/preise/`). */
  readonly path: string;
  readonly lang: string | null;
  readonly title: string | null;
  readonly metaDescription: string | null;
  readonly robots: string | null;
  /** Modules of the composition plus those found nested in the HTML, each once. */
  readonly modules: readonly ComposedModuleRef[];
  readonly texts: readonly PageHtmlText[];
  readonly links: readonly PageHtmlLink[];
  /** A module withheld by a plugin (`data-caelo-deferred`) or a baked plugin region. */
  readonly hasDeferredContent: boolean;
  /** Text or links past the bounds were left out. */
  readonly truncated: boolean;
  /** SHA-256 of the facts above: equal digests, equal facts. */
  readonly outputHash: string;
}

const INVISIBLE = new Set(["script", "style", "noscript", "template", "head"]);
const LITERAL = new Set(["code", "pre", "kbd", "samp", "var"]);
const VISIBLE_ATTRS = ["alt", "placeholder", "aria-label", "title"] as const;
const BUTTON_INPUTS = new Set(["button", "submit", "reset"]);
const HEADING = /^h([1-6])$/;

interface Scope {
  readonly tag: string;
  readonly moduleId: string | null;
  readonly zone: PageOutputZone | null;
  readonly listItem: string | null;
  readonly pluginSlug: string | null;
  readonly invisible: boolean;
  readonly literal: boolean;
  readonly noTranslate: boolean;
  readonly heading: number | null;
  readonly inForm: boolean;
}

const ROOT: Scope = {
  tag: "",
  moduleId: null,
  zone: null,
  listItem: null,
  pluginSlug: null,
  invisible: false,
  literal: false,
  noTranslate: false,
  heading: null,
  inForm: false,
};

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** A site path in one spelling: no query or hash, no `index.html`, no trailing slash except the root. */
export function canonicalSitePath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURI(p);
  } catch {
    // A malformed escape stays as written.
  }
  p = p.replace(/\/index\.html?$/i, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

/** The site path a link names, or null when it leaves the site or is no page link. */
export function sitePathOf(
  href: string,
  pageUrl: string,
  siteOrigins: ReadonlySet<string>,
): string | null {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(trimmed))
    return null;
  let url: URL;
  try {
    url = new URL(trimmed, pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!siteOrigins.has(url.origin)) return null;
  return canonicalSitePath(url.pathname);
}

/** Inputs of {@link extractPageHtmlFacts}. */
export interface PageHtmlInput {
  readonly pageId: string;
  readonly path: string;
  /** The page's absolute URL, the base of its relative links. */
  readonly url: string;
  readonly html: string;
  /** Modules the composition placed, with their zone. */
  readonly composed: readonly ComposedModuleRef[];
  /** Origins that are this site (the build's base URL and its other hosts). */
  readonly siteOrigins: ReadonlySet<string>;
}

/** Text characters one page's facts carry at most (about 120 printed pages). */
export const MAX_PAGE_TEXT_CHARS = 200_000;

/** Links one page's facts carry at most. */
export const MAX_PAGE_LINKS = 2_000;

/** Reads the facts of one page's final HTML. */
export function extractPageHtmlFacts(input: PageHtmlInput): PageHtmlFacts {
  const zoneOf = new Map(input.composed.map((m) => [m.moduleId, m.zone] as const));
  const modules = new Map(input.composed.map((m) => [m.moduleId, m] as const));
  let lang: string | null = null;
  let title: string | null = null;
  let metaDescription: string | null = null;
  let robots: string | null = null;
  let hasDeferredContent = false;
  let truncated = false;
  let anchor: string | null = null;
  let inTitle = false;
  let titleText = "";
  const texts: PageHtmlText[] = [];
  const links: PageHtmlLink[] = [];
  const stack: Scope[] = [];
  const open: { href: string; label: string | null; scope: Scope; text: string; depth: number }[] =
    [];
  const top = (): Scope => stack[stack.length - 1] ?? ROOT;
  let textChars = 0;
  const addText = (raw: string, scope: Scope, source: string): void => {
    const text = collapse(raw);
    if (text === "" || !/\p{L}|\p{N}/u.test(text)) return;
    // A page's facts stay deliverable in one observer call (the sandbox's
    // 1 MB line): text past the bound is left out and the facts say so.
    if (textChars + text.length > MAX_PAGE_TEXT_CHARS) {
      truncated = true;
      return;
    }
    textChars += text.length;
    texts.push({
      text,
      moduleId: scope.moduleId,
      listItem: scope.listItem,
      pluginSlug: scope.pluginSlug,
      source: scope.literal || scope.noTranslate ? "literal" : source,
      heading: scope.heading,
      anchor,
      inForm: scope.inForm,
    });
  };
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const parent = top();
        const moduleId = attrs["data-caelo-module-id"];
        const translate = attrs.translate?.toLowerCase();
        const headingMatch = HEADING.exec(name);
        const zone =
          moduleId !== undefined ? (zoneOf.get(moduleId) ?? parent.zone ?? "page") : parent.zone;
        if (moduleId !== undefined && !modules.has(moduleId))
          modules.set(moduleId, { moduleId, zone: zone ?? "page", contentInstanceId: null });
        const scope: Scope = {
          tag: name,
          moduleId: moduleId ?? parent.moduleId,
          zone,
          listItem:
            attrs["data-caelo-list-item"] ?? (moduleId === undefined ? parent.listItem : null),
          pluginSlug: attrs["data-caelo-plugin"] ?? parent.pluginSlug,
          invisible: parent.invisible || INVISIBLE.has(name),
          literal: parent.literal || LITERAL.has(name),
          noTranslate: translate === "no" || (translate !== "yes" && parent.noTranslate),
          heading: headingMatch ? Number(headingMatch[1]) : parent.heading,
          inForm: parent.inForm || name === "form",
        };
        stack.push(scope);
        if (attrs["data-caelo-deferred"] !== undefined || attrs["data-caelo-plugin"] !== undefined)
          hasDeferredContent = true;
        if (name === "html" && attrs.lang !== undefined) lang = attrs.lang;
        if (name === "title" && stack.some((s) => s.tag === "head")) {
          inTitle = true;
          titleText = "";
        }
        if (name === "meta") {
          const key = (attrs.name ?? attrs.property ?? "").toLowerCase();
          if (attrs.content !== undefined) {
            if (key === "description") metaDescription = attrs.content;
            else if (key === "robots") robots = attrs.content.toLowerCase();
          }
        }
        if (scope.invisible) return;
        if (
          attrs.id !== undefined &&
          attrs.id !== "" &&
          (headingMatch || name === "section" || name === "article")
        )
          anchor = attrs.id;
        for (const attr of VISIBLE_ATTRS) {
          const v = attrs[attr];
          if (v !== undefined) addText(v, scope, attr);
        }
        if (
          name === "input" &&
          BUTTON_INPUTS.has((attrs.type ?? "").toLowerCase()) &&
          attrs.value !== undefined
        )
          addText(attrs.value, scope, "value");
        if (name === "a" && attrs.href !== undefined) {
          open.push({
            href: attrs.href,
            label: attrs["aria-label"] ?? attrs.title ?? null,
            scope,
            text: "",
            depth: stack.length,
          });
        }
      },
      ontext(raw) {
        if (inTitle) titleText += raw;
        const scope = top();
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
          links.push({
            href: last.href,
            path: sitePathOf(last.href, input.url, input.siteOrigins),
            text: collapse(last.text) || collapse(last.label ?? ""),
            moduleId: last.scope.moduleId,
            zone: last.scope.zone,
            pluginSlug: last.scope.pluginSlug,
          });
        }
        stack.pop();
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(input.html);
  parser.end();
  const facts = {
    pageId: input.pageId,
    path: input.path,
    lang,
    title,
    metaDescription,
    robots,
    modules: [...modules.values()],
    texts,
    links: links.slice(0, MAX_PAGE_LINKS),
    hasDeferredContent,
    truncated: truncated || links.length > MAX_PAGE_LINKS,
  };
  return { ...facts, outputHash: createHash("sha256").update(JSON.stringify(facts)).digest("hex") };
}

/** SHA-256 of a page's final HTML: the cheap first test of whether its facts can have changed. */
export function pageHtmlHash(html: string): string {
  return createHash("sha256").update(html).digest("hex");
}
