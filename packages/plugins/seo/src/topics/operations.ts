// SPDX-License-Identifier: MPL-2.0

/**
 * Curated topic pages and internal links (#1759): the page-output
 * observer that keeps the index, and the AI's tools — which terms carry
 * enough articles for a topic page, which terms are one topic spelt twice
 * (merged by core in one call), which pages a page should link to.
 */

import {
  type PageOutputObserverArgs,
  type PluginContextTier1,
  type PluginToolSpec,
  z,
} from "@caelo-cms/plugin-sdk";
import {
  linkGraph,
  linkSuggestions,
  nearDuplicates,
  type TermInfo,
  termCounts,
  termUse,
} from "./analysis.js";
import { allIndexedPages, observePageOutput } from "./page-index.js";

type Ctx = PluginContextTier1;

/** The page-output observer's operation. */
export const OBSERVE_OPERATION = "observe_pages";

function cmsOf(ctx: Ctx) {
  if (!ctx.cms) throw new Error("seo: reading the site's vocabularies needs the cms_admin grant");
  return ctx.cms;
}

interface ListItemRead {
  readonly id: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly children?: readonly ListItemRead[];
}

/** A vocabulary as the tools read it: its terms, flattened. */
export interface Vocabulary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly terms: readonly TermInfo[];
}

const PAGE_REF_RE = /^caelo:page\/([0-9a-f-]{36})$/i;

/** A term with its overview link as stored: a page reference, a path, or none. */
interface RawTerm {
  readonly itemId: string;
  readonly name: string;
  readonly href: string | null;
}

function flatten(items: readonly ListItemRead[], out: RawTerm[] = []): RawTerm[] {
  for (const item of items) {
    const name = typeof item.values.name === "string" ? item.values.name : "";
    const landing = item.values.landing_page as { href?: unknown } | undefined;
    const href = typeof landing?.href === "string" && landing.href !== "" ? landing.href : null;
    out.push({ itemId: item.id, name, href });
    flatten(item.children ?? [], out);
  }
  return out;
}

/** Every vocabulary of the site with its terms (the caller's view). */
export async function readVocabularies(ctx: Ctx): Promise<Vocabulary[]> {
  const cms = cmsOf(ctx);
  const r = await cms.call<
    { role: "vocabulary"; includeItems: true },
    { lists: { id: string; slug: string; name: string; items?: ListItemRead[] }[] }
  >("lists.list", { role: "vocabulary", includeItems: true });
  const lists = r.lists.map((l) => ({ ...l, raw: flatten(l.items ?? []) }));
  // A term's overview link is stored as a page reference (internal links are
  // references, docs/internal-links.md); the tools name the page by its path.
  const ids = [
    ...new Set(
      lists.flatMap((l) =>
        l.raw.flatMap((t) => {
          const m = t.href ? PAGE_REF_RE.exec(t.href) : null;
          return m ? [(m[1] as string).toLowerCase()] : [];
        }),
      ),
    ),
  ];
  const pages =
    ids.length === 0
      ? []
      : (
          await cms.call<
            { includeDeleted: false; pageIds: string[] },
            { pages: { id: string; currentPath: string }[] }
          >("pages.list", { includeDeleted: false, pageIds: ids })
        ).pages;
  const pathOf = new Map(pages.map((p) => [p.id.toLowerCase(), p.currentPath]));
  const resolve = (href: string | null): Pick<TermInfo, "topicPage" | "topicPageId"> => {
    const m = href ? PAGE_REF_RE.exec(href) : null;
    if (m) {
      const id = (m[1] as string).toLowerCase();
      // A deleted overview page leaves the term without one.
      const path = pathOf.get(id);
      return path === undefined
        ? { topicPage: null, topicPageId: null }
        : { topicPage: path, topicPageId: id };
    }
    return href?.startsWith("/")
      ? { topicPage: href, topicPageId: null }
      : { topicPage: null, topicPageId: null };
  };
  return lists.map((l) => ({
    id: l.id,
    slug: l.slug,
    name: l.name,
    terms: l.raw.map((t) => ({ itemId: t.itemId, name: t.name, ...resolve(t.href) })),
  }));
}

/** The topic-page threshold from the settings. */
async function threshold(ctx: Ctx): Promise<number> {
  const v = (await ctx.config?.get())?.topic_page_threshold;
  if (typeof v !== "number") throw new Error("seo: its setting topic_page_threshold is missing");
  return v;
}

/** The observer (core's `pageOutputObserver`). */
export async function observePages(ctx: Ctx, raw: unknown): Promise<{ ok: true }> {
  await observePageOutput(ctx, raw as PageOutputObserverArgs);
  return { ok: true };
}

const termsInput = z.object({ vocabulary: z.string().min(1).max(64).optional() }).strict();

/** `list_topic_terms`. */
export async function listTopicTerms(ctx: Ctx, raw: unknown) {
  const { vocabulary } = termsInput.parse(raw ?? {});
  const [vocabularies, rows, min] = await Promise.all([
    readVocabularies(ctx),
    allIndexedPages(ctx),
    threshold(ctx),
  ]);
  const chosen = vocabulary ? vocabularies.filter((v) => v.slug === vocabulary) : vocabularies;
  if (vocabulary && chosen.length === 0) {
    throw new Error(
      `no vocabulary "${vocabulary}" (vocabularies: ${vocabularies.map((v) => v.slug).join(", ") || "none"})`,
    );
  }
  return {
    threshold: min,
    basis: "published pages of the last Stage",
    vocabularies: chosen.map((v) => {
      const use = termUse(v.terms, termCounts(rows, v.slug), min);
      return {
        slug: v.slug,
        name: v.name,
        terms: use,
        nearDuplicates: nearDuplicates(use).map((g) => ({
          terms: g.terms.map((t) => ({ itemId: t.itemId, name: t.name, pages: t.pages })),
          mergeInto: g.into.itemId,
          reason: g.reason,
        })),
      };
    }),
  };
}

