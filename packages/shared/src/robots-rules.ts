// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1706 — the Owner's own robots.txt rules: Allow and Disallow
 * paths per user agent, on top of the site's `User-agent: * / Allow: /`.
 * Issue #1758 adds the two lines a crawler policy by purpose needs: a
 * group for the AI training preference token (`__usage_ai-training`, IETF
 * draft-kelley-aipref-training-preference-signal) and a `Content-Signal`
 * line per group (contentsignals.org: may the content feed search
 * results, AI answers, AI training).
 *
 * Structured fields only, never text the Owner types into the file
 * (CLAUDE.md §2: static files are data, robots.txt is built): every value
 * is checked here, so no newline, comment or unknown directive can enter
 * the file; a Content-Signal is three booleans, so it carries no text. The
 * rules are a rendered setting: stored in `site_defaults`, carried by each
 * build (`deploy_runs.robots_rules`) and live only with a human Publish
 * live, because a wrong `Disallow: /` takes a site out of search and cannot
 * be called back quickly (docs/dev/robots-rules.md).
 *
 * Only an indexable target serves them. A staging target keeps
 * `Disallow: /` for everyone, whatever the rules say.
 */

import { z } from "zod";
import { siteFeedUrl } from "./search-feed.js";

/** Most groups (user agents with their paths) a site keeps. */
export const ROBOTS_MAX_GROUPS = 20;
/** Most user agents one group names. */
export const ROBOTS_MAX_USER_AGENTS = 10;
/** Most Allow (and, separately, Disallow) paths one group lists. */
export const ROBOTS_MAX_PATHS = 50;
/** Longest path. */
export const ROBOTS_PATH_MAX = 512;

/**
 * #1758 — the usage-preference tokens a group may name instead of a
 * crawler. A group naming one states a preference to every crawler that
 * reads it (`Disallow: /` = do not train on this site); it is no crawler
 * and directs no crawling. The `__usage_` names belong to the IETF draft,
 * so an unknown one is refused rather than written: crawlers would read it
 * as the name of a crawler nobody runs.
 */
export const ROBOTS_USAGE_PREFERENCE_TOKENS = ["__usage_ai-training"] as const;

/** One of {@link ROBOTS_USAGE_PREFERENCE_TOKENS}. */
export type RobotsUsagePreferenceToken = (typeof ROBOTS_USAGE_PREFERENCE_TOKENS)[number];

/** Is `agent` a usage-preference token ({@link ROBOTS_USAGE_PREFERENCE_TOKENS})? */
export function isUsagePreferenceToken(agent: string): agent is RobotsUsagePreferenceToken {
  return (ROBOTS_USAGE_PREFERENCE_TOKENS as readonly string[]).includes(agent);
}

/**
 * A crawler's product token as RFC 9309 §2.2.1 allows it (letters, digits,
 * `_` and `-`), `*` for every crawler, or a usage-preference token, which
 * is stored as the draft spells it (product tokens match without regard to
 * case).
 */
