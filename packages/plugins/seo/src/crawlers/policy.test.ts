// SPDX-License-Identifier: MPL-2.0

/**
 * #1758 — the crawler policy by purpose: the table, the plan the AI
 * proposes, and the contradictions the Stage audit flags.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1, RobotsRules } from "@caelo-cms/plugin-sdk";
import { seoWriteHints } from "../hints/index.js";
import {
  CRAWLER_POLICY_AUDIT_RULE,
  packSentences,
  planCrawlerPolicyOperation,
} from "./operations.js";
import {
  blocksWholeSite,
  type CrawlerPolicy,
  describeCrawlerPolicy,
  groupOf,
  planCrawlerPolicy,
  policyContradictions,
} from "./policy.js";
import {
  CRAWLER_PURPOSES,
  CRAWLER_TOKENS,
  crawlerToken,
  TRAINING_PREFERENCE_TOKEN,
  tokensFor,
} from "./table.js";

const g = (
  userAgents: string[],
  paths: { allow?: string[]; disallow?: string[] },
  contentSignal?: RobotsRules[number]["contentSignal"],
): RobotsRules[number] => ({
  userAgents,
  allow: paths.allow ?? [],
  disallow: paths.disallow ?? [],
  ...(contentSignal ? { contentSignal } : {}),
});

const NO_TRAINING: CrawlerPolicy = {
  search: "allow",
  aiAnswers: "allow",
  training: "block",
  userFetch: "allow",
};

describe("crawler table", () => {
  it("names each token once and every purpose at least once", () => {
    const lower = CRAWLER_TOKENS.map((t) => t.token.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    for (const p of CRAWLER_PURPOSES) expect(tokensFor(p).length).toBeGreaterThan(0);
    // Every token is a product token core accepts (RFC 9309 letters, digits, _ and -).
    for (const t of CRAWLER_TOKENS) expect(t.token).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(crawlerToken("gptbot")?.token).toBe("GPTBot");
  });

  it("says where one token covers several purposes, and who may ignore robots.txt", () => {
    expect(crawlerToken("Googlebot")?.purposes).toEqual(["search", "aiAnswers"]);
    expect(crawlerToken("Google-Extended")?.purposes[0]).toBe("training");
    expect(crawlerToken("ChatGPT-User")?.followsRobots).toBe(false);
    expect(crawlerToken("Perplexity-User")?.followsRobots).toBe(false);
  });
});

describe("planCrawlerPolicy", () => {
  it("search and AI answers yes, training no: the expected groups and lines", () => {
    const plan = planCrawlerPolicy([], NO_TRAINING);
    expect(plan.problems).toEqual([]);
    expect(plan.rules[0]).toEqual(
      g(["*"], { allow: ["/"] }, { search: true, aiInput: true, aiTrain: false }),
    );
    const blocked = plan.rules.filter((r) => blocksWholeSite(r));
    const blockedAgents = blocked.flatMap((r) => r.userAgents);
    expect(blockedAgents).toEqual([
      "GPTBot",
      "ClaudeBot",
      "Google-Extended",
      "Applebot-Extended",
      "CCBot",
      "meta-externalagent",
      "Bytespider",
      TRAINING_PREFERENCE_TOKEN,
    ]);
    // The preference token stands alone, as core wants it.
    expect(plan.rules.at(-1)).toEqual(g([TRAINING_PREFERENCE_TOKEN], { disallow: ["/"] }));
    // Search and answer crawlers stay with `*`.
    for (const t of ["Googlebot", "Bingbot", "OAI-SearchBot", "PerplexityBot", "ChatGPT-User"]) {
      expect(groupOf(plan.rules, t)?.userAgents).toEqual(["*"]);
    }
    expect(plan.caveats.join(" ")).toContain("IETF draft");
    expect(plan.caveats.join(" ")).toContain("request, not a lock");
  });

  it("keeps the site's own paths and unknown crawlers, and replaces what the policy owns", () => {
    const current: RobotsRules = [
      g(["*"], { disallow: ["/de/suche/"] }),
      g(["GPTBot", "MyBot"], { disallow: ["/private/"] }),
      g(["Googlebot"], { disallow: ["/drafts/"] }),
      g([TRAINING_PREFERENCE_TOKEN], { allow: ["/"] }),
    ];
    const plan = planCrawlerPolicy(current, NO_TRAINING);
    // `*` keeps its paths and gains the signal.
    expect(plan.rules[0]).toEqual(
      g(["*"], { disallow: ["/de/suche/"] }, { search: true, aiInput: true, aiTrain: false }),
    );
    // GPTBot leaves the Owner's group; MyBot keeps it.
    expect(groupOf(plan.rules, "MyBot")?.userAgents).toEqual(["MyBot"]);
    expect(groupOf(plan.rules, "MyBot")?.disallow).toEqual(["/private/"]);
    expect(blocksWholeSite(groupOf(plan.rules, "GPTBot"))).toBe(true);
    // An allowed crawler with a group of its own keeps it, and reads the signal there.
    expect(groupOf(plan.rules, "Googlebot")?.disallow).toEqual(["/drafts/"]);
    expect(groupOf(plan.rules, "Googlebot")?.contentSignal?.aiTrain).toBe(false);
    // The Owner's token group is replaced by the policy's.
    const tokenGroups = plan.rules.filter((r) => r.userAgents.includes(TRAINING_PREFERENCE_TOKEN));
    expect(tokenGroups).toEqual([g([TRAINING_PREFERENCE_TOKEN], { disallow: ["/"] })]);
  });

  it("allows everything again, dropping its own groups and token", () => {
    const before = planCrawlerPolicy([g(["*"], { disallow: ["/x/"] })], NO_TRAINING).rules;
    const after = planCrawlerPolicy(before, {
      search: "allow",
      aiAnswers: "allow",
      training: "allow",
      userFetch: "allow",
    });
    expect(after.blocked).toEqual([]);
    expect(after.rules).toEqual([
      g(["*"], { disallow: ["/x/"] }, { search: true, aiInput: true, aiTrain: true }),
    ]);
  });

  it("splits more than ten blocked tokens into groups core takes", () => {
    const plan = planCrawlerPolicy([], {
      search: "block",
      aiAnswers: "block",
      training: "block",
      userFetch: "block",
    });
    for (const r of plan.rules) expect(r.userAgents.length).toBeLessThanOrEqual(10);
    expect(plan.blocked.length).toBe(CRAWLER_TOKENS.length);
    expect(plan.caveats.join(" ")).toContain("takes the site out of Google");
    expect(plan.caveats.join(" ")).toContain("may ignore robots.txt");
  });

  it("refuses a plan that needs more groups than a site keeps", () => {
    const many = Array.from({ length: 19 }, (_, i) => g([`Bot${i}`], { disallow: ["/x"] }));
    const plan = planCrawlerPolicy([g(["*"], { allow: ["/"] }), ...many], NO_TRAINING);
    expect(plan.problems[0]).toContain("at most 20");
  });

  it("explains search yes, AI answers no", () => {
    const plan = planCrawlerPolicy([], { ...NO_TRAINING, training: "allow", aiAnswers: "block" });
    expect(plan.blocked).toEqual(["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"]);
    expect(plan.caveats.join(" ")).toContain("AI Overviews");
  });
});

describe("describeCrawlerPolicy and contradictions", () => {
  it("reads the policy back out of planned rules, with no contradiction", () => {
    const rules = planCrawlerPolicy([], NO_TRAINING).rules;
    const states = Object.fromEntries(
      describeCrawlerPolicy(rules).map((s) => [s.purpose, s.state]),
    );
    expect(states).toEqual({
      search: "allowed",
      aiAnswers: "allowed",
      training: "blocked",
      userFetch: "allowed",
    });
    expect(policyContradictions(rules)).toEqual([]);
  });

  it("flags training refused by the token while training crawlers are allowed by `*`", () => {
    const rules: RobotsRules = [
      g(["*"], { allow: ["/"] }),
      g([TRAINING_PREFERENCE_TOKEN], { disallow: ["/"] }),
    ];
    const [c] = policyContradictions(rules);
    expect(c?.purpose).toBe("training");
    // ClaudeBot reads the token; the others do not.
    expect(c?.tokens).toContain("GPTBot");
    expect(c?.tokens).not.toContain("ClaudeBot");
    expect(c?.message).toContain("Crawler policy contradicts itself");
  });

  it("flags a `*` Content-Signal a crawler's own group does not repeat", () => {
    const rules: RobotsRules = [
      g(["*"], { allow: ["/"] }, { aiTrain: false }),
      g(["GPTBot"], { disallow: ["/private/"] }),
    ];
    const found = policyContradictions(rules);
    expect(found).toHaveLength(1);
    expect(found[0]?.tokens).toEqual(["GPTBot"]);
    // A crawler that falls through to `*` reads its signal: no contradiction.
    expect(policyContradictions([g(["*"], { allow: ["/"] }, { aiTrain: false })])).toEqual([]);
  });

  it("files a contradiction as an error finding with the fix tool", async () => {
    const ctx = {
      cms: {
        call: async () => ({
          robotsRules: [
            g(["*"], { allow: ["/"] }),
            g([TRAINING_PREFERENCE_TOKEN], { disallow: ["/"] }),
          ],
        }),
      },
    } as unknown as PluginContextTier1;
    const findings = await CRAWLER_POLICY_AUDIT_RULE.site?.(ctx, { pages: [], runId: undefined });
    expect(findings).toHaveLength(1);
    expect(findings?.[0]).toMatchObject({
      rule: "crawler-policy-contradiction",
      severity: "error",
      fix: { tool: "plan_crawler_policy" },
    });
  });
});

describe("plan_crawler_policy and the card hint", () => {
  const ctxWith = (rules: RobotsRules) =>
    ({ cms: { call: async () => ({ robotsRules: rules }) } }) as unknown as PluginContextTier1;

  it("answers the rules to propose and the caveats", async () => {
    const text = await planCrawlerPolicyOperation(ctxWith([]), NO_TRAINING);
    expect(text).toContain("NEXT: call propose_set_site_seo");
    const json = /robotsRules: (.*)/.exec(text)?.[1] as string;
    expect(JSON.parse(json)).toEqual(planCrawlerPolicy([], NO_TRAINING).rules);
    expect(text).toContain("Tell the operator:");
  });

  it("refuses an incomplete choice", async () => {
    await expect(planCrawlerPolicyOperation(ctxWith([]), { training: "block" })).rejects.toThrow();
  });

  it("puts the policy and its caveats on the card, within the SDK's hint limits", async () => {
    const rules = planCrawlerPolicy([], { ...NO_TRAINING, userFetch: "block" }).rules;
    const { hints } = await seoWriteHints(ctxWith([]), {
      writes: [{ kind: "robots_rules", rules }],
    });
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.length).toBeLessThanOrEqual(5);
    for (const h of hints) expect(h.length).toBeLessThanOrEqual(600);
    expect(hints[0]).toContain("AI training: blocked");
    expect(hints.join(" ")).toContain("ChatGPT-User");
    // Module writes get nothing from this rule.
    const none = await seoWriteHints(ctxWith([]), {
      writes: [{ kind: "module", moduleId: null, html: "<p>x</p>", fields: [] }],
    });
    expect(none.hints).toEqual([]);
  });

  it("packs sentences into the hint limits and says what it left out", () => {
    const long = Array.from({ length: 12 }, (_, i) => `${"x".repeat(250)} ${i}.`);
    const packed = packSentences(long, 3);
    expect(packed).toHaveLength(3);
    for (const p of packed) expect(p.length).toBeLessThanOrEqual(600);
    expect(packed.at(-1)).toContain("more:");
  });
});
