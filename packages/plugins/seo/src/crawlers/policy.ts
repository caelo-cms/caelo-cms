// SPDX-License-Identifier: MPL-2.0

/**
 * #1758 — a crawler policy by purpose, turned into robots.txt rules and
 * read back out of them. Pure: the rules come from core
 * (`site_defaults.get_seo`) and go back to core through the Owner-approved
 * robots rules proposal (`propose_set_site_seo`); nothing here writes.
 *
 * What a plan does to the rules the site has:
 * - Every token of a blocked purpose (by its first purpose,
 *   ./table.ts) gets `Disallow: /` in a group of the policy's, and leaves
 *   any group of the Owner's it was named in. A crawler follows only the
 *   most specific group that names it, so a blocked crawler must be named.
 * - Every token of an allowed purpose stays where it was: falling through
 *   to `*` (and so keeping the site's own paths there) or in the Owner's
 *   group of its own, unless that group keeps it out of the whole site
 *   (an earlier block): then it leaves it and follows `*`.
 * - The `*` group, and every crawler group that may still crawl the site,
 *   carries the policy as a Content-Signal (search, ai-input, ai-train):
 *   the crawlers of a group read only that group's line.
 * - Training blocked adds the `__usage_ai-training` group (`Disallow: /`);
 *   the policy owns that token, so a group of it the Owner had is replaced.
 * - Every other group of the Owner's (paths for `*`, a crawler the table
 *   does not know) is kept as it was.
 */

import type { RobotsRules } from "@caelo-cms/plugin-sdk";
import {
  CRAWLER_PURPOSES,
  CRAWLER_TOKENS,
  type CrawlerPurpose,
  type CrawlerToken,
  crawlerToken,
  PURPOSE_LABEL,
  TRAINING_PREFERENCE_NOTE,
  TRAINING_PREFERENCE_TOKEN,
  tokensFor,
} from "./table.js";

/** One group of the rules. */
export type RobotsGroup = RobotsRules[number];

/** Allow or block one purpose. */
export type PurposeChoice = "allow" | "block";

/** The operator's choice per purpose. */
export type CrawlerPolicy = Readonly<Record<CrawlerPurpose, PurposeChoice>>;

/** Most user agents core takes in one group (`ROBOTS_MAX_USER_AGENTS`). */
const MAX_AGENTS_PER_GROUP = 10;
/** Most groups core takes (`ROBOTS_MAX_GROUPS`). */
const MAX_GROUPS = 20;

/** A plan: the rules to propose, what they block, and what to tell the operator. */
export interface CrawlerPlan {
  /** The whole list for `propose_set_site_seo` (it replaces the site's). */
  readonly rules: RobotsRules;
  /** The tokens the rules keep out of the whole site. */
  readonly blocked: readonly string[];
  /** What a robots.txt can and cannot do for this policy, in the operator's words. */
  readonly caveats: readonly string[];
  /** Why the plan cannot be proposed as it is (too many groups); empty when it can. */
  readonly problems: readonly string[];
}

const isWholeSite = (p: string) => p === "/" || p === "/*";

/** Does `group` keep its crawlers out of the whole site (`Disallow: /`, nothing allowed back)? */
export function blocksWholeSite(group: RobotsGroup | undefined): boolean {
  return group !== undefined && group.disallow.some(isWholeSite) && group.allow.length === 0;
}

/**
 * The group a crawler follows: the one that names it (any case), else `*`,
 * as RFC 9309 has it. Undefined when neither exists (it may crawl all).
 */
export function groupOf(rules: RobotsRules, token: string): RobotsGroup | undefined {
  const lower = token.toLowerCase();
  return (
    rules.find((g) => g.userAgents.some((a) => a.toLowerCase() === lower)) ??
    rules.find((g) => g.userAgents.includes("*"))
  );
}

/** The Content-Signal of a policy: yes for every allowed purpose that has a key. */
function signalOf(policy: CrawlerPolicy): NonNullable<RobotsGroup["contentSignal"]> {
  return {
    search: policy.search === "allow",
    aiInput: policy.aiAnswers === "allow",
    aiTrain: policy.training === "allow",
  };
}

