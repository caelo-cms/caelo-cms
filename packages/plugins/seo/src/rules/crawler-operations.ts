// SPDX-License-Identifier: MPL-2.0

/**
 * #1758 — the crawler policy's operations: the AI's planning tool, the
 * Stage-audit rule that flags a policy contradicting itself, and the write
 * hint that puts the caveats on the robots rules proposal's approval card.
 *
 * The plan writes nothing: robots.txt rules are core's, and they change
 * only through `propose_set_site_seo`, which the Owner approves (CLAUDE.md
 * §11.A). The plugin knows which token serves which purpose; core checks
 * and writes the lines.
 */

import {
  type PluginAuditFinding,
  type PluginContextTier1,
  type PluginToolSpec,
  type PluginWrite,
  type RobotsRules,
  z,
} from "@caelo-cms/plugin-sdk";
import type { SeoAuditRule } from "../checks/index.js";
import type { SeoWriteHintRule } from "../hints/index.js";
import {
  type CrawlerPolicy,
  caveatsForRules,
  describeCrawlerPolicy,
  planCrawlerPolicy,
  policyContradictions,
} from "./crawler-policy.js";
import { PURPOSE_LABEL } from "./crawler-table.js";

/** The planning tool's operation. */
export const PLAN_CRAWLER_POLICY_OPERATION = "plan_crawler_policy";

const choice = z.enum(["allow", "block"]);

const planArgs = z
  .object({ search: choice, aiAnswers: choice, training: choice, userFetch: choice })
  .strict();

/** The robots rules as `site_defaults.get_seo` answers them (checked by core). */
const seoSettings = z
  .object({ robotsRules: z.array(z.record(z.string(), z.unknown())) })
  .passthrough();

/** The site's robots rules, read through core. */
async function currentRules(ctx: PluginContextTier1): Promise<RobotsRules> {
  if (!ctx.cms)
    throw new Error("seo: the cms_admin grant is missing, so robots.txt cannot be read");
  const settings = seoSettings.parse(await ctx.cms.call("site_defaults.get_seo", {}));
  // Core validates the rules at every write and read (robotsRulesSchema).
  return settings.robotsRules as unknown as RobotsRules;
}

/** `plan_crawler_policy`: the rules for the operator's choice, for `propose_set_site_seo`. */
export async function planCrawlerPolicyOperation(
  ctx: PluginContextTier1,
  rawArgs: unknown,
): Promise<string> {
  const policy: CrawlerPolicy = planArgs.parse(rawArgs);
  const plan = planCrawlerPolicy(await currentRules(ctx), policy);
  const decided = (Object.keys(PURPOSE_LABEL) as (keyof CrawlerPolicy)[])
    .map((p) => `${PURPOSE_LABEL[p]}: ${policy[p]}`)
    .join("; ");
  if (plan.problems.length > 0) {
    return `Not proposable as it is (${decided}):\n${plan.problems.map((p) => `- ${p}`).join("\n")}`;
  }
  return [
    `Planned (${decided}). Blocks ${plan.blocked.length > 0 ? plan.blocked.join(", ") : "no crawler"}.`,
    "NEXT: call propose_set_site_seo with exactly this robotsRules (it replaces the list); the Owner approves the card, then offer the Stage.",
    `robotsRules: ${JSON.stringify(plan.rules)}`,
    "Tell the operator:",
    ...plan.caveats.map((c) => `- ${c}`),
  ].join("\n");
}

