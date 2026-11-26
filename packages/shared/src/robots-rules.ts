// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1706 — the Owner's own robots.txt rules: Allow and Disallow
 * paths per user agent, on top of the site's `User-agent: * / Allow: /`.
 *
 * Structured fields only, never text the Owner types into the file
 * (CLAUDE.md §2: static files are data, robots.txt is built): every value
 * is checked here, so no newline, comment or unknown directive can enter
 * the file. The rules are a rendered setting: stored in `site_defaults`,
 * carried by each build (`deploy_runs.robots_rules`) and live only with a
 * human Publish live, because a wrong `Disallow: /` takes a site out of
 * search and cannot be called back quickly (docs/dev/robots-rules.md).
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
 * A crawler's product token as RFC 9309 §2.2.1 allows it (letters, digits,
 * `_` and `-`), or `*` for every crawler.
 */
const userAgentSchema = z
  .string()
  .trim()
  .regex(
    /^(\*|[A-Za-z0-9_-]{1,64})$/,
    "a user agent is `*` or a crawler's product token (letters, digits, `_` and `-`, e.g. `Googlebot`, `GPTBot`)",
  );

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

/** One group: the crawlers it names and the paths they may or may not crawl. */
export const robotsRuleGroupSchema = z
  .object({
    userAgents: z.array(userAgentSchema).min(1).max(ROBOTS_MAX_USER_AGENTS),
    allow: z.array(pathSchema).max(ROBOTS_MAX_PATHS).default([]),
    disallow: z.array(pathSchema).max(ROBOTS_MAX_PATHS).default([]),
  })
  .strict()
  .superRefine((g, c) => {
    if (g.allow.length + g.disallow.length === 0) {
      c.addIssue({
        code: "custom",
        message: "a robots group lists at least one allow or disallow path",
      });
    }
    if (g.userAgents.includes("*") && g.userAgents.length > 1) {
      c.addIssue({
        code: "custom",
        message:
          "`*` stands alone in its group: a crawler follows only the most specific group that names it, so give a named crawler a group of its own",
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
 * then each named crawler's group in the Owner's order. No trailing
 * newline.
 *
 * The `*` group is the Owner's when they have one, else `Allow: /`. Never
 * both: RFC 9309 lets an Allow win over an equally long Disallow, so an
 * `Allow: /` next to the Owner's `Disallow: /` would quietly undo it. A
 * path no rule matches is allowed anyway.
 */
export function robotsTxtGroups(rules: RobotsRules): string {
  const lines = (g: Pick<RobotsRuleGroup, "allow" | "disallow">) => [
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
 * `User-agent`, `Allow` and `Disallow` lines, as the Owner wrote them
 * (paths not encoded). {@link parseRobotsRulesText} reads it back.
 */
export function robotsRulesText(rules: RobotsRules): string {
  return rules
    .map((g) =>
      [
        ...g.userAgents.map((a) => `User-agent: ${a}`),
        ...g.allow.map((p) => `Allow: ${p}`),
        ...g.disallow.map((p) => `Disallow: ${p}`),
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * The Settings → SEO field read back into rules: only `User-agent`,
 * `Allow` and `Disallow` lines and blank lines, every value checked by
 * {@link robotsRulesSchema}. A `User-agent` line after a rule starts the
 * next group, as in robots.txt.
 *
 * @returns the rules, or the first problem with its line number.
 */
export function parseRobotsRulesText(
  text: string,
):
  | { readonly ok: true; readonly rules: RobotsRules }
  | { readonly ok: false; readonly message: string } {
  const groups: { userAgents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    const key = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
    const value = colon === -1 ? "" : line.slice(colon + 1).trim();
    if (key !== "user-agent" && key !== "allow" && key !== "disallow") {
      return {
        ok: false,
        message: `line ${i + 1}: only User-agent, Allow and Disallow lines (Sitemap lines are written for you)`,
      };
    }
    if (value === "") {
      return { ok: false, message: `line ${i + 1}: ${lines[i]?.trim()} names nothing` };
    }
    if (key === "user-agent") {
      if (!current || current.allow.length + current.disallow.length > 0) {
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
 * and the settings page: every group that disallows the whole site
 * (`/`, `/*`) without allowing a path back.
 */
export function robotsRulesWarnings(rules: RobotsRules): string[] {
  const out: string[] = [];
  for (const g of rules) {
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
