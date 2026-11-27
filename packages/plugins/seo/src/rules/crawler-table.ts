// SPDX-License-Identifier: MPL-2.0

/**
 * #1758 — which crawler token serves which purpose. This is the SEO
 * knowledge that changes (a provider adds a bot, splits one, documents a
 * new rule), so it lives in the plugin, not in core: core only checks and
 * writes the robots.txt lines (`@caelo-cms/shared` robots-rules.ts).
 *
 * Sources, as of 2026-11 (the epic's research report): OpenAI
 * (developers.openai.com/api/docs/bots), Anthropic (support.claude.com,
 * "Does Anthropic crawl data from the web"), Perplexity
 * (docs.perplexity.ai/guides/bots), Apple (support.apple.com/119829),
 * Google (developers.google.com/search/docs/appearance/ai-features, the
 * Search Central blog of 2026-10-30 on the shared training control),
 * Common Crawl, Meta. A token's first purpose is the one a policy decides
 * it by; the others are what blocking it also costs, which the caveats
 * name.
 */

/** The purposes an operator decides about. */
export const CRAWLER_PURPOSES = ["search", "aiAnswers", "training", "userFetch"] as const;

/** One purpose ({@link CRAWLER_PURPOSES}). */
export type CrawlerPurpose = (typeof CRAWLER_PURPOSES)[number];

/** The purposes in the operator's words. */
export const PURPOSE_LABEL: Readonly<Record<CrawlerPurpose, string>> = {
  search: "search results",
  aiAnswers: "AI answers",
  training: "AI training",
  userFetch: "pages fetched when a person asks an AI",
};

/** One crawler token robots.txt can name. */
export interface CrawlerToken {
  /** The product token as robots.txt names it. */
  readonly token: string;
  /** Who runs it. */
  readonly operator: string;
  /** Its purposes; the first decides how a policy treats it. */
  readonly purposes: readonly [CrawlerPurpose, ...CrawlerPurpose[]];
  /** False when its operator says robots.txt may not bind it. */
  readonly followsRobots: boolean;
  /** What blocking or allowing it means beyond its first purpose, in plain words. */
  readonly note?: string;
}

/** Every token a crawler policy decides about, grouped by first purpose. */
export const CRAWLER_TOKENS: readonly CrawlerToken[] = [
  {
    token: "Googlebot",
    operator: "Google",
    purposes: ["search", "aiAnswers"],
    followsRobots: true,
    note: "Google Search and the AI Overviews and AI Mode built on it use the same crawler: robots.txt cannot keep a site out of AI Overviews without leaving Google Search. That is a Search Console setting of its own.",
  },
  {
    token: "Bingbot",
    operator: "Microsoft",
    purposes: ["search", "aiAnswers"],
    followsRobots: true,
    note: "Bing search and the Copilot answers grounded in it use the same crawler; a page's noarchive setting keeps it out of Copilot answers.",
  },
  {
    token: "Applebot",
    operator: "Apple",
    purposes: ["search", "aiAnswers"],
    followsRobots: true,
    note: "Spotlight, Siri and Safari suggestions. Apple's model training follows Applebot-Extended instead.",
  },
  { token: "DuckDuckBot", operator: "DuckDuckGo", purposes: ["search"], followsRobots: true },
  { token: "YandexBot", operator: "Yandex", purposes: ["search"], followsRobots: true },
  {
    token: "OAI-SearchBot",
    operator: "OpenAI",
    purposes: ["aiAnswers"],
    followsRobots: true,
    note: "ChatGPT search. A site it may not crawl can still show up there as a bare link.",
  },
  {
    token: "Claude-SearchBot",
    operator: "Anthropic",
    purposes: ["aiAnswers"],
    followsRobots: true,
  },
  {
    token: "PerplexityBot",
    operator: "Perplexity",
    purposes: ["aiAnswers"],
    followsRobots: true,
  },
  { token: "GPTBot", operator: "OpenAI", purposes: ["training"], followsRobots: true },
  { token: "ClaudeBot", operator: "Anthropic", purposes: ["training"], followsRobots: true },
  {
    token: "Google-Extended",
    operator: "Google",
    purposes: ["training", "aiAnswers"],
    followsRobots: true,
    note: "A token, not a crawler: it decides whether Google may train Gemini models on the site and ground Gemini app answers in it. It does not change Google Search or its AI Overviews.",
  },
  {
    token: "Applebot-Extended",
    operator: "Apple",
    purposes: ["training"],
    followsRobots: true,
    note: "A token, not a crawler: it decides whether Apple may train its models on what Applebot fetched.",
  },
  {
    token: "CCBot",
    operator: "Common Crawl",
    purposes: ["training"],
    followsRobots: true,
    note: "An open web archive that many AI models are trained on.",
  },
  { token: "meta-externalagent", operator: "Meta", purposes: ["training"], followsRobots: true },
  { token: "Bytespider", operator: "ByteDance", purposes: ["training"], followsRobots: true },
  {
    token: "ChatGPT-User",
    operator: "OpenAI",
    purposes: ["userFetch"],
    followsRobots: false,
    note: "OpenAI says robots.txt rules may not apply to it: it fetches what a person asked ChatGPT to read.",
  },
  { token: "Claude-User", operator: "Anthropic", purposes: ["userFetch"], followsRobots: true },
  {
    token: "Perplexity-User",
    operator: "Perplexity",
    purposes: ["userFetch"],
    followsRobots: false,
    note: "Perplexity says it generally ignores robots.txt: it fetches what a person asked for.",
  },
];

/** The AI training preference token (core's `ROBOTS_USAGE_PREFERENCE_TOKENS`). */
export const TRAINING_PREFERENCE_TOKEN = "__usage_ai-training";

/** Who reads the training preference token, as its supporters said by 2026-11. */
export const TRAINING_PREFERENCE_NOTE =
  "`__usage_ai-training` is an IETF draft of 2026-10-30: Anthropic reads it, Google plans to from 2027, OpenAI and Microsoft have said nothing yet. A crawler that does not read it follows only its own group, so the policy also names each training crawler.";

/** The token entry of `token`, matched as robots.txt matches names (any case). */
export function crawlerToken(token: string): CrawlerToken | undefined {
  const lower = token.toLowerCase();
  return CRAWLER_TOKENS.find((t) => t.token.toLowerCase() === lower);
}

/** The tokens whose first purpose is `purpose`. */
export function tokensFor(purpose: CrawlerPurpose): CrawlerToken[] {
  return CRAWLER_TOKENS.filter((t) => t.purposes[0] === purpose);
}