const mergeInput = z
  .object({
    vocabulary: z.string().min(1).max(64),
    merges: z
      .array(
        z
          .object({
            from: z.array(z.string().min(1).max(200)).min(1).max(20),
            into: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

/**
 * `merge_terms`: resolve term names to ids, then core's `lists.merge_terms`
 * re-tags every page, removes the merged terms and redirects a merged
 * term's topic page, in one transaction (a draft change of the chat).
 */
export async function mergeTerms(ctx: Ctx, raw: unknown) {
  const input = mergeInput.parse(raw);
  const vocab = (await readVocabularies(ctx)).find((v) => v.slug === input.vocabulary);
  if (!vocab) throw new Error(`no vocabulary "${input.vocabulary}"`);
  const idOf = (ref: string): string => {
    const t =
      vocab.terms.find((x) => x.itemId === ref) ?? vocab.terms.filter((x) => x.name === ref);
    if (!Array.isArray(t)) return t.itemId;
    if (t.length === 1) return (t[0] as TermInfo).itemId;
    throw new Error(
      t.length === 0
        ? `vocabulary "${vocab.slug}" has no term "${ref}" (list_topic_terms names them)`
        : `vocabulary "${vocab.slug}" has ${t.length} terms named "${ref}"; name it by its itemId`,
    );
  };
  return cmsOf(ctx).call("lists.merge_terms", {
    list: vocab.slug,
    merges: input.merges.map((m) => ({ from: m.from.map(idOf), into: idOf(m.into) })),
  });
}

const linksInput = z.object({ page: z.string().min(1).max(2048) }).strict();

/** `suggest_internal_links`. */
export async function suggestInternalLinks(ctx: Ctx, raw: unknown) {
  const { page } = linksInput.parse(raw);
  const [rows, vocabularies, defaults] = await Promise.all([
    allIndexedPages(ctx),
    readVocabularies(ctx),
    cmsOf(ctx).call<Record<string, never>, { defaults: { rootPageId: string | null } | null }>(
      "site_defaults.get",
      {},
    ),
  ]);
  const ref = page.replace(/^caelo:page\//, "");
  const path = ref.length > 1 ? ref.replace(/\/$/, "") : ref;
  const row = rows.find((r) => r.page_id === ref || r.path === path || r.path === `${path}/`);
  if (!row) {
    throw new Error(
      `"${page}" is not a published page of the last Stage: suggestions read the published site; Stage first, or name a published page by path or id`,
    );
  }
  const graph = linkGraph(rows, defaults.defaults?.rootPageId ?? null);
  const names = new Map(
    vocabularies.flatMap((v) => v.terms.map((t) => [`${v.slug}/${t.itemId}`, t.name] as const)),
  );
  return {
    basis: "published pages of the last Stage; links in the layout (menus, footer) are not counted",
    page: {
      path: row.path,
      inbound: graph.inbound.get(row.page_id) ?? 0,
      clickDepth: graph.depth.get(row.page_id) ?? null,
    },
    suggestions: linkSuggestions(rows, row, graph, (v, id) => names.get(`${v}/${id}`) ?? null),
  };
}

/** The topic and link tools. */
export const TOPIC_TOOLS: readonly PluginToolSpec[] = [
  {
    name: "list_topic_terms",
    description:
      "The terms (tags, categories) of the site's vocabularies with how many published pages carry each, whether it has a topic page, which terms deserve one (suggestTopicPage: enough pages, none yet) and which look like one topic spelt twice (nearDuplicates, with the term to keep).\nUSE FOR: deciding which topic pages to build; cleaning up a vocabulary before merge_terms.\nDO NOT USE FOR: editing terms themselves (patch_list_items_many).\nCounts are the published site of the last Stage.",
    operationName: "list_topic_terms",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        vocabulary: { type: "string", description: "One vocabulary's slug; omitted = all." },
      },
    },
  },
  {
    name: "merge_terms",
    description:
      "Merge terms that are one topic into one, in one call: every page carrying a `from` term gets the `into` term, the `from` terms leave the vocabulary, and a `from` term's topic page is redirected to the `into` term's (or becomes it, when `into` has none). A draft change of this chat.\nUSE FOR: the nearDuplicates of list_topic_terms, after the operator agreed.\nDO NOT USE FOR: renaming one term (patch_list_items_many).",
    operationName: "merge_terms",
    requiredPermission: "content.write",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["vocabulary", "merges"],
      properties: {
        vocabulary: { type: "string", description: "The vocabulary's slug (`tags`)." },
        merges: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["from", "into"],
            properties: {
              from: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
                description: "Terms to merge away, by name or itemId.",
              },
              into: { type: "string", description: "The term to keep, by name or itemId." },
            },
          },
        },
      },
    },
  },
  {
    name: "suggest_internal_links",
    description:
      "Pages one page should link to, each with its reasons (shared terms, same page type, few pages linking to it), plus how many pages link to the page and how many clicks it is from the home page.\nUSE FOR: after writing or before revising an article; finding pages nobody links to.\nDO NOT USE FOR: broken links (the Stage's links check).\nRead from the published site of the last Stage; links in menus and footers are not counted.",
    operationName: "suggest_internal_links",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["page"],
      properties: {
        page: { type: "string", description: "The page's path (`/blog/json-ld`) or id." },
      },
    },
  },
];