/** The tool the AI plans a policy with. */
export const PLAN_CRAWLER_POLICY_TOOL: PluginToolSpec = {
  name: "plan_crawler_policy",
  operationName: PLAN_CRAWLER_POLICY_OPERATION,
  description:
    "Turn the operator's choice per purpose into robots.txt rules: answers the exact `robotsRules` for `propose_set_site_seo` and the caveats to tell the operator. Writes nothing; keeps the site's own paths and unknown crawlers.\n" +
    "USE FOR: 'no AI training', 'block AI crawlers', 'ChatGPT search yes, training no', setting up the crawler policy.\n" +
    "DO NOT USE FOR: keeping paths of this site out (`propose_set_site_seo` directly); removing a page from search (`set_page_seo_many` noindex).\n" +
    "CORE RULES: ask the operator for any purpose they did not decide; never assume block. Then call `propose_set_site_seo({robotsRules})` with the answer unchanged — the Owner approves it.",
  inputJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["search", "aiAnswers", "training", "userFetch"],
    properties: {
      search: {
        type: "string",
        enum: ["allow", "block"],
        description:
          "Search engines (Googlebot, Bingbot, …). `block` takes the site out of search.",
      },
      aiAnswers: {
        type: "string",
        enum: ["allow", "block"],
        description:
          "AI answer engines' crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot).",
      },
      training: {
        type: "string",
        enum: ["allow", "block"],
        description: "Training AI models (GPTBot, ClaudeBot, Google-Extended, CCBot, …).",
      },
      userFetch: {
        type: "string",
        enum: ["allow", "block"],
        description: "Pages an AI fetches when a person asks for them (ChatGPT-User, …).",
      },
    },
  },
};

/** The audit rule: a policy that refuses a use and still lets crawlers of it in. */
export const CRAWLER_POLICY_AUDIT_RULE: SeoAuditRule = {
  name: "crawler-policy",
  async site(ctx) {
    const rules = await currentRules(ctx);
    return policyContradictions(rules).map(
      (c): PluginAuditFinding => ({
        rule: "crawler-policy-contradiction",
        severity: "error",
        message: `${c.message} The line that refuses it: ${c.refusedBy}.`,
        fix: {
          tool: "plan_crawler_policy",
          hint: `Plan the policy with ${c.purpose === "aiAnswers" ? "aiAnswers" : c.purpose}: "block" (ask the operator for the other purposes), then propose_set_site_seo with the robotsRules it answers.`,
        },
      }),
    );
  },
};

const robotsWrite = z
  .object({ kind: z.literal("robots_rules"), rules: z.array(z.record(z.string(), z.unknown())) })
  .passthrough();

/** The write hint: what a robots rules proposal does per purpose, and its caveats. */
export const CRAWLER_POLICY_HINT_RULE: SeoWriteHintRule = {
  name: "crawler-policy",
  async hints(_ctx, writes: readonly PluginWrite[]) {
    const out: string[] = [];
    for (const w of writes) {
      if (w.kind !== "robots_rules") continue;
      const rules = robotsWrite.parse(w).rules as unknown as RobotsRules;
      const states = describeCrawlerPolicy(rules);
      out.push(
        `Crawler policy after this change — ${states
          .map(
            (s) =>
              `${PURPOSE_LABEL[s.purpose]}: ${s.state}${s.state === "mixed" ? ` (blocked: ${s.blocked.join(", ")})` : ""}`,
          )
          .join("; ")}.`,
      );
      out.push(...packSentences(caveatsForRules(rules), 3));
    }
    return out;
  },
};

/** Most characters of one hint (the SDK's `pluginWriteHints`). */
const HINT_CHARS = 600;

/**
 * `sentences` in at most `count` hints of at most {@link HINT_CHARS}
 * characters each, in order; what does not fit is left out, and the last
 * hint says how many points it left out.
 */
export function packSentences(sentences: readonly string[], count: number): string[] {
  const out: string[] = [];
  let current = "";
  let left = 0;
  for (const s of sentences) {
    const sentence = s.length > HINT_CHARS ? `${s.slice(0, HINT_CHARS - 1)}…` : s;
    if (current === "") current = sentence;
    else if (current.length + 1 + sentence.length <= HINT_CHARS) current = `${current} ${sentence}`;
    else if (out.length + 1 < count) {
      out.push(current);
      current = sentence;
    } else left += 1;
  }
  if (current !== "") out.push(current);
  if (left > 0) {
    const tail = ` (${left} more: get_site_seo and plan_crawler_policy list them)`;
    const last = out.at(-1) as string;
    out[out.length - 1] =
      last.length + tail.length <= HINT_CHARS
        ? `${last}${tail}`
        : `${last.slice(0, HINT_CHARS - tail.length - 1)}…${tail}`;
  }
  return out;
}