const userAgentSchema = z
  .string()
  .trim()
  .regex(
    /^(\*|[A-Za-z0-9_-]{1,64})$/,
    "a user agent is `*` or a crawler's product token (letters, digits, `_` and `-`, e.g. `Googlebot`, `GPTBot`)",
  )
  .transform((agent) => {
    const lower = agent.toLowerCase();
    return ROBOTS_USAGE_PREFERENCE_TOKENS.find((t) => t === lower) ?? agent;
  })
  .superRefine((agent, c) => {
    if (agent.startsWith("__") && !isUsagePreferenceToken(agent)) {
      c.addIssue({
        code: "custom",
        message: `\`${agent}\` is no crawler and no usage preference: the \`__usage_\` names are the IETF preference tokens, and the only one is ${ROBOTS_USAGE_PREFERENCE_TOKENS.map((t) => `\`${t}\``).join(", ")}`,
      });
    }
  });

/**
 * #1758 — a group's `Content-Signal` (contentsignals.org): may the crawlers
 * of the group use the content for search results (`search`), as input to
 * AI answers (`aiInput`, the line's `ai-input`) or to train AI models
 * (`aiTrain`, `ai-train`). A key left out is left unsaid. A preference,
 * not a block: it keeps no crawler out.
 */
export const robotsContentSignalSchema = z
  .object({
    search: z.boolean().optional(),
    aiInput: z.boolean().optional(),
    aiTrain: z.boolean().optional(),
  })
  .strict()
  .refine((s) => s.search !== undefined || s.aiInput !== undefined || s.aiTrain !== undefined, {
    message:
      "a Content-Signal says at least one of `search`, `aiInput` (ai-input) and `aiTrain` (ai-train)",
  });

/** A group's Content-Signal ({@link robotsContentSignalSchema}). */
export type RobotsContentSignal = z.infer<typeof robotsContentSignalSchema>;

/** The Content-Signal keys in the order the line names them, with their robots.txt names. */
const CONTENT_SIGNAL_KEYS = [
  ["search", "search"],
  ["aiInput", "ai-input"],
  ["aiTrain", "ai-train"],
] as const satisfies readonly (readonly [keyof RobotsContentSignal, string])[];

/** The value of a `Content-Signal` line (`search=yes, ai-train=no`), keys in a fixed order. */
export function contentSignalText(signal: RobotsContentSignal): string {
  return CONTENT_SIGNAL_KEYS.flatMap(([key, name]) => {
    const said = signal[key];
    return said === undefined ? [] : [`${name}=${said ? "yes" : "no"}`];
  }).join(", ");
}

/**
 * A Content-Signal value as people type it (`search=yes, ai-train=no`),
 * strictly: only the three keys, each once, each `yes` or `no`.
 */
function parseContentSignal(
  value: string,
):
  | { readonly ok: true; readonly signal: RobotsContentSignal }
  | { readonly ok: false; readonly message: string } {
  const signal: { -readonly [K in keyof RobotsContentSignal]: boolean } = {};
  for (const raw of value.split(",")) {
    const part = raw.trim();
    const eq = part.indexOf("=");
    const name = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
    const said =
      eq === -1
        ? ""
        : part
            .slice(eq + 1)
            .trim()
            .toLowerCase();
    const key = CONTENT_SIGNAL_KEYS.find(([, n]) => n === name)?.[0];
    if (!key) {
      return {
        ok: false,
        message: `Content-Signal names \`${(name || part).slice(0, 40)}\`; it takes only search, ai-input and ai-train`,
      };
    }
    if (said !== "yes" && said !== "no") {
      return { ok: false, message: `Content-Signal ${name} is \`yes\` or \`no\`` };
    }
    if (signal[key] !== undefined) {
      return { ok: false, message: `Content-Signal names ${name} twice` };
    }
    signal[key] = said === "yes";
  }
  return { ok: true, signal };
}

/** No whitespace, control character or `#` (a comment) anywhere in a path. */
function pathProblem(path: string): string | null {
  if (path.charAt(0) !== "/") return "starts with `/` (a path of this site)";
  for (const ch of path) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/u.test(ch)) return "has no spaces or line breaks";
    if (ch === "#") return "has no `#` (it starts a comment in robots.txt)";
  }
  return null;
}

const pathSchema = z
  .string()
  .min(1)
  .max(ROBOTS_PATH_MAX)
  .superRefine((path, c) => {
    const problem = pathProblem(path);
    if (problem) {
      c.addIssue({
        code: "custom",
        message: `robots path ${JSON.stringify(path.slice(0, 60))}: a path ${problem}; \`*\` matches anything, a closing \`$\` ends the match`,
      });
    }
  });

/**
 * One group: the crawlers it names, the paths they may or may not crawl,
 * and (#1758) what they may use the content for.
 */
export const robotsRuleGroupSchema = z
  .object({
    userAgents: z.array(userAgentSchema).min(1).max(ROBOTS_MAX_USER_AGENTS),
    allow: z.array(pathSchema).max(ROBOTS_MAX_PATHS).default([]),
    disallow: z.array(pathSchema).max(ROBOTS_MAX_PATHS).default([]),
    contentSignal: robotsContentSignalSchema.optional(),
  })
  .strict()
  .superRefine((g, c) => {
    if (g.allow.length + g.disallow.length === 0) {
      // A Content-Signal is no rule to a parser (RFC 9309 §2.2): a group of
      // only that line would take the next group's User-agent lines in, and
      // those crawlers would read this group's paths as their own.
      c.addIssue({
        code: "custom",
        message:
          'a robots group lists at least one allow or disallow path (a group with only a Content-Signal takes `allow: ["/"]`)',
      });
    }
    if (g.userAgents.includes("*") && g.userAgents.length > 1) {
      c.addIssue({
        code: "custom",
        message:
          "`*` stands alone in its group: a crawler follows only the most specific group that names it, so give a named crawler a group of its own",
      });
    }
    const preference = g.userAgents.find(isUsagePreferenceToken);
    if (preference && g.userAgents.length > 1) {
      c.addIssue({
        code: "custom",
        message: `\`${preference}\` stands alone in its group: it states a usage preference, and a crawler named next to it would read its paths as where it may crawl`,
      });
    }
    if (preference && g.contentSignal) {
      c.addIssue({
        code: "custom",
        message: `the \`${preference}\` group takes no Content-Signal: its Allow and Disallow paths are the preference`,
      });
    }
  });

