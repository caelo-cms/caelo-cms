// SPDX-License-Identifier: MPL-2.0

/**
 * Whether robots.txt lets a crawler fetch a path, the way RFC 9309 §2.2.2
 * reads a group: the longest matching rule wins, an Allow wins a tie, and
 * a path no rule matches may be fetched. `*` matches any characters, a
 * closing `$` ends the match. Paths are compared as the rules store them
 * (core writes characters outside ASCII percent-encoded; the page paths
 * core names are compared the same way).
 */

import type { RobotsRules } from "@caelo-cms/plugin-sdk";
import type { RobotsGroup } from "./crawler-policy.js";
import { groupOf } from "./crawler-policy.js";

/** A rule pattern as a regular expression anchored at the path's start. */
function patternRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** May the crawlers of `group` fetch `path`? */
export function groupAllows(group: RobotsGroup | undefined, path: string): boolean {
  if (!group) return true;
  let best: { length: number; allow: boolean } | null = null;
  const consider = (pattern: string, allow: boolean) => {
    if (!patternRegex(pattern).test(path)) return;
    const length = pattern.length;
    if (!best || length > best.length || (length === best.length && allow && !best.allow)) {
      best = { length, allow };
    }
  };
  for (const p of group.allow) consider(p, true);
  for (const p of group.disallow) consider(p, false);
  return (best as { allow: boolean } | null)?.allow ?? true;
}

/** May `token` fetch `path` under `rules` (its own group, else `*`)? */
export function mayFetch(rules: RobotsRules, token: string, path: string): boolean {
  return groupAllows(groupOf(rules, token), path);
}
