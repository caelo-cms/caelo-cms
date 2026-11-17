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
 * This file is the pure part: it sorts both into the groups the review
 * shows. Reading and labelling are the op's (ops/deploy-publish-preview.ts).
 */

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

/**
 * Sort a release's differences into the review's groups.
 *
 * @param args.publishedInStaged - the pages the staged build publishes: a
 *   staged content change to a draft page does not go live, so it is not
 *   listed.
 */
export function classifyRelease(args: {
  readonly fingerprint: readonly FingerprintChange[];
  readonly staged: readonly StagedEntity[];
  readonly publishedInStaged: ReadonlySet<string>;
}): ReleaseClassification {
  const newPages = new Set<string>();
  const changedPages = new Set<string>();
  const removedPages = new Set<string>();
  const siteWide = new Map<string, SiteWideChange>();
  const settings = new Set<string>();
  let theme: SiteWideChange | null = null;

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
        theme = { kind: "theme", id: f.id, change: "changed" };
      }
    } else if (FINGERPRINT_SITE_WIDE.has(f.kind)) {
      siteWide.set(`${f.kind}:${f.id}`, { kind: f.kind, id: f.id, change: CHANGE_OF[f.change] });
    }
  }

  for (const s of args.staged) {
    if (s.kind === "page") {
      if (!args.publishedInStaged.has(s.id) || newPages.has(s.id) || removedPages.has(s.id)) {
        continue;
      }
      changedPages.add(s.id);
    } else if (s.kind === "theme") {
      theme ??= { kind: "theme", id: s.id, change: "changed" };
    } else if (STAGED_SITE_WIDE.has(s.kind)) {
      const key = `${s.kind}:${s.id}`;
      if (!siteWide.has(key)) siteWide.set(key, { kind: s.kind, id: s.id, change: "changed" });
    }
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