/** The Owner's rules: every user agent in at most one group. */
export const robotsRulesSchema = z
  .array(robotsRuleGroupSchema)
  .max(ROBOTS_MAX_GROUPS)
  .superRefine((groups, c) => {
    const seen = new Set<string>();
    for (const g of groups) {
      for (const agent of g.userAgents) {
        const key = agent.toLowerCase();
        if (seen.has(key)) {
          c.addIssue({
            code: "custom",
            message: `the user agent \`${agent}\` is named in two groups — list all of its paths in one group`,
          });
        }
        seen.add(key);
      }
    }
  });

export type RobotsRuleGroup = z.infer<typeof robotsRuleGroupSchema>;
export type RobotsRules = z.infer<typeof robotsRulesSchema>;

/**
 * A path as robots.txt carries it: characters outside printable ASCII
 * percent-encoded (RFC 9309 §2.2.2), `%XX` escapes, `*` and `$` kept.
 */
export function robotsPathText(path: string): string {
  let out = "";
  for (const ch of path) {
    const code = ch.codePointAt(0) ?? 0;
    out += code > 0x7e ? encodeURIComponent(ch) : ch;
  }
  return out;
}

/**
 * The groups of an indexable target's robots.txt: the `*` group first,
 * then each named group in the Owner's order. No trailing newline. A
 * group's Content-Signal (#1758) follows its User-agent lines, before its
 * paths, where Cloudflare's managed robots.txt writes it.
 *
 * The `*` group is the Owner's when they have one, else `Allow: /`. Never
 * both: RFC 9309 lets an Allow win over an equally long Disallow, so an
 * `Allow: /` next to the Owner's `Disallow: /` would quietly undo it. A
 * path no rule matches is allowed anyway.
 */
export function robotsTxtGroups(rules: RobotsRules): string {
  const lines = (g: Pick<RobotsRuleGroup, "allow" | "disallow" | "contentSignal">) => [
    ...(g.contentSignal ? [`Content-Signal: ${contentSignalText(g.contentSignal)}`] : []),
    ...g.allow.map((p) => `Allow: ${robotsPathText(p)}`),
    ...g.disallow.map((p) => `Disallow: ${robotsPathText(p)}`),
  ];
  const everyone = rules.find((g) => g.userAgents.includes("*"));
  const blocks = [
    ["User-agent: *", ...(everyone ? lines(everyone) : ["Allow: /"])].join("\n"),
    ...rules
      .filter((g) => g !== everyone)
      .map((g) => [...g.userAgents.map((a) => `User-agent: ${a}`), ...lines(g)].join("\n")),
  ];
  return blocks.join("\n\n");
}

/**
 * The whole robots.txt of a target: `Disallow: /` for everyone on a
 * non-indexable one (staging, whatever the rules say); on an indexable one
 * the groups ({@link robotsTxtGroups}) and the `Sitemap:` lines of what the
 * build carries (its sitemap, its Atom feed, which search engines read as a
 * sitemap of the latest changes).
 */
export function robotsTxt(args: {
  readonly robots: "index" | "noindex";
  readonly siteBaseUrl: string;
  readonly sitemap: boolean;
  readonly feed: boolean;
  readonly rules: RobotsRules;
}): string {
  if (args.robots === "noindex") return "User-agent: *\nDisallow: /\n";
  const base = args.siteBaseUrl.replace(/\/$/, "");
  const sitemaps = [
    ...(args.sitemap ? [`Sitemap: ${base}/sitemap.xml`] : []),
    ...(args.feed ? [`Sitemap: ${siteFeedUrl(base)}`] : []),
  ];
  const groups = robotsTxtGroups(args.rules);
  return sitemaps.length === 0 ? `${groups}\n` : `${groups}\n\n${sitemaps.join("\n")}\n`;
}

/**
 * The rules as the Settings → SEO field shows them: robots.txt groups of
 * `User-agent`, `Content-Signal`, `Allow` and `Disallow` lines, as the
 * Owner wrote them (paths not encoded). {@link parseRobotsRulesText} reads
 * it back.
 */
