// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1454 — what a build ships, read from its finished pages, so its CSP
 * names exactly that (@caelo-cms/shared site-security-headers.ts).
 *
 * The scan runs over each page's final HTML, after every pass that rewrites
 * it: media URLs (a media CDN is an origin here), plugin bakes, the module
 * script file. It keeps sets, never pages, so its memory does not grow with
 * the site. `<template>` content is scanned too: a withheld module's embed
 * is restored from there once the visitor consents. An absolute URL on the
 * site's own origin stays in the lists: `'self'` is the host a page is served
 * from, which is another one on the audit's loopback origin.
 *
 * What a page's script loads at runtime cannot be read from markup. Plugins
 * say it themselves (`csp-sources.json` of `buildAssets`), the Owner adds the
 * rest to the policy's `extraSources`, and report-only shows what is missing.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CSP_SOURCE_KINDS,
  type CspBlocker,
  type CspSourceKind,
  cspBlockerSchema,
  type PluginCspSources,
  parseSiteHeaderSet,
  SECURITY_HEADERS_BUILD_FILE,
  type SiteCspFacts,
} from "@caelo-cms/shared";
import { Parser } from "htmlparser2";
import { z } from "zod";

/** Distinct blockers kept per build. */
const MAX_BLOCKERS = 50;

/**
 * What a scanned origin may look like before it enters a header. The URL
 * parser accepts `"`, `{`, `}` and `;` in a host, and a host like that would
 * end a Caddyfile string, expand a Caddy placeholder or add a CSP directive.
 * No real host has them, so such a URL loads nothing and is left out.
 */
const SCANNED_ORIGIN_RE =
  /^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
/** Pages named per blocker in the facts; all of them are in the sidecar. */
const MAX_BLOCKER_PAGES = 5;
/** Inline scripts holding the site's origin kept for the staging gateway. */
const MAX_ORIGIN_BOUND_SCRIPTS = 50;

/**
 * Which pages each blocker is on, beside the build (`outDir`) and never
 * served: an incremental build rescans only its changed pages, and a page
 * whose handler was removed must lose its blocker.
 */
const BLOCKER_PAGES_FILE = "_security-blockers.json";

/** A blocker with every page it is on. */
interface BlockerPages {
  readonly kind: CspBlocker["kind"];
  readonly detail: string;
  readonly pages: Set<string>;
}

const blockerPagesSchema = z.array(
  z.object({
    kind: cspBlockerSchema.shape.kind,
    detail: z.string(),
    pages: z.array(z.string()),
  }),
);

