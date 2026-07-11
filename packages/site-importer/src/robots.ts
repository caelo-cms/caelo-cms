// SPDX-License-Identifier: MPL-2.0

/**
 * issue #192 — minimal robots.txt support for the import crawler.
 *
 * Politeness, not security: Caelo's UA will hit third-party servers
 * on operator request, and an OSS product that ignores robots.txt
 * earns blocklist entries. Scope is deliberately small: User-agent
 * groups, Allow/Disallow prefix rules (longest match wins; Allow wins
 * ties), Crawl-delay, and Sitemap discovery lines. No wildcards/$
 * (rare in the fields we care about; unsupported patterns degrade to
 * literal-prefix behaviour).
 *
 * Fetch failures are FAIL-OPEN by design: an unreachable robots.txt
 * must not veto a crawl the site owner asked for — the caller logs it.
 */

export interface RobotsRules {
  readonly disallow: readonly string[];
  readonly allow: readonly string[];
  /** Crawl-delay converted to ms, or null when absent/invalid. */
  readonly crawlDelayMs: number | null;
  /** Sitemap: lines (absolute URLs per spec) — group-independent. */
  readonly sitemaps: readonly string[];
}

const EMPTY_RULES: RobotsRules = { disallow: [], allow: [], crawlDelayMs: null, sitemaps: [] };

/**
 * Parse robots.txt for `userAgentToken` (falling back to the `*`
 * group). Group semantics per the de-facto standard: consecutive
 * User-agent lines share the rule block that follows; the most
 * specific matching group wins outright (no merging with `*`).
 */
export function parseRobotsTxt(txt: string, userAgentToken: string): RobotsRules {
  const token = userAgentToken.toLowerCase();
  const sitemaps: string[] = [];

  interface Group {
    agents: string[];
    disallow: string[];
    allow: string[];
    crawlDelayMs: number | null;
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of txt.split("\n")) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "sitemap") {
      if (value.length > 0) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!lastLineWasAgent || current === null) {
        current = { agents: [], disallow: [], allow: [], crawlDelayMs: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;
    if (!current) continue;
    if (field === "disallow" && value.length > 0) current.disallow.push(value);
    else if (field === "allow" && value.length > 0) current.allow.push(value);
    else if (field === "crawl-delay") {
      const secs = Number(value);
      if (Number.isFinite(secs) && secs > 0) current.crawlDelayMs = Math.min(secs, 30) * 1000;
    }
  }

  // Most specific match: a group naming our token (substring match, as
  // crawlers conventionally do) beats `*`; no group at all = no rules.
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes("*"));
  const winner = specific ?? wildcard;
  if (!winner) return { ...EMPTY_RULES, sitemaps };
  return {
    disallow: winner.disallow,
    allow: winner.allow,
    crawlDelayMs: winner.crawlDelayMs,
    sitemaps,
  };
}

/** Longest-prefix-match wins; Allow wins length ties (Google semantics). */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  let bestDisallow = -1;
  for (const d of rules.disallow) {
    if (path.startsWith(d) && d.length > bestDisallow) bestDisallow = d.length;
  }
  if (bestDisallow === -1) return true;
  for (const a of rules.allow) {
    if (path.startsWith(a) && a.length >= bestDisallow) return true;
  }
  return false;
}