export function robotsRulesText(rules: RobotsRules): string {
  return rules
    .map((g) =>
      [
        ...g.userAgents.map((a) => `User-agent: ${a}`),
        ...(g.contentSignal ? [`Content-Signal: ${contentSignalText(g.contentSignal)}`] : []),
        ...g.allow.map((p) => `Allow: ${p}`),
        ...g.disallow.map((p) => `Disallow: ${p}`),
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * The Settings → SEO field read back into rules: only `User-agent`,
 * `Content-Signal` (one per group, #1758), `Allow` and `Disallow` lines and
 * blank lines, every value checked by {@link robotsRulesSchema}. A
 * `User-agent` line after a path or a Content-Signal starts the next group.
 *
 * @returns the rules, or the first problem with its line number.
 */
export function parseRobotsRulesText(
  text: string,
):
  | { readonly ok: true; readonly rules: RobotsRules }
  | { readonly ok: false; readonly message: string } {
  const groups: {
    userAgents: string[];
    allow: string[];
    disallow: string[];
    contentSignal?: RobotsContentSignal;
  }[] = [];
  let current: (typeof groups)[number] | null = null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    const key = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
    const value = colon === -1 ? "" : line.slice(colon + 1).trim();
    if (key !== "user-agent" && key !== "allow" && key !== "disallow" && key !== "content-signal") {
      return {
        ok: false,
        message: `line ${i + 1}: only User-agent, Content-Signal, Allow and Disallow lines (Sitemap lines are written for you)`,
      };
    }
    if (value === "") {
      return { ok: false, message: `line ${i + 1}: ${lines[i]?.trim()} names nothing` };
    }
    if (key === "content-signal") {
      if (!current) {
        return { ok: false, message: `line ${i + 1}: a Content-Signal before any User-agent line` };
      }
      if (current.contentSignal) {
        return { ok: false, message: `line ${i + 1}: a group takes one Content-Signal line` };
      }
      const signal = parseContentSignal(value);
      if (!signal.ok) return { ok: false, message: `line ${i + 1}: ${signal.message}` };
      current.contentSignal = signal.signal;
    } else if (key === "user-agent") {
      if (
        !current ||
        current.allow.length + current.disallow.length > 0 ||
        current.contentSignal !== undefined
      ) {
        current = { userAgents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.userAgents.push(value);
    } else if (!current) {
      return { ok: false, message: `line ${i + 1}: a rule before any User-agent line` };
    } else if (key === "allow") current.allow.push(value);
    else current.disallow.push(value);
  }
  const parsed = robotsRulesSchema.safeParse(groups);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  return { ok: true, rules: parsed.data };
}

/**
 * What a rule set takes away from search engines, for an approval card
 * and the settings page: every crawler group that disallows the whole site
 * (`/`, `/*`) without allowing a path back, and (#1758) a Content-Signal
 * that asks every crawler not to use the site for search. A usage
 * preference group keeps nobody out of search and gets no warning.
 */
export function robotsRulesWarnings(rules: RobotsRules): string[] {
  const out: string[] = [];
  for (const g of rules) {
    if (g.userAgents.some(isUsagePreferenceToken)) continue;
    if (g.userAgents.includes("*") && g.contentSignal?.search === false) {
      out.push(
        "every crawler is asked not to use this site for search results (Content-Signal: search=no): search engines that read the signal leave it out of their results.",
      );
    }
    const whole = g.disallow.some((p) => p === "/" || p === "/*");
    if (!whole) continue;
    const who = g.userAgents.includes("*") ? "every crawler" : g.userAgents.join(", ");
    out.push(
      g.allow.length > 0
        ? `${who} may crawl only ${g.allow.join(", ")} of this site.`
        : `${who} may crawl nothing of this site${g.userAgents.includes("*") ? ": search engines drop it from their results, which takes weeks to undo" : ""}.`,
    );
  }
  return out;
}

/**
 * #1758 — what the approval card and the settings page say about the
 * preference lines of a rule set, next to its warnings: the training
 * preference token and a Content-Signal keep no crawler out, and only the
 * crawlers that read them follow them. Empty when the rules have neither.
 */
export function robotsRulesNotes(rules: RobotsRules): string[] {
  const preference = rules.some((g) => g.userAgents.some(isUsagePreferenceToken));
  const signal = rules.some((g) => g.contentSignal !== undefined);
  const out: string[] = [];
  if (preference) {
    out.push(
      "`__usage_ai-training` states a preference about AI training, not a crawling rule: it keeps no crawler out, and only crawlers that read the token follow it. A crawler named in a group of its own follows that group instead.",
    );
  }
  if (signal) {
    out.push(
      "A Content-Signal states what the crawlers of its group may use the site for; it keeps no crawler out, and only crawlers that read it follow it.",
    );
  }
  return out;
}
