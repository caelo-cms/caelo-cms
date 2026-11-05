// SPDX-License-Identifier: MPL-2.0

/**
 * #1240 — what an operator reads about links that stop Publish live, and
 * what the AI reads about the same links.
 *
 * Three moments show one list, built here: the click that publishes a page
 * (`links.publish_notice`), a Stage (recorded on its run), and the
 * Publish-live refusal of that Stage. It is grouped by target page, because
 * that is what gets fixed: "Pricing has no English version — linked from the
 * header and a page section of /en/". Pages are named by title and path, the
 * language by name, the place in the operator's words. Tool names appear
 * only in {@link LinkNotice.aiText} (CLAUDE.md §1A, §11).
 */

import { z } from "zod";
import type { ReferenceIssue, ReferenceProblem } from "./reference-integrity.js";

/** How many targets a notice's sentence names (the count is always exact). */
const TARGETS_LISTED = 10;
/** How many linking pages one target's sentence names. */
const PAGES_LISTED = 3;

const linkNoticeTarget = z
  .object({
    /** The linked page; null when it is gone or the target is no page. */
    pageId: z.string().uuid().nullable(),
    /** The page's title, or what is gone ("a deleted page"). */
    title: z.string(),
    /** The page's path; null when there is none. */
    path: z.string().nullable(),
    problem: z.string(),
    /** The language the link needs (a locale code); null for other problems. */
    variant: z.string().nullable(),
    /** Where it is linked from, in the operator's words. */
    areas: z.array(z.string()),
    /** The paths of the pages carrying the link. */
    linkedFrom: z.array(z.string()),
  })
  .strict();
export type LinkNoticeTarget = z.infer<typeof linkNoticeTarget>;

/** A notice, as stored on a Stage's run and handed to every surface. */
export const linkNoticeSchema = z
  .object({
    targets: z.array(linkNoticeTarget),
    /** The published pages carrying the links ("Back to draft" takes them). */
    linkingPages: z.array(z.object({ id: z.string().uuid(), path: z.string() }).strict()),
    /** For the operator: no tool names, ids or technical place names. */
    operatorText: z.string(),
    /** For the AI: the same list and the tools that fix it. */
    aiText: z.string(),
    /** The action's label ("Create English versions"). */
    fixLabel: z.string(),
    /** What that action puts into the chat composer for the operator to send. */
    fixPrompt: z.string(),
  })
  .strict();
export type LinkNotice = z.infer<typeof linkNoticeSchema>;

/** What a notice needs to know about a page. */
export interface NoticePage {
  readonly title: string;
  readonly path: string;
}

/** The language's English name (`en` → `English`); the code when it has none. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language", fallback: "code" }).of(code) ?? code;
  } catch {
    // Not a BCP-47 tag: a plugin's variant token need not be a language.
    return code;
  }
}

const GONE: Partial<Record<ReferenceProblem, string>> = {
  "missing-target": "a deleted page",
  "missing-list": "a deleted list",
  "missing-term": "a removed vocabulary entry",
  "missing-module": "a deleted section",
};

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function targetName(t: LinkNoticeTarget): string {
  return t.path === null ? t.title : `${t.title} (${t.path})`;
}

/** @param headed the sentence's head already says what is wrong. */
function targetLine(t: LinkNoticeTarget, headed: boolean): string {
  const pages = t.linkedFrom.slice(0, PAGES_LISTED);
  const more = t.linkedFrom.length - pages.length;
  const on =
    pages.length === 0
      ? ""
      : ` of ${listWords(more > 0 ? [...pages, `${more} more page(s)`] : pages)}`;
  const from = `linked from ${listWords(t.areas)}${on}`;
  if (headed) return `${targetName(t)}, ${from}`;
  if (t.problem === "variant-missing") {
    return `${targetName(t)} has no ${languageName(t.variant ?? "")} version — ${from}`;
  }
  if (t.problem === "unpublished-target") return `${targetName(t)} is a draft — ${from}`;
  return `${t.title} — ${from}`;
}