/** Plan the rules for `policy` on top of the site's `current` rules. */
export function planCrawlerPolicy(current: RobotsRules, policy: CrawlerPolicy): CrawlerPlan {
  const blockedTokens = CRAWLER_TOKENS.filter((t) => policy[t.purposes[0]] === "block");
  const blockedLower = new Set(blockedTokens.map((t) => t.token.toLowerCase()));
  const signal = signalOf(policy);
  const kept: RobotsGroup[] = [];
  for (const g of current) {
    // The policy owns the training preference token.
    if (g.userAgents.some((a) => a.toLowerCase() === TRAINING_PREFERENCE_TOKEN)) continue;
    const mayCrawl = !blocksWholeSite(g);
    // A blocked token moves to the policy's groups; an allowed one leaves a
    // group that keeps it out entirely (it follows `*` instead).
    const agents = g.userAgents.filter((a) => {
      const lower = a.toLowerCase();
      if (blockedLower.has(lower)) return false;
      return mayCrawl || crawlerToken(a) === undefined;
    });
    if (agents.length === 0) continue;
    kept.push({
      ...g,
      userAgents: agents,
      // A crawler reads only the group that names it, so each group that
      // still lets crawlers in carries the policy's signal.
      ...(mayCrawl ? { contentSignal: signal } : {}),
    });
  }
  const everyone = kept.find((g) => g.userAgents.includes("*"));
  const groups: RobotsGroup[] = everyone
    ? [everyone, ...kept.filter((g) => g !== everyone)]
    : [{ userAgents: ["*"], allow: ["/"], disallow: [], contentSignal: signal }, ...kept];
  for (let at = 0; at < blockedTokens.length; at += MAX_AGENTS_PER_GROUP) {
    groups.push({
      userAgents: blockedTokens.slice(at, at + MAX_AGENTS_PER_GROUP).map((t) => t.token),
      allow: [],
      disallow: ["/"],
    });
  }
  if (policy.training === "block") {
    groups.push({ userAgents: [TRAINING_PREFERENCE_TOKEN], allow: [], disallow: ["/"] });
  }
  const problems =
    groups.length > MAX_GROUPS
      ? [
          `The policy needs ${groups.length} robots.txt groups, and a site keeps at most ${MAX_GROUPS}: merge or remove some of the site's own groups first (get_site_seo lists them).`,
        ]
      : [];
  return {
    rules: groups,
    blocked: blockedTokens.map((t) => t.token),
    caveats: caveatsOf(policy, blockedTokens),
    problems,
  };
}

/** What robots.txt cannot do for `policy`, said once per point. */
function caveatsOf(policy: CrawlerPolicy, blocked: readonly CrawlerToken[]): string[] {
  const out: string[] = [
    "robots.txt is a request, not a lock: a crawler that ignores it still fetches the pages. Only the crawlers listed here are named; a new or unnamed one follows the `*` group.",
  ];
  if (policy.search === "block") {
    out.push(
      "Blocking search crawlers takes the site out of Google, Bing and the other search engines named here, which takes weeks to undo.",
    );
  }
  if (policy.search === "allow" && policy.aiAnswers === "block") {
    out.push(
      "Google's AI Overviews and AI Mode, and Bing's Copilot answers, come from the search crawlers: robots.txt cannot keep the site out of them while it stays in search. Google offers a Search Console setting for its AI features; a page's nosnippet and noarchive settings narrow what they show.",
    );
  }
  if (policy.training === "block") out.push(TRAINING_PREFERENCE_NOTE);
  if (policy.userFetch === "block") {
    out.push(
      "Fetches a person asks an AI for (ChatGPT-User, Perplexity-User) may ignore robots.txt, their operators say; blocking them is a request they may not follow.",
    );
  }
  for (const t of blocked) {
    // A token with more than one purpose costs the others too.
    if (t.purposes.length > 1 && t.note) out.push(`${t.token}: ${t.note}`);
  }
  out.push(
    "Content-Signal states the policy to crawlers that read it; it keeps none out by itself.",
  );
  return out;
}

/** How the rules treat one purpose. */
export interface PurposeState {
  readonly purpose: CrawlerPurpose;
  /** `blocked`: every crawler of it is kept out; `allowed`: none is; `mixed`: some are. */
  readonly state: "allowed" | "blocked" | "mixed";
  readonly blocked: readonly string[];
  readonly allowed: readonly string[];
}

/** How `rules` treat each purpose, by the crawlers of its first purpose. */
export function describeCrawlerPolicy(rules: RobotsRules): PurposeState[] {
  return CRAWLER_PURPOSES.map((purpose) => {
    const blocked: string[] = [];
    const allowed: string[] = [];
    for (const t of tokensFor(purpose)) {
      (blocksWholeSite(groupOf(rules, t.token)) ? blocked : allowed).push(t.token);
    }
    const state = blocked.length === 0 ? "allowed" : allowed.length === 0 ? "blocked" : "mixed";
    return { purpose, state, blocked, allowed };
  });
}

