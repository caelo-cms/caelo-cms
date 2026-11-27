// SPDX-License-Identifier: MPL-2.0

/**
 * #1755 — the headings, images, JSON-LD and Open Graph / Twitter tags of a
 * staged page, for plugin checks (`PluginAuditPageFacts` in the plugin SDK;
 * the `seo` plugin's objective rules, epic #1751, read them).
 *
 * They ride the one parser pass of ./page-facts.ts: that pass owns the
 * element stack and the scope of each element (module, list entry, plugin
 * output, visibility), and hands every open tag, text run and close tag to
 * {@link createPageFactCollectors}. A second parse of every staged page per
 * fact batch would double the audit's parse cost for nothing.
 *
 * What counts as a heading is the plugin SDK's `headingLevel`, the rule the
 * build observer's facts use too (plugin-host page-output-facts.ts).
 *
 * Each fact has a cap (`AUDIT_FACT_LIMITS`); past it the rest is left out
 * and the fact is named in `truncatedFacts`. A JSON-LD block that is not
 * JSON is a fact about the page (`kind: "invalid"`), never an exception:
 * the plugin decides what it means.
 */

import {
  AUDIT_FACT_LIMITS,
  headingLevel,
  type PluginAuditFactName,
  type PluginAuditHeading,
  type PluginAuditImage,
  type PluginAuditJsonLd,
  type PluginAuditPageFacts,
  type PluginAuditPlace,
  type PluginAuditSocialMeta,
  type PluginAuditUrl,
} from "@caelo-cms/plugin-sdk";
import { MEDIA_CONTENT_HASH_HEX_LENGTH, MEDIA_URL_PREFIX } from "@caelo-cms/shared";

/** What the parser pass knows about the element a tag or text belongs to. */
export interface CollectorScope extends PluginAuditPlace {
  /** Inside `script`, `style`, `noscript`, `template` or the head: no visible content. */
  readonly invisible: boolean;
  /** Inside `<template>`: inert markup, not part of the page. */
  readonly inert: boolean;
  /** `aria-hidden="true"` on the element or one around it. */
  readonly ariaHidden: boolean;
}

/** The facts the collectors add to a page's facts. */
export type CollectedFacts = Pick<
  PluginAuditPageFacts,
  "headings" | "images" | "jsonLd" | "socialMeta"
>;

/** Hooks the parser pass calls, in document order. */
export interface PageFactCollectors {
  /** An open tag; `depth` is the element stack's length with this element on it. */
  open(
    name: string,
    attrs: Readonly<Record<string, string>>,
    scope: CollectorScope,
    depth: number,
  ): void;
  /** A text run (raw, entities decoded) inside the element of `scope`. */
  text(raw: string, scope: CollectorScope): void;
  /** A close tag; `depth` as at its open tag. */
  close(name: string, depth: number): void;
  result(): CollectedFacts;
}

const { textLength } = AUDIT_FACT_LIMITS;

/**
 * Raw text kept per open heading. Collapsing whitespace can only shorten
 * it, so a few times the cut length is enough, and a heading left open
 * around half the page (broken markup) costs no more than that.
 */
const HEADING_RAW_CHARS = textLength * 4;

/** Key prefixes of Open Graph (with its object types) and Twitter cards. */
const SOCIAL_PREFIXES = ["og:", "article:", "book:", "profile:", "music:", "video:", "twitter:"];

const DECORATIVE_ROLES = new Set(["presentation", "none"]);

/** Published library media (static-generator media-asset-path.ts) and the editor URL a Stage keeps. */
const HASH = `[0-9a-f]{${MEDIA_CONTENT_HASH_HEX_LENGTH}}`;
const PUBLISHED_ORIG = new RegExp(`^/_assets/([a-z0-9][a-z0-9-]*)\\.${HASH}\\.[a-z0-9]{2,5}$`);
const PUBLISHED_VARIANT = new RegExp(
  `^/_assets/([a-z0-9][a-z0-9-]*)/([a-z][a-z0-9-]*)\\.${HASH}\\.[a-z0-9]{2,5}$`,
);
const EDITOR_MEDIA = new RegExp(
  `^${MEDIA_URL_PREFIX}/([a-z0-9][a-z0-9-]{0,63})(?:/([a-z][a-z0-9-]{0,63}))?$`,
);

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cut(s: string): string {
  return s.length > textLength ? s.slice(0, textLength) : s;
}

function placeOf(scope: CollectorScope): PluginAuditPlace {
  return { moduleId: scope.moduleId, listItem: scope.listItem, pluginSlug: scope.pluginSlug };
}

/**
 * The media library image a site path shows, or null.
 *
 * @param path a same-site path as `PluginAuditUrl.path` has it.
 * @example mediaOfPath("/_assets/team/webp-800.0123456789abcdef.webp")
 *   // → { ref: "team", variant: "webp-800" }
 */
export function mediaOfPath(path: string | null): PluginAuditImage["media"] {
  if (path === null) return null;
  const orig = PUBLISHED_ORIG.exec(path);
  if (orig) return { ref: orig[1] as string, variant: "orig" };
  const variant = PUBLISHED_VARIANT.exec(path) ?? EDITOR_MEDIA.exec(path);
  if (variant) return { ref: variant[1] as string, variant: variant[2] ?? "orig" };
  return null;
}

/**
 * An image dimension attribute in CSS pixels, read like a browser reads
 * it (leading digits, `800px` is 800); null when absent, a percentage, or
 * no number.
 */
export function pixelDimension(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)(%?)/.exec(raw);
  if (!m || m[2] === "%") return null;
  return Number(m[1]);
}

