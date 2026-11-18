// SPDX-License-Identifier: MPL-2.0

/**
 * What a Publish live changes for visitors, from two sources a build
 * already leaves behind (`deploy.publish_preview`):
 *
 *   - The render fingerprints of the two builds (#553): every staging
 *     build records one hash per published page, module, template, layout,
 *     the active theme, each active plugin and each rendered site setting.
 *     A page key only in the staged build is a new page, one only in the
 *     live build a removed page; a differing module, template, layout,
 *     theme or plugin is a site-wide change; a differing setting a setting.
 *   - The changes staged between the builds: every snapshot header a Stage
 *     merged carries `staged_at`, so the pages and parts a Stage changed
 *     after the live build started, and before the staged build started,
 *     are the content changes the fingerprint (code and structure only)
 *     does not see.
 *
 * A section design (module) or a section's content (content instance) is
 * counted where it shows (ops/content/part-where.ts): on one published
 * page it is a change of that page, on none it is not listed, on more it
 * is a site-wide change that says where it shows. Every placement holds
 * its own content instance, so most content changes are page changes.
 *
 * This file is the pure part: it sorts both into the groups the review
 * shows. Reading and labelling are the op's (ops/deploy-publish-preview.ts).
 */

import { describeWhere, type PartWhere, samplePathOf } from "../ops/content/part-where.js";

/** One entity whose fingerprint differs between the live and the staged build. */
export interface FingerprintChange {
  /** The fingerprint key's prefix: page, module, template, layout, theme, plugin, setting. */
  readonly kind: string;
  readonly id: string;
  /** added = only in the staged build; removed = only in the live build. */
  readonly change: "added" | "changed" | "removed";
}

/** An entity a Stage merged between the two builds (snapshot kind + id). */
export interface StagedEntity {
  /** page | module | template | layout | theme | list | listType | pageType | contentInstance | pluginRow */
  readonly kind: string;
  /** The entity; for pluginRow the plugin, so a plugin's data is one change. */
  readonly id: string;
}

/** A site-wide part going live. */
export interface SiteWideChange {
  readonly kind: string;
  readonly id: string;
  readonly change: "new" | "changed" | "removed";
  /** Where it shows ("on 4 pages", "in the site layout"); null for a kind that is site-wide by nature. */
  readonly shows: string | null;
  /** A page that shows it, to look at; null when it has none to name. */
  readonly samplePath: string | null;
}

/** The release, sorted into the review's groups (ids only; the op labels them). */
export interface ReleaseClassification {
  readonly newPageIds: readonly string[];
  readonly changedPageIds: readonly string[];
  readonly removedPageIds: readonly string[];
  readonly siteWide: readonly SiteWideChange[];
  /** `site_defaults` columns of rendered settings that differ. */
  readonly settings: readonly string[];
}

/** Fingerprint kinds that are site-wide parts (`setting` and `page` are their own groups). */
const FINGERPRINT_SITE_WIDE = new Set(["module", "template", "layout", "theme", "plugin"]);

/** Staged kinds that are site-wide parts. */
const STAGED_SITE_WIDE = new Set([
  "module",
  "template",
  "layout",
  "theme",
  "list",
  "listType",
  "pageType",
  "contentInstance",
  "pluginRow",
]);

const CHANGE_OF = { added: "new", changed: "changed", removed: "removed" } as const;

/** Kinds counted where they show ({@link PartWhere}) instead of as site-wide by nature. */
const PLACED_KINDS: ReadonlySet<string> = new Set(["module", "contentInstance"]);

/** A part whose placement decides its group. */
export interface PlacedPart {
  readonly kind: "module" | "contentInstance";
  readonly id: string;
}

/**
 * The parts of a release whose placement {@link classifyRelease} needs:
 * every new or changed module and every staged content instance. A module
 * only the live build has (removed) shows nowhere any more and stays a
 * removed site-wide part.
 */
