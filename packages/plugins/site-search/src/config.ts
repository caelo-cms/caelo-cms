// SPDX-License-Identifier: MPL-2.0

/**
 * The site search's configuration (epic #1644, issue #1651): what counts,
 * how results rank, the lists the operator (or the AI for them) keeps, and
 * the per-module and per-page settings. Everything here waits for a Stage
 * unless it says otherwise; a change to what counts makes the next Stage
 * read every page again (the host's observer digest).
 */

import type { ConfigFieldInput, ListTypeDef, PluginDefinition } from "@caelo-cms/plugin-sdk";

/** Slugs of the list types the plugin ships. */
export const LIST_TYPES = {
  synonyms: "site-search-synonyms",
  bestBets: "site-search-best-bets",
  suggestions: "site-search-suggestions",
  testQueries: "site-search-test-queries",
  protectedTerms: "site-search-protected-terms",
} as const;

const mode = (what: string): ConfigFieldInput => ({
  type: "enum",
  label: "Search mode",
  description: `How the text of this ${what} counts in the site search. auto: by how many pages it is on (Settings → Plugin settings → What counts); full: on every page; reduced: on every page, weighted down; home: only on its home page; never: not at all (its links still count as anchor text).`,
  effect: "pages",
  options: [
    { value: "auto", label: "Automatic" },
    { value: "full", label: "Counts fully" },
    { value: "reduced", label: "Counts reduced" },
    { value: "home", label: "Only on its home page" },
    { value: "never", label: "Never" },
  ],
  default: "auto",
});

/** The plugin's configuration schema. */
export const SITE_SEARCH_CONFIG: Readonly<Record<string, ConfigFieldInput>> = {
  results_page: {
    type: "pageRef",
    label: "Results page",
    description:
      "The page that shows the results (its form posts to it). It is never itself in the search; set it noindex and out of the sitemap.",
    effect: "pages",
    default: null,
  },
  counting: {
    type: "group",
    label: "What counts",
    description:
      "A block's text counts by how many pages it is on, so a footer on every page does not make every page match its words.",
    fields: {
      full_max: {
        type: "int",
        label: "Counts fully up to (pages)",
        description: "A module on at most this many pages counts fully on each of them.",
        effect: "pages",
        min: 1,
        max: 1000,
        default: 10,
      },
      reduced_max: {
        type: "int",
        label: "Counts reduced up to (pages)",
        description:
          "Above the full limit and up to this many pages, a module counts weighted down. Above it, or on more than half of all pages, it counts only on its home page.",
        effect: "pages",
        min: 2,
        max: 100_000,
        default: 49,
      },
      reduced_weight: {
        type: "number",
        label: "Weight of reduced text",
        description: "How much reduced text counts against a page's own text (1 = the same).",
        effect: "query",
        min: 0,
        max: 1,
        default: 0.3,
      },
      chrome_links: {
        type: "bool",
        label: "Navigation links describe their targets",
        description:
          "The words of header, menu and footer links count for the page they link to (anchor text), not for the page they sit on.",
        effect: "pages",
        default: true,
      },
    },
  },
  ranking: {
    type: "group",
    label: "Ranking",
    description: "How results are ordered.",
    fields: {
      page_type_weights: {
        type: "map",
        label: "Weight per page type",
        description:
          "Ranks pages of a type up (above 1) or down (below 1); 0 leaves the type out of the search.",
        effect: "query",
        keys: "pageType",
        value: {
          type: "number",
          label: "Weight",
          description: "1 = normal.",
          effect: "query",
          min: 0,
          max: 5,
          default: 1,
        },
        default: {},
      },
      title_weight: {
        type: "number",
        label: "Title weight",
        description: "How much a match in the title counts against one in the text.",
        effect: "query",
        min: 0,
        max: 10,
        default: 3,
      },
      anchor_weight: {
        type: "number",
        label: "Anchor text weight",
        description: "How much the words other pages link to a page with count for it.",
        effect: "query",
        min: 0,
        max: 10,
        default: 1.5,
      },
      typos: {
        type: "bool",
        label: "Tolerate typos",
        description: "Find 'Logfiel' for 'Logfile' (one letter off in short words, two in long ones).",
        effect: "query",
        default: true,
      },
      cross_language: {
        type: "bool",
        label: "Search every language",
        description:
          "Off: a visitor finds pages in the language of the page they search from. On: every language.",
        effect: "query",
        default: false,
      },
      results_per_page: {
        type: "int",
        label: "Results per page",
        description: "How many results one page of the results shows.",
        effect: "query",
        min: 5,
        max: 50,
        default: 10,
      },
    },
  },
  semantic: {
    type: "group",
    label: "Meaning-based search",
    description:
      "Also finds pages that say the same in other words (a small language model, run on the site's own servers; no text leaves them).",
    fields: {
      enabled: {
        type: "bool",
        label: "On",
        description: "Turning it on or changing the model rebuilds the index at the next Stage.",
        effect: "rebuild",
        default: false,
      },
      model: {
        type: "catalogModel",
        label: "Model",
        description: "An embedding model from Caelo's catalog.",
        effect: "rebuild",
        purpose: "embedding",
        default: null,
      },
      weight: {
        type: "number",
        label: "Weight against word matches",
        description: "How much meaning counts against the words themselves (1 = the same).",
        effect: "query",
        min: 0,
        max: 5,
        default: 1,
      },
    },
  },
  lists: {
    type: "group",
    label: "Lists",
    description:
      "The lists the search reads (Settings → Lists): synonyms, pinned results, start questions, test queries, protected words.",
    fields: {
      synonyms: {
        type: "listRef",
        label: "Synonyms",
        description: "Words that mean the same for the search.",
        effect: "query",
        listType: LIST_TYPES.synonyms,
        default: null,
      },
      best_bets: {
        type: "listRef",
        label: "Pinned results",
        description: "For a query, the pages shown first, in order.",
        effect: "query",
        listType: LIST_TYPES.bestBets,
        default: null,
      },
      suggestions: {
        type: "listRef",
        label: "Start questions",
        description: "What the empty search field offers.",
        effect: "query",
        listType: LIST_TYPES.suggestions,
        default: null,
      },
      test_queries: {
        type: "listRef",
        label: "Test queries",
        description:
          "Queries checked at every Stage: a pinned result that is not first blocks Publish live.",
        effect: "none",
        listType: LIST_TYPES.testQueries,
        default: null,
      },
      protected_terms: {
        type: "listRef",
        label: "Protected words",
        description: "Brand and product names the search never reduces to a stem.",
        effect: "rebuild",
        listType: LIST_TYPES.protectedTerms,
        default: null,
      },
    },
  },
  popular_suggestions: {
    type: "bool",
    label: "Suggest what visitors search for",
    description:
      "Counts submitted searches (text, language, day and number of results; no address, no visitor id, no cookie) and offers queries asked often (5 times on 3 days within 30 days, with results) once they are approved. Off: nothing is counted.",
    effect: "none",
    gate: "approval",
    default: false,
  },
  popular_moderation: {
    type: "enum",
    label: "Who approves a popular query",
    description:
      "ai: the AI approves a query only when it is clearly harmless, and rejects when in doubt; human: every query waits for a person.",
    effect: "none",
    options: [
      { value: "ai", label: "The AI, rejecting when in doubt" },
      { value: "human", label: "A person" },
    ],
    default: "ai",
  },
};