function isJsonLd(type: string | undefined): boolean {
  return (type ?? "").split(";")[0]?.trim().toLowerCase() === "application/ld+json";
}

function isSocialKey(key: string): boolean {
  return SOCIAL_PREFIXES.some((p) => key.startsWith(p) && key.length > p.length);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Collectors for one page.
 *
 * @param resolveUrl resolves an attribute URL against the page's current
 *   base (a `<base href>` read earlier in the pass applies).
 * @param cutFact receives the name of each fact a cap cuts.
 */
export function createPageFactCollectors(
  resolveUrl: (raw: string) => PluginAuditUrl,
  cutFact: (fact: PluginAuditFactName) => void,
): PageFactCollectors {
  const headings: Mutable<PluginAuditHeading>[] = [];
  const images: PluginAuditImage[] = [];
  const jsonLd: PluginAuditJsonLd[] = [];
  const socialMeta: PluginAuditSocialMeta[] = [];
  const openHeadings: { entry: Mutable<PluginAuditHeading>; raw: string; depth: number }[] = [];
  let script: { place: PluginAuditPlace; raw: string; chars: number; depth: number } | null = null;
  let jsonLdChars = 0;

  const toHeadings = (raw: string) => {
    for (const h of openHeadings) {
      if (h.raw.length < HEADING_RAW_CHARS) h.raw += raw.slice(0, HEADING_RAW_CHARS - h.raw.length);
    }
  };

  const openHeading = (
    level: PluginAuditHeading["level"],
    scope: CollectorScope,
    depth: number,
  ) => {
    if (headings.length >= AUDIT_FACT_LIMITS.headings) {
      cutFact("headings");
      return;
    }
    // In the list at its open tag, so nested headings keep document order.
    const entry: Mutable<PluginAuditHeading> = { level, text: "", ...placeOf(scope) };
    headings.push(entry);
    openHeadings.push({ entry, raw: "", depth });
  };

  const addImage = (attrs: Readonly<Record<string, string>>, scope: CollectorScope) => {
    const alt = attrs.alt === undefined ? null : cut(collapse(attrs.alt));
    // An image's alt is part of the name of a heading around it.
    if (alt) toHeadings(` ${alt} `);
    if (images.length >= AUDIT_FACT_LIMITS.images) {
      cutFact("images");
      return;
    }
    const src = attrs.src === undefined ? null : resolveUrl(attrs.src);
    const role = (attrs.role ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
    images.push({
      // An inline `data:` image would carry the whole file in the facts.
      src: src && { ...src, href: src.href.slice(0, AUDIT_FACT_LIMITS.urlLength) },
      media: mediaOfPath(src?.path ?? null),
      alt,
      width: pixelDimension(attrs.width),
      height: pixelDimension(attrs.height),
      decorative: alt === "" || DECORATIVE_ROLES.has(role) || scope.ariaHidden,
      ...placeOf(scope),
    });
  };

  const addSocialMeta = (attrs: Readonly<Record<string, string>>) => {
    const content = attrs.content;
    if (content === undefined) return;
    const seen = new Set<string>();
    for (const attribute of ["property", "name"] as const) {
      const key = attrs[attribute]?.trim().toLowerCase();
      if (!key || seen.has(key) || !isSocialKey(key)) continue;
      seen.add(key);
      if (socialMeta.length >= AUDIT_FACT_LIMITS.socialMeta) {
        cutFact("socialMeta");
        return;
      }
      if (content.length > AUDIT_FACT_LIMITS.socialMetaLength) cutFact("socialMeta");
      socialMeta.push({
        key,
        attribute,
        content: content.slice(0, AUDIT_FACT_LIMITS.socialMetaLength),
      });
    }
  };

  const closeScript = () => {
    if (!script) return;
    const { place, raw, chars } = script;
    script = null;
    if (jsonLdChars + chars > AUDIT_FACT_LIMITS.jsonLdChars) {
      cutFact("jsonLd");
      jsonLd.push({ kind: "omitted", chars, ...place });
      return;
    }
    jsonLdChars += chars;
    try {
      jsonLd.push({ kind: "parsed", data: JSON.parse(raw) as unknown, ...place });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      jsonLd.push({ kind: "invalid", error: cut(error), ...place });
    }
  };

  return {
    open(name, attrs, scope, depth) {
      if (scope.inert) return;
      if (name === "meta") addSocialMeta(attrs);
      if (name === "script" && isJsonLd(attrs.type)) {
        if (jsonLd.length >= AUDIT_FACT_LIMITS.jsonLdBlocks) cutFact("jsonLd");
        else script = { place: placeOf(scope), raw: "", chars: 0, depth };
        return;
      }
      if (scope.invisible) return;
      const level = headingLevel(name);
      if (level !== null) openHeading(level, scope, depth);
      if (name === "img") addImage(attrs, scope);
    },
    text(raw, scope) {
      if (script) {
        script.chars += raw.length;
        // Past the page's budget the block is omitted: count it, keep nothing.
        if (jsonLdChars + script.chars <= AUDIT_FACT_LIMITS.jsonLdChars) script.raw += raw;
        return;
      }
      if (!scope.invisible) toHeadings(raw);
    },
    close(name, depth) {
      if (name === "script" && script?.depth === depth) closeScript();
      const last = openHeadings[openHeadings.length - 1];
      if (last && last.depth === depth && headingLevel(name) !== null) {
        openHeadings.pop();
        last.entry.text = cut(collapse(last.raw));
      }
    },
    result() {
      return { headings, images, jsonLd, socialMeta };
    },
  };
}