export function placedPartsOfRelease(args: {
  readonly fingerprint: readonly FingerprintChange[];
  readonly staged: readonly StagedEntity[];
}): PlacedPart[] {
  const parts = new Map<string, PlacedPart>();
  const add = (kind: string, id: string) => {
    if (kind === "module" || kind === "contentInstance") parts.set(`${kind}:${id}`, { kind, id });
  };
  for (const f of args.fingerprint) if (f.change !== "removed") add(f.kind, f.id);
  for (const s of args.staged) add(s.kind, s.id);
  return [...parts.values()];
}

/**
 * Sort a release's differences into the review's groups.
 *
 * @param args.publishedInStaged - the pages the staged build publishes: a
 *   staged content change to a draft page does not go live, so it is not
 *   listed.
 * @param args.where - where each of {@link placedPartsOfRelease} shows,
 *   counting only published pages, keyed `<kind>:<id>`; a part missing
 *   from it is a caller bug and throws.
 */
export function classifyRelease(args: {
  readonly fingerprint: readonly FingerprintChange[];
  readonly staged: readonly StagedEntity[];
  readonly publishedInStaged: ReadonlySet<string>;
  readonly where: ReadonlyMap<string, PartWhere>;
}): ReleaseClassification {
  const newPages = new Set<string>();
  const changedPages = new Set<string>();
  const removedPages = new Set<string>();
  const siteWide = new Map<string, SiteWideChange>();
  const settings = new Set<string>();
  let theme: SiteWideChange | null = null;
  /** Parts shown on one page, attributed once the new and removed pages are known. */
  const onOnePage = new Set<string>();

  const addPart = (kind: string, id: string, change: SiteWideChange["change"]) => {
    const key = `${kind}:${id}`;
    if (siteWide.has(key)) return;
    if (!PLACED_KINDS.has(kind) || change === "removed") {
      siteWide.set(key, { kind, id, change, shows: null, samplePath: null });
      return;
    }
    const w = args.where.get(key);
    if (w === undefined) {
      throw new Error(`classifyRelease: no placement for ${key} (read placedPartsOfRelease first)`);
    }
    if (w.kind === "nowhere") return;
    if (w.kind === "page") {
      onOnePage.add(w.page.pageId);
      return;
    }
    siteWide.set(key, { kind, id, change, shows: describeWhere(w), samplePath: samplePathOf(w) });
  };

  for (const f of args.fingerprint) {
    if (f.kind === "page") {
      if (f.change === "added") newPages.add(f.id);
      else if (f.change === "removed") removedPages.add(f.id);
      else changedPages.add(f.id);
    } else if (f.kind === "setting") {
      settings.add(f.id);
    } else if (f.kind === "theme") {
      // Only the active theme is fingerprinted: switching themes is one
      // theme key removed and one added — one change for the operator,
      // named after the theme that goes live.
      if (theme === null || f.change === "added") {
        theme = { kind: "theme", id: f.id, change: "changed", shows: null, samplePath: null };
      }
    } else if (FINGERPRINT_SITE_WIDE.has(f.kind)) {
      addPart(f.kind, f.id, CHANGE_OF[f.change]);
    }
  }

  for (const s of args.staged) {
    if (s.kind === "page") {
      if (!args.publishedInStaged.has(s.id) || newPages.has(s.id) || removedPages.has(s.id)) {
        continue;
      }
      changedPages.add(s.id);
    } else if (s.kind === "theme") {
      theme ??= { kind: "theme", id: s.id, change: "changed", shows: null, samplePath: null };
    } else if (STAGED_SITE_WIDE.has(s.kind)) {
      addPart(s.kind, s.id, "changed");
    }
  }
  for (const pageId of onOnePage) {
    if (!newPages.has(pageId) && !removedPages.has(pageId)) changedPages.add(pageId);
  }

  return {
    newPageIds: [...newPages],
    changedPageIds: [...changedPages],
    removedPageIds: [...removedPages],
    siteWide: theme ? [...siteWide.values(), theme] : [...siteWide.values()],
    settings: [...settings],
  };
}

/** Split a fingerprint key `kind:id`. */
export function splitFingerprintKey(key: string): { kind: string; id: string } {
  const at = key.indexOf(":");
  return { kind: key.slice(0, at), id: key.slice(at + 1) };
}
