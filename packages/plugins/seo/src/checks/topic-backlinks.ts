// SPDX-License-Identifier: MPL-2.0

/**
 * #1759 — article ↔ topic page: a page carrying a term whose topic page
 * exists links back to that topic page. The topic page lists the article
 * (its page query); the article's term chip leads readers and crawlers to
 * the topic. Only when the topic page exists: a term without one has no URL
 * and nothing to link (maintainer decision: curated topic pages only).
 *
 * Objective (the link is on the staged page or not), reported as a warning:
 * the page works without it.
 */

import type { PluginAuditFinding } from "@caelo-cms/plugin-sdk";
import { readVocabularies } from "../topics/operations.js";
import { rowsOf } from "../topics/page-index.js";
import type { SeoAuditRule } from "./index.js";

/** A path without its trailing slash (the root stays `/`). */
function bare(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The `topic-backlink` rule family. */
export const TOPIC_BACKLINK_RULES: SeoAuditRule = {
  name: "topic-pages",
  facts: async (ctx, { facts }) => {
    const [rows, vocabularies] = await Promise.all([
      rowsOf(
        ctx,
        facts.map((f) => f.pageId),
      ),
      readVocabularies(ctx),
    ]);
    const topicOf = new Map(
      vocabularies.flatMap((v) =>
        v.terms
          .filter((t) => t.topicPage !== null)
          .map(
            (t) =>
              [
                `${v.slug}/${t.itemId}`,
                { name: t.name, path: bare(t.topicPage as string) },
              ] as const,
          ),
      ),
    );
    const rowOf = new Map(rows.map((r) => [r.page_id, r]));
    const findings: PluginAuditFinding[] = [];
    for (const f of facts) {
      const row = rowOf.get(f.pageId);
      if (!row) continue;
      const linked = new Set(f.links.flatMap((l) => (l.path === null ? [] : [bare(l.path)])));
      const missing = new Map<string, string>();
      for (const [vocab, ids] of Object.entries(row.terms)) {
        for (const id of ids) {
          const topic = topicOf.get(`${vocab}/${id}`);
          if (!topic || topic.path === bare(f.path) || linked.has(topic.path)) continue;
          missing.set(topic.path, topic.name);
        }
      }
      for (const [path, name] of missing) {
        findings.push({
          rule: "topic-backlink",
          severity: "warning",
          pageId: f.pageId,
          message: `Topic page not linked: the page carries the term "${name}", whose topic page ${path} lists it, but does not link back to it.`,
          fix: {
            tool: "update_modules_many",
            hint: "show the page's terms as chips that link their overview page ({{#page.terms.<vocabulary>}}{{#link}}<a href=\"{{link}}\">{{name}}</a>{{/link}}{{/page.terms.<vocabulary>}}) in the page type's template",
          },
        });
      }
    }
    return findings;
  },
};
