// SPDX-License-Identifier: MPL-2.0

/**
 * Stage readiness — what a staging build would refuse, told BEFORE the
 * AI calls `stage_changes`.
 *
 * A staging build refuses three site states (each check is correct and
 * stays where it is — CLAUDE.md §2):
 *
 *   - a published page without a meta description (deploy/missing-seo.ts,
 *     run by `deploy.trigger` before the generator);
 *   - zero published pages ("nothing to serve", static-generator
 *     `zeroPageBuildError`);
 *   - no published page at the site root '/' (static-generator
 *     `missingRootPageError`).
 *
 * The AI used to learn them only from the failed Stage (e2e-livedit:
 * ~100 failed `stage_changes` per 14 runs). The state behind them is
 * mostly not the AI's own work — a homepage the operator left as a draft,
 * an older page published before descriptions were required — so no
 * amount of prompt text about its own pages can prevent it. This module
 * computes the same three conditions on the chat's view of the site, and
 * the AI hears them at the start of the turn (the site-status note) and in
 * the results of the page tools, with the exact call that fixes each one.
 *
 * Advisory only: the build's own checks stay the gate. The view is the
 * chat's (main + the shared draft), so it is what a Stage of the draft
 * would build.
 */

import { z } from "zod";

/** How many pages a readiness note names per condition (counts stay exact). */
export const STAGE_READINESS_PAGES_LISTED = 10;

/** One page as the readiness check sees it. */
export interface StageReadinessPage {
  readonly id: string;
  readonly title: string;
  /** The page's public path in the chat's view ('/' is the site root). */
  readonly path: string;
  readonly status: "draft" | "published";
  /** A non-blank meta description is stored. */
  readonly hasMetaDescription: boolean;
}

const readinessPageRef = z.object({ id: z.string(), title: z.string(), path: z.string() });

/** The op output: what a Stage would refuse right now. */
export const stageReadinessSchema = z.object({
  /** True when none of the build's refusals applies. */
  ready: z.boolean(),
  publishedCount: z.number().int().nonnegative(),
  /** Nothing is published: the build has nothing to serve. */
  nothingPublished: z.boolean(),
  /** No published page serves '/'. */
  rootMissing: z.boolean(),
  /** The page at '/' when it exists but is a draft. */
  draftRootPage: readinessPageRef.nullable(),
  /**
   * Pages the build would ship without a meta description — the published
   * ones plus the draft homepage this note tells the AI to publish.
   */
  missingMetaDescription: z.object({
    count: z.number().int().nonnegative(),
    pages: z.array(readinessPageRef),
  }),
  /** Draft pages, named when nothing is published (count exact). */
  draftPages: z.object({
    count: z.number().int().nonnegative(),
    pages: z.array(readinessPageRef),
  }),
});
export type StageReadiness = z.infer<typeof stageReadinessSchema>;

const isRoot = (path: string): boolean => path.replace(/^\/+|\/+$/g, "").length === 0;
const ref = (p: StageReadinessPage) => ({ id: p.id, title: p.title, path: p.path });

/**
 * Compute what a staging build of these pages would refuse. Pure — the op
 * feeds it the chat's view of the pages.
 *
 * @param pages - every live (not deleted) page in the chat's view.
 */
export function assessStageReadiness(pages: readonly StageReadinessPage[]): StageReadiness {
  const published = pages.filter((p) => p.status === "published");
  const drafts = pages.filter((p) => p.status === "draft");
  const rootMissing = !published.some((p) => isRoot(p.path));
  const draftRoot = rootMissing ? (drafts.find((p) => isRoot(p.path)) ?? null) : null;
  // The draft homepage is about to be published (the note says so), and
  // then the description check refuses it too — name it now, not one
  // failed Stage later.
  const needsMeta = [...published, ...(draftRoot ? [draftRoot] : [])].filter(
    (p) => !p.hasMetaDescription,
  );
  const nothingPublished = published.length === 0;
  return {
    ready: !rootMissing && needsMeta.length === 0 && !nothingPublished,
    publishedCount: published.length,
    nothingPublished,
    rootMissing,
    draftRootPage: draftRoot ? ref(draftRoot) : null,
    missingMetaDescription: {
      count: needsMeta.length,
      pages: needsMeta.slice(0, STAGE_READINESS_PAGES_LISTED).map(ref),
    },
    draftPages: {
      count: nothingPublished ? drafts.length : 0,
      pages: nothingPublished ? drafts.slice(0, STAGE_READINESS_PAGES_LISTED).map(ref) : [],
    },
  };
}

function listed(
  group: { count: number; pages: readonly { id: string; title: string; path: string }[] },
  withIds: boolean,
): string {
  const names = group.pages
    .map((p) => `'${p.title}' (${p.path}${withIds ? `, pageId ${p.id}` : ""})`)
    .join(", ");
  const more =
    group.count > group.pages.length ? ` and ${group.count - group.pages.length} more` : "";
  return `${names}${more}`;
}

/**
 * The AI-facing sentence for a readiness result, or null when a Stage
 * would build. Each condition names the tool call that clears it, so the
 * AI fixes everything in one pass before its single `stage_changes`.
 */
export function describeStageReadiness(r: StageReadiness): string | null {
  if (r.ready) return null;
  if (r.nothingPublished && r.draftPages.count === 0) {
    return "A Stage would be refused right now: the site has no pages yet, so a build has nothing to serve. Do not call stage_changes until the homepage exists — when the work includes pages, build the homepage first with build_page (slug 'home', status 'published', page.metaDescription).";
  }
  const steps: string[] = [];
  if (r.draftRootPage) {
    steps.push(
      `the homepage '${r.draftRootPage.title}' (/, pageId ${r.draftRootPage.id}) is a draft, so nothing serves the site root '/' — publish it with set_pages_status_many (and say so in your summary)`,
    );
  } else if (r.rootMissing && r.nothingPublished && r.draftPages.count > 0) {
    steps.push(
      `no page is at the site root '/' — designate the homepage with set_home_page({pageId}) (it keeps its slug; never rename another page to 'home'), then publish it`,
    );
  } else if (r.rootMissing) {
    steps.push(
      `none of the ${r.publishedCount} published page(s) serves the site root '/' — designate the homepage with set_home_page({pageId}) (it keeps its slug; never rename another page to 'home'), or build it, and make sure it is published`,
    );
  }
  if (r.nothingPublished && !r.draftRootPage) {
    steps.push(
      `no page is published, so the build has nothing to serve — publish the pages that belong on the site with set_pages_status_many (drafts: ${listed(r.draftPages, true)})`,
    );
  }
  if (r.missingMetaDescription.count > 0) {
    steps.push(
      `${r.missingMetaDescription.count} page(s) have no meta description: ${listed(r.missingMetaDescription, true)} — write each from the page's content (150–160 characters) with ONE autofill_page_seo_many call`,
    );
  }
  return `A Stage would be refused right now: ${steps.map((s, i) => `(${i + 1}) ${s}`).join("; ")}. Fix these before stage_changes.`;
}
