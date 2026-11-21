// SPDX-License-Identifier: MPL-2.0

/**
 * Page output for build observers (epic #1644, R1, issue #1647).
 *
 * With the `page_output` grant, a plugin declares one observer operation.
 * At every Stage, core calls it with the facts of the pages whose output
 * changed since the plugin last saw them, in batches of up to 200, and once
 * more at the end with the pages that are gone and the modules whose
 * placement count changed. Facts are read from the staged HTML exactly as
 * Publish live ships it; observers never see a chat branch.
 *
 * In an observer call a plugin may write only to its collections and its
 * private storage: never to a `published` table, which visitors would see
 * before Publish live.
 */

import { z } from "zod";

/** Where a module sits in a page's composition. */
export const PAGE_OUTPUT_ZONES = ["layout", "template", "page"] as const;
export type PageOutputZone = (typeof PAGE_OUTPUT_ZONES)[number];

/** One module placed on the page. */
export interface PageOutputModule {
  /** The module design id (`data-caelo-module-id`). */
  readonly moduleId: string;
  readonly name: string;
  /** The module's declared kind (`chrome | hero | content | cta | utility`), null when it has none. */
  readonly kind: string | null;
  /** Layout chrome, a template block, or a placement of the page itself. */
  readonly zone: PageOutputZone;
  /** The content instance the placement shows, null for a module without one. */
  readonly contentInstanceId: string | null;
  /** On how many published pages this module appears, counting every zone. */
  readonly placementCount: number;
}

/** One visible text run. */
export interface PageOutputText {
  readonly text: string;
  readonly moduleId: string | null;
  readonly listItem: string | null;
  readonly pluginSlug: string | null;
  /** `text`, a visible attribute (`alt`, `placeholder`, …), or `literal` (code, `translate="no"`). */
  readonly source: string;
  /** 1–6 when the run is inside a heading, else null. */
  readonly heading: number | null;
  /** The `id` of the nearest heading or section at or before the run: the link target of its section. */
  readonly anchor: string | null;
  /** True inside a `<form>`; field labels and buttons are form text. */
  readonly inForm: boolean;
}

/** One link of the page body. */
export interface PageOutputLink {
  readonly href: string;
  /** The site path it names, null for external links. */
  readonly path: string | null;
  /** The page it points at, when it names a page of this site. */
  readonly targetPageId: string | null;
  readonly text: string;
  readonly moduleId: string | null;
  /** The zone of the module it sits in, null outside every module. */
  readonly zone: PageOutputZone | null;
  readonly pluginSlug: string | null;
}

/** What one staged page shows. */
export interface PageOutputFacts {
  readonly pageId: string;
  readonly url: string;
  readonly path: string;
  readonly lang: string;
  readonly title: string;
  readonly shortTitle: string | null;
  readonly metaDescription: string | null;
  readonly pageType: string | null;
  /** Page-type properties as stored, by property key. */
  readonly properties: Readonly<Record<string, unknown>>;
  /** Vocabulary terms per vocabulary key. */
  readonly terms: Readonly<Record<string, readonly string[]>>;
  /** The titles of the page's breadcrumb trail, as its breadcrumbs show them (empty without breadcrumbs). */
  readonly breadcrumb: readonly string[];
  /** `<meta name="robots">` holds `noindex`. */
  readonly noindex: boolean;
  /** The site's 404 page. */
  readonly notFoundPage: boolean;
  /**
   * The page carries a module a plugin withholds (`data-caelo-deferred`) or
   * a baked plugin region: some visitors see different text. Core has no
   * login-protected pages; withheld content is what an observer can tell.
   */
  readonly hasDeferredContent: boolean;
  readonly modules: readonly PageOutputModule[];
  readonly texts: readonly PageOutputText[];
  readonly links: readonly PageOutputLink[];
  /** A digest of everything above; equal digests, equal facts. */
  readonly outputHash: string;
}

/** A module whose placement count changed since the plugin's last Stage. */
export interface PlacementChange {
  readonly moduleId: string;
  readonly before: number;
  readonly after: number;
}

/** What an observer operation is called with. */
export interface PageOutputObserverArgs {
  /** The Stage's deploy run. */
  readonly runId: string;
  /** Changed or new pages (empty on the final call). */
  readonly pages: readonly PageOutputFacts[];
  /** Pages the plugin saw before that this Stage no longer ships (final call only). */
  readonly removed: readonly string[];
  /** Placement counts that changed (final call only). */
  readonly placementChanges: readonly PlacementChange[];
  /** True on the last call of this Stage. */
  readonly final: boolean;
  /** Published pages in this Stage, for "more than half of all pages" rules. */
  readonly publishedPageCount: number;
}

/** Manifest form. */
export const pageOutputObserverManifest = z
  .object({
    /** The operation core calls; it must be in `operations`. */
    operation: z.string().min(1).max(120),
  })
  .strict();
export type PageOutputObserverManifest = z.infer<typeof pageOutputObserverManifest>;

/** Pages per observer call. */
export const PAGE_OUTPUT_BATCH = 200;