const URL_IN_CSS_RE = /url\(\s*['"]?((?:https?:)?\/\/[^'")\s]+)/gi;
const IMPORT_IN_CSS_RE = /@import\s+(?:url\(\s*)?['"]?((?:https?:)?\/\/[^'")\s;]+)/gi;
const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/gi;

const EXECUTABLE_SCRIPT_TYPES: ReadonlySet<string> = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
]);

/** `sha256` CSP source of an inline script's exact text. */
export function inlineScriptHash(body: string): string {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

/** Scans the pages of one build. */
export class CspScanner {
  readonly #selfOrigin: string;
  readonly #origins = new Map<CspSourceKind, Set<string>>();
  readonly #objects = new Set<string>();
  readonly #hashes = new Set<string>();
  readonly #blockers = new Map<string, BlockerPages>();
  readonly #originBound = new Set<string>();
  readonly #originForms: readonly string[];
  readonly #plugins: SiteCspFacts["plugins"][number][] = [];

  /** @param siteBaseUrl the origin the build renders for. */
  constructor(siteBaseUrl: string) {
    this.#selfOrigin = new URL(siteBaseUrl).origin;
    this.#originForms = [this.#selfOrigin, this.#selfOrigin.replaceAll("/", "\\/")];
  }

  #note(kind: CspSourceKind, origin: string): void {
    const set = this.#origins.get(kind) ?? new Set<string>();
    set.add(origin);
    this.#origins.set(kind, set);
  }

  /** The origin of an absolute `url`, or null for a relative one. */
  #originOf(url: string): string | null {
    const trimmed = url.trim();
    const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
    if (!/^https?:\/\//i.test(absolute)) return null;
    try {
      const origin = new URL(absolute).origin;
      return SCANNED_ORIGIN_RE.test(origin) ? origin : null;
    } catch {
      return null;
    }
  }

  #source(kind: CspSourceKind, url: string | undefined): void {
    if (!url) return;
    const origin = this.#originOf(url);
    if (origin !== null) this.#note(kind, origin);
  }

  #srcset(kind: CspSourceKind, srcset: string | undefined): void {
    for (const candidate of (srcset ?? "").split(",")) {
      this.#source(kind, candidate.trim().split(/\s+/)[0]);
    }
  }

  #css(css: string): void {
    if (!css.includes("url(") && !css.includes("@import")) return;
    for (const m of css.matchAll(IMPORT_IN_CSS_RE)) this.#source("style", m[1]);
    for (const face of css.matchAll(FONT_FACE_RE)) {
      for (const m of face[0].matchAll(URL_IN_CSS_RE)) this.#source("font", m[1]);
    }
    const rest = css.replace(FONT_FACE_RE, "").replace(IMPORT_IN_CSS_RE, "");
    for (const m of rest.matchAll(URL_IN_CSS_RE)) this.#source("img", m[1]);
  }

  #blocker(kind: CspBlocker["kind"], detail: string, page: string): void {
    const key = `${kind}:${detail}`;
    let entry = this.#blockers.get(key);
    if (!entry) {
      if (this.#blockers.size >= MAX_BLOCKERS) return;
      entry = { kind, detail: detail.slice(0, 200), pages: new Set() };
      this.#blockers.set(key, entry);
    }
    entry.pages.add(page);
  }

  #noteInlineScript(body: string): void {
    this.#hashes.add(inlineScriptHash(body));
    if (
      this.#originBound.size < MAX_ORIGIN_BOUND_SCRIPTS &&
      this.#originForms.some((form) => body.includes(form))
    ) {
      this.#originBound.add(body);
    }
  }

  #openTag(name: string, a: Readonly<Record<string, string>>, path: string, inMedia: boolean) {
    for (const attr of Object.keys(a)) {
      if (/^on[a-z]{3,}$/.test(attr) && attr !== "once" && !name.includes("-")) {
        this.#blocker("inline-handler", attr, path);
      }
    }
    for (const attr of ["href", "src", "action", "formaction"]) {
      if (/^\s*javascript:/i.test(a[attr] ?? "")) this.#blocker("javascript-url", name, path);
    }
    if (a.style) this.#css(a.style);
    switch (name) {
      case "script":
        // A data block fetches and runs nothing.
        if (!EXECUTABLE_SCRIPT_TYPES.has((a.type ?? "").trim().toLowerCase())) break;
        if (/^\s*data:/i.test(a.src ?? ""))
          this.#blocker("data-script", "<script src=data:>", path);
        else this.#source("script", a.src);
        break;
      case "link": {
        const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
        if (rel.includes("stylesheet")) this.#source("style", a.href);
        else if (rel.includes("icon")) this.#source("img", a.href);
        else if (rel.includes("modulepreload")) this.#source("script", a.href);
        else if (rel.includes("preload")) {
          const kinds: Readonly<Record<string, CspSourceKind>> = {
            script: "script",
            style: "style",
            font: "font",
            image: "img",
            video: "media",
            audio: "media",
          };
          const kind = kinds[(a.as ?? "").toLowerCase()];
          if (kind) this.#source(kind, a.href);
        }
        break;
      }
      case "img":
        this.#source("img", a.src);
        this.#srcset("img", a.srcset);
        break;
      case "source":
        this.#source(inMedia ? "media" : "img", a.src);
        this.#srcset("img", a.srcset);
        break;
      case "video":
        this.#source("media", a.src);
        this.#source("img", a.poster);
        break;
      case "audio":
      case "track":
        this.#source("media", a.src);
        break;
      case "iframe":
        this.#source("frame", a.src);
        break;
      case "embed":
      case "object": {
        const url = a.src ?? a.data ?? "";
        if (url.length > 0) this.#objects.add(this.#originOf(url) ?? "'self'");
        break;
      }
      case "form":
        this.#source("form", a.action);
        break;
      case "button":
      case "input":
        this.#source("form", a.formaction);
        break;
      case "image":
        this.#source("img", a.href ?? a["xlink:href"]);
        break;
      case "base": {
        const origin = this.#originOf(a.href ?? "");
        if (origin !== null && origin !== this.#selfOrigin) {
          this.#blocker("foreign-base", origin, path);
        }
        break;
      }
    }
  }

  /** Read one finished page. */
  scanPage(html: string, path: string): void {
    // An incremental build's previous blockers: this page says anew.
    for (const entry of this.#blockers.values()) entry.pages.delete(path);
    let raw: { tag: string; attribs: Record<string, string>; text: string } | null = null;
    let mediaDepth = 0;
    const parser = new Parser(
      {
        onopentag: (name, attribs) => {
          this.#openTag(name, attribs, path, mediaDepth > 0);
          if (name === "video" || name === "audio") mediaDepth += 1;
          if (name === "script" || name === "style") raw = { tag: name, attribs, text: "" };
        },
        ontext: (text) => {
          if (raw) raw.text += text;
        },
        onclosetag: (name) => {
          if (name === "video" || name === "audio") mediaDepth -= 1;
          if (raw?.tag === name) {
            this.#closeRaw(raw);
            raw = null;
          }
        },
      },
      { decodeEntities: false },
    );
    parser.write(html);
    parser.end();
  }

  #closeRaw(el: {
    readonly tag: string;
    readonly attribs: Record<string, string>;
    readonly text: string;
  }): void {
    if (el.tag === "style") {
      this.#css(el.text);
      return;
    }
    if (el.attribs.src !== undefined || el.text.length === 0) return;
    // A withheld module's script: the consent runtime runs its decoded text inline.
    if (el.attribs["data-caelo-deferred-script"] !== undefined) {
      if (el.attribs["data-caelo-encoding"] === "base64") {
        // Base64 hides the origin from staging's rewrite, so one hash holds there too.
        this.#hashes.add(inlineScriptHash(Buffer.from(el.text, "base64").toString("utf8")));
      } else {
        this.#noteInlineScript(el.text);
      }
      return;
    }
    const type = (el.attribs.type ?? "").trim().toLowerCase();
    if (EXECUTABLE_SCRIPT_TYPES.has(type)) this.#noteInlineScript(el.text);
  }

  /** Take in what a plugin says its client code reaches. */
  addPlugin(slug: string, sources: PluginCspSources): void {
    const origins = new Set<string>();
    for (const kind of CSP_SOURCE_KINDS) {
      for (const origin of sources.origins?.[kind] ?? []) {
        this.#note(kind, origin);
        origins.add(origin);
      }
    }
    for (const body of sources.inlineScripts ?? []) this.#noteInlineScript(body);
    this.#plugins.push({
      slug,
      origins: [...origins].sort(),
      inlineScripts: sources.inlineScripts?.length ?? 0,
    });
  }

  /** Take in the facts of a previous build: an incremental build sees only its changed pages. */
  addPrevious({ facts, blockers }: PreviousCspScan): void {
    for (const kind of CSP_SOURCE_KINDS) {
      for (const origin of facts.origins[kind] ?? []) this.#note(kind, origin);
    }
    for (const origin of facts.objectOrigins) this.#objects.add(origin);
    for (const hash of facts.inlineScriptHashes) this.#hashes.add(hash);
    for (const body of facts.originBoundScripts) this.#originBound.add(body);
    for (const blocker of blockers) {
      this.#blockers.set(`${blocker.kind}:${blocker.detail}`, {
        ...blocker,
        pages: new Set(blocker.pages),
      });
    }
  }

  /** Every blocker with all its pages, for the next incremental build. */
  blockerPages(): z.infer<typeof blockerPagesSchema> {
    return [...this.#blockers.values()]
      .filter((b) => b.pages.size > 0)
      .map((b) => ({ ...b, pages: [...b.pages] }));
  }

  /** What the build ships. */
  facts(): SiteCspFacts {
    const origins: SiteCspFacts["origins"] = {};
    for (const [kind, set] of this.#origins) origins[kind] = [...set].sort();
    return {
      origins,
      inlineScriptHashes: [...this.#hashes].sort(),
      objectOrigins: [...this.#objects].sort(),
      originBoundScripts: [...this.#originBound].sort(),
      blockers: [...this.#blockers.values()]
        .filter((b) => b.pages.size > 0)
        .map((b) => ({
          kind: b.kind,
          detail: b.detail,
          pages: [...b.pages].slice(0, MAX_BLOCKER_PAGES),
          pageCount: b.pages.size,
        })),
      plugins: this.#plugins,
    };
  }
}

/** What the last build for an `outDir` found. */
export interface PreviousCspScan {
  readonly facts: SiteCspFacts;
  readonly blockers: z.infer<typeof blockerPagesSchema>;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** What the last build for `outDir` left, or null when it left no complete scan. */
export async function readPreviousCspScan(outDir: string): Promise<PreviousCspScan | null> {
  const set = await readIfPresent(join(outDir, SECURITY_HEADERS_BUILD_FILE));
  const blockers = await readIfPresent(join(outDir, BLOCKER_PAGES_FILE));
  if (set === null || blockers === null) return null;
  return {
    facts: parseSiteHeaderSet(set).facts,
    blockers: blockerPagesSchema.parse(JSON.parse(blockers)),
  };
}

/** Leave this build's scan for the next incremental build. */
export async function writeCspScan(
  outDir: string,
  setJson: string,
  scanner: CspScanner,
): Promise<void> {
  await writeFile(join(outDir, SECURITY_HEADERS_BUILD_FILE), setJson, "utf8");
  await writeFile(join(outDir, BLOCKER_PAGES_FILE), JSON.stringify(scanner.blockerPages()), "utf8");
}