/** The sentence and actions of a notice, from its targets. */
export function renderLinkNotice(
  targets: readonly LinkNoticeTarget[],
  linkingPages: LinkNotice["linkingPages"],
): LinkNotice {
  const languages = [...new Set(targets.map((t) => t.variant))];
  const oneLanguage =
    languages.length === 1 && targets.every((t) => t.problem === "variant-missing")
      ? languageName(languages[0] ?? "")
      : null;
  const shown = targets
    .slice(0, TARGETS_LISTED)
    .map((t) => targetLine(t, oneLanguage !== null))
    .join("; ");
  const more =
    targets.length > TARGETS_LISTED ? `; and ${targets.length - TARGETS_LISTED} more` : "";
  const head =
    oneLanguage !== null
      ? `${targets.length === 1 ? "1 page" : `${targets.length} pages`} linked from your ${oneLanguage} pages ${targets.length === 1 ? "has" : "have"} no ${oneLanguage} version yet`
      : `${targets.length} link target(s) need attention`;
  const tail =
    oneLanguage !== null
      ? `Publish live stays blocked until each has a version in ${oneLanguage} or the link is changed, and the site is staged again.`
      : "Publish live stays blocked until each link is fixed and the site is staged again.";
  const operatorText = `${head}: ${shown}${more}. ${tail}`;
  const steps: string[] = [];
  if (targets.some((t) => t.problem === "variant-missing")) {
    steps.push(
      "give each page the missing language version (create_variant, then translate_variant; list_pages shows the pages) or point the link at a page in that language",
    );
  }
  if (targets.some((t) => t.problem === "unpublished-target")) {
    steps.push("publish each draft (set_pages_status_many) or change the link");
  }
  if (targets.some((t) => t.problem !== "variant-missing" && t.problem !== "unpublished-target")) {
    steps.push("point the link at something that exists or remove it");
  }
  const named = listWords(targets.slice(0, TARGETS_LISTED).map(targetName));
  return {
    targets: [...targets],
    linkingPages: [...linkingPages],
    operatorText,
    aiText: `${operatorText} Next step: ${steps.join("; ")}; check_links with for: "publish" names the exact field of every link. Then stage_changes.`,
    fixLabel: oneLanguage !== null ? `Create ${oneLanguage} versions` : "Fix these links",
    fixPrompt:
      oneLanguage !== null
        ? `Create ${oneLanguage} versions of these pages so the links on the ${oneLanguage} pages work: ${named}.`
        : `Fix the links that block Publish live: ${shown}.`,
  };
}

/**
 * Group issues by what gets fixed. Returns null when there are none.
 *
 * @param pages the scope's pages (the targets and the linking pages).
 */
export function buildLinkNotice(
  issues: readonly ReferenceIssue[],
  pages: ReadonlyMap<string, NoticePage>,
): LinkNotice | null {
  if (issues.length === 0) return null;
  const groups = new Map<
    string,
    { areas: Set<string>; from: Set<string>; first: ReferenceIssue }
  >();
  const linking = new Map<string, string>();
  for (const i of issues) {
    const key = `${i.problem}\u0000${i.targetPageId ?? i.target}\u0000${i.variant ?? ""}`;
    const g = groups.get(key) ?? { areas: new Set(), from: new Set(), first: i };
    g.areas.add(i.area);
    for (const id of i.pageIds) {
      const page = pages.get(id);
      if (!page) continue;
      g.from.add(page.path);
      linking.set(id, page.path);
    }
    groups.set(key, g);
  }
  const targets = [...groups.values()].map(({ areas, from, first }): LinkNoticeTarget => {
    const page = first.targetPageId === null ? undefined : pages.get(first.targetPageId);
    return {
      pageId: page ? first.targetPageId : null,
      title: page?.title ?? GONE[first.problem] ?? first.target,
      path: page?.path ?? null,
      problem: first.problem,
      variant: first.variant,
      areas: [...areas].sort(),
      linkedFrom: [...from].sort(),
    };
  });
  return renderLinkNotice(
    targets,
    [...linking].map(([id, path]) => ({ id, path })),
  );
}

/** One link the staging build rendered into another language (generator output). */
export const crossVariantLinkSchema = z
  .object({
    /** The page carrying the link. */
    pageId: z.string().uuid(),
    pagePath: z.string(),
    /** The linked page, the URL the link renders as, and the language it lacks. */
    targetPageId: z.string().uuid(),
    targetUrl: z.string(),
    variant: z.string(),
  })
  .strict();
export type CrossVariantLink = z.infer<typeof crossVariantLinkSchema>;

/** Links the build rendered that the reference check did not report. */
export function linksTheCheckMissed(
  notice: LinkNotice | null,
  built: readonly CrossVariantLink[],
): CrossVariantLink[] {
  const known = new Set(notice?.targets.map((t) => `${t.pageId}\u0000${t.variant}`) ?? []);
  return built.filter((l) => !known.has(`${l.targetPageId}\u0000${l.variant}`));
}

/**
 * The notice of what a Stage actually shipped: the check's notice plus any
 * link only the build saw. The build is the truth about its own files, so
 * Publish live refuses those too; the check missing them is a Caelo bug the
 * caller reports.
 */
export function withBuiltLinks(
  notice: LinkNotice | null,
  missed: readonly CrossVariantLink[],
): LinkNotice | null {
  if (missed.length === 0) return notice;
  const targets = new Map<string, LinkNoticeTarget>();
  for (const l of missed) {
    const key = `${l.targetPageId}\u0000${l.variant}`;
    const t: LinkNoticeTarget = targets.get(key) ?? {
      pageId: l.targetPageId,
      title: `The page at ${l.targetUrl}`,
      path: null,
      problem: "variant-missing",
      variant: l.variant,
      areas: ["a place on the page"],
      linkedFrom: [],
    };
    targets.set(key, {
      ...t,
      linkedFrom: [...new Set([...t.linkedFrom, l.pagePath])].sort(),
    });
  }
  const linking = new Map((notice?.linkingPages ?? []).map((p) => [p.id, p.path]));
  for (const l of missed) linking.set(l.pageId, l.pagePath);
  return renderLinkNotice(
    [...(notice?.targets ?? []), ...targets.values()],
    [...linking].map(([id, path]) => ({ id, path })),
  );
}