/** Per-entity settings: modules and content instances by mode, pages left out. */
export const SITE_SEARCH_ENTITY_CONFIG: NonNullable<PluginDefinition["entityConfig"]> = {
  module: {
    mode: mode("module"),
    home_page: {
      type: "pageRef",
      label: "Home page",
      description:
        "The page where a module on many pages counts (its products page for a product teaser, the contact page for an address footer).",
      effect: "pages",
      default: null,
    },
  },
  contentInstance: {
    mode: mode("shared content"),
  },
  page: {
    excluded: {
      type: "bool",
      label: "Not in the site search",
      description: "The page is never a result (its links still describe other pages).",
      effect: "pages",
      default: false,
    },
  },
};

const text = (name: string, label: string, required = false) =>
  ({ name, label, type: "text" as const, ...(required ? { required: true } : {}), maxLength: 200 }) as const;
const lang = { name: "lang", label: "Language (empty: every language)", type: "text", maxLength: 16 } as const;

/** The list types the plugin ships (owned by it, live while it runs). */
export const SITE_SEARCH_LIST_TYPES: readonly ListTypeDef[] = [
  {
    slug: LIST_TYPES.synonyms,
    name: "Site search synonyms",
    purpose:
      "Words the site search treats as the same. An entry lists words that stand for each other, or with one_way, a word that also finds the others (not back).",
    role: "content",
    root: { allow: ["synonym"] },
    nodes: {
      synonym: {
        label: "Synonym",
        fields: [
          text("words", "Words, comma-separated (the first is the one a one-way entry expands)", true),
          { name: "one_way", label: "One way (the first word finds the others, not back)", type: "boolean" },
          lang,
        ],
      },
    },
  },
  {
    slug: LIST_TYPES.bestBets,
    name: "Site search pinned results",
    purpose: "For a query, the pages the site search shows first, in the order of the entries.",
    role: "content",
    root: { allow: ["bet"] },
    nodes: {
      bet: {
        label: "Pinned result",
        fields: [
          text("query", "Query", true),
          { name: "page", label: "Page shown first", type: "link", required: true },
          lang,
        ],
      },
    },
  },
  {
    slug: LIST_TYPES.suggestions,
    name: "Site search start questions",
    purpose: "What the empty search field offers before the visitor types, in order.",
    role: "content",
    root: { allow: ["suggestion"] },
    nodes: { suggestion: { label: "Start question", fields: [text("text", "Text", true), lang] } },
  },
  {
    slug: LIST_TYPES.testQueries,
    name: "Site search test queries",
    purpose:
      "Queries checked at every Stage against the staged search: the page expected among the first results (or first, when it is pinned).",
    role: "content",
    root: { allow: ["test"] },
    nodes: {
      test: {
        label: "Test query",
        fields: [
          text("query", "Query", true),
          { name: "expect", label: "Expected page", type: "link", required: true },
          { name: "within", label: "Among the first (default 3)", type: "number" },
          lang,
        ],
      },
    },
  },
  {
    slug: LIST_TYPES.protectedTerms,
    name: "Site search protected words",
    purpose: "Brand and product names the site search keeps whole: never reduced to a stem.",
    role: "content",
    root: { allow: ["term"] },
    nodes: { term: { label: "Word", fields: [text("word", "Word", true)] } },
  },
];