/** One contradiction in a site's rules: the file refuses a use and still lets crawlers of it in. */
export interface PolicyContradiction {
  readonly purpose: CrawlerPurpose;
  /** The line that refuses the use. */
  readonly refusedBy: string;
  /** The crawlers it does not reach. */
  readonly tokens: readonly string[];
  /** AI-actionable, operator's words. */
  readonly message: string;
}

/** The Content-Signal keys a purpose answers to. */
const SIGNAL_KEY: Partial<Record<CrawlerPurpose, keyof NonNullable<RobotsGroup["contentSignal"]>>> =
  {
    search: "search",
    aiAnswers: "aiInput",
    training: "aiTrain",
  };

/** Crawlers that read the training preference token (their operators said so). */
const READS_TRAINING_TOKEN = new Set(["claudebot"]);

/**
 * Where the rules refuse a use and still let crawlers of it in: the
 * training preference token (or a Content-Signal of `*`) says no, but a
 * crawler of that purpose that does not read it may crawl the whole site.
 * A crawler that falls through to `*` reads `*`'s Content-Signal; one with
 * a group of its own reads only that group's.
 */
export function policyContradictions(rules: RobotsRules): PolicyContradiction[] {
  const out: PolicyContradiction[] = [];
  const tokenGroup = rules.find((g) => g.userAgents.includes(TRAINING_PREFERENCE_TOKEN));
  if (blocksWholeSite(tokenGroup)) {
    const missed = tokensFor("training")
      .filter((t) => !READS_TRAINING_TOKEN.has(t.token.toLowerCase()))
      .filter((t) => !blocksWholeSite(groupOf(rules, t.token)))
      .map((t) => t.token);
    if (missed.length > 0) {
      out.push({
        purpose: "training",
        refusedBy: `User-agent: ${TRAINING_PREFERENCE_TOKEN} / Disallow: /`,
        tokens: missed,
        message: `Crawler policy contradicts itself: robots.txt refuses AI training with \`${TRAINING_PREFERENCE_TOKEN}\`, but ${list(missed)} do not read that token and may still crawl the whole site for training.`,
      });
    }
  }
  const everyone = rules.find((g) => g.userAgents.includes("*"));
  for (const purpose of CRAWLER_PURPOSES) {
    const key = SIGNAL_KEY[purpose];
    if (!key || everyone?.contentSignal?.[key] !== false) continue;
    // Crawlers with a group of their own read only that group's signal.
    const missed = tokensFor(purpose)
      .filter((t) => {
        const own = rules.find((g) =>
          g.userAgents.some((a) => a.toLowerCase() === t.token.toLowerCase()),
        );
        return own !== undefined && !blocksWholeSite(own) && own.contentSignal?.[key] !== false;
      })
      .map((t) => t.token);
    if (missed.length > 0) {
      out.push({
        purpose,
        refusedBy: `Content-Signal of User-agent: * (${key === "aiInput" ? "ai-input" : key === "aiTrain" ? "ai-train" : key}=no)`,
        tokens: missed,
        message: `Crawler policy contradicts itself: the \`*\` group asks crawlers not to use the site for ${PURPOSE_LABEL[purpose]}, but ${list(missed)} follow groups of their own that let them crawl it without saying so.`,
      });
    }
  }
  return out;
}

function list(tokens: readonly string[]): string {
  return tokens.length === 1
    ? (tokens[0] as string)
    : `${tokens.slice(0, -1).join(", ")} and ${tokens.at(-1)}`;
}

/** The caveats a set of rules calls for, without a policy: for the approval card. */
export function caveatsForRules(rules: RobotsRules): string[] {
  const out: string[] = [];
  for (const g of rules) {
    if (!blocksWholeSite(g)) continue;
    for (const agent of g.userAgents) {
      const t = crawlerToken(agent);
      if (!t) continue;
      if (!t.followsRobots && t.note) out.push(`${t.token}: ${t.note}`);
      else if (t.purposes.length > 1 && t.note) out.push(`${t.token}: ${t.note}`);
    }
  }
  if (rules.some((g) => g.userAgents.includes(TRAINING_PREFERENCE_TOKEN))) {
    out.push(TRAINING_PREFERENCE_NOTE);
  }
  for (const c of policyContradictions(rules)) out.push(c.message);
  return [...new Set(out)];
}
