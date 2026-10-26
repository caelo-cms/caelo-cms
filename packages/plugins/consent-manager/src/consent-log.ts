// SPDX-License-Identifier: MPL-2.0

/**
 * The consent log seen from the operator's side: what it holds (#1132)
 * and how visitors decide, in aggregate (#1131).
 *
 * The log itself is personal data — when a browser decided, under which
 * id. So the AI never reads its rows: the statistics below return counts
 * only, and the raw export is the Owner's, through the admin panel.
 */

import type { PluginQuery } from "@caelo-cms/plugin-sdk";
import { z } from "@caelo-cms/plugin-sdk";
import type { CategoryRow } from "./categories.js";
import { describeIssues } from "./tags.js";

/**
 * The log, field by field, in the terms a privacy policy and a record of
 * processing need. Kept next to `record_consent`'s insert in spirit: a
 * field added there must be described here.
 */
export function describeConsentLog(retentionDays: number) {
  return {
    storedFields: [
      { field: "created_at", content: "Date and time of the decision." },
      {
        field: "granted",
        content: "The consent categories the visitor accepted (e.g. necessary, analytics).",
      },
      {
        field: "policy_version",
        content: "The version of the consent policy the decision answered.",
      },
      {
        field: "visitor_id",
        content:
          "A random identifier from the caelo_visitor_id cookie — stored only when this very decision grants the category that covers that cookie (see the visitor id's category in consent_status); empty otherwise.",
      },
      {
        field: "ip_hash",
        content:
          "Stored empty: Caelo does not pass the visitor's IP address, or any hash of it, to plugins. No IP data is kept in the consent log.",
      },
    ],
    notStored: ["IP address", "user agent", "page URL", "name, e-mail or any account data"],
    retentionDays,
    storage:
      "In this site's own public database (cms_public, table plugin_consent_manager.consent_log) on the site's hosting — not sent to Caelo or any third party.",
    deletion: [
      `Automatically after ${retentionDays} days by the daily retention job.`,
      "All records at once when the consent plugin is uninstalled (export first in the admin's consent panel — there is no recovery).",
    ],
    privacyPolicyText: `When you make a choice in our cookie banner, we store a record of it as proof of your consent: the date and time, the categories you accepted and the version of our consent policy. If you allowed the category that covers our visitor identifier, the record also holds that random identifier; it contains no IP address and no browser details. The record is kept on our own hosting for ${retentionDays} days and then deleted automatically. The legal basis is our legal obligation to be able to demonstrate consent (Art. 7(1) and Art. 6(1)(c) GDPR). You can change or withdraw your choice at any time through the cookie settings link on every page.`,
  };
}

const statsArgs = z.object({ days: z.number().int().min(1).max(3650).optional() }).strict();

/** A logged row as far as the statistics read it; anything else is not counted. */
const loggedDecision = z.object({
  id: z.string(),
  granted: z.array(z.string()),
  policy_version: z.number().int(),
  created_at: z.union([z.date(), z.string()]),
});

/** Rows read per page, and the most one statistics call reads. */
const PAGE = 1000;
const MAX_ROWS = 200_000;

type Kind = "acceptAll" | "rejectAll" | "custom";
const share = (n: number, total: number) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);

/**
 * How visitors decide, over the last `days` (default 30): share of
 * accept-all, reject-all and custom choices, per category and per policy
 * version. Counts only — no row, id or timestamp leaves this function.
 *
 * "Accept all" means every optional category the banner offers now was
 * granted; "reject all" means none was. The log has no count query, so
 * it is paged by `created_at` like the retention job does.
 */
export async function consentStats(
  query: PluginQuery,
  args: unknown,
  categories: ReadonlyArray<CategoryRow>,
  offered: ReadonlySet<string>,
) {
  const parsed = statsArgs.safeParse(args ?? {});
  if (!parsed.success) throw new Error(describeIssues("consent_stats", parsed.error));
  const days = parsed.data.days ?? 30;
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const optional = categories.filter((c) => !c.required && offered.has(c.key)).map((c) => c.key);

  const totals: Record<Kind, number> = { acceptAll: 0, rejectAll: 0, custom: 0 };
  const perCategory = new Map(categories.map((c) => [c.key, 0]));
  const perVersion = new Map<number, Record<Kind, number>>();
  let total = 0;
  let unreadable = 0;
  let truncated = false;
  const seen = new Set<string>();
  let since = from.toISOString();
  for (;;) {
    const page = await query.list("consent_log", {
      since,
      limit: PAGE,
      orderBy: "created_at",
      orderDir: "asc",
    });
    let fresh = 0;
    let last: string | null = null;
    for (const raw of page) {
      // cms_public rows are visitor-written (#635): only a row of the
      // declared shape is counted.
      const row = loggedDecision.safeParse(raw);
      if (!row.success) {
        unreadable += 1;
        continue;
      }
      last = new Date(row.data.created_at).toISOString();
      // `since` is millisecond-precise and the column is not, so a page
      // can repeat the rows of its boundary millisecond.
      if (seen.has(row.data.id)) continue;
      seen.add(row.data.id);
      fresh += 1;
      total += 1;
      const granted = new Set(row.data.granted);
      const optionalGranted = optional.filter((k) => granted.has(k)).length;
      // With nothing optional on offer, "all" and "none" coincide; a
      // decision then counts as rejecting.
      const kind: Kind =
        optionalGranted === 0
          ? "rejectAll"
          : optionalGranted === optional.length
            ? "acceptAll"
            : "custom";
      totals[kind] += 1;
      const v = perVersion.get(row.data.policy_version) ?? {
        acceptAll: 0,
        rejectAll: 0,
        custom: 0,
      };
      v[kind] += 1;
      perVersion.set(row.data.policy_version, v);
      for (const k of granted)
        if (perCategory.has(k)) perCategory.set(k, (perCategory.get(k) ?? 0) + 1);
    }
    if (page.length < PAGE || fresh === 0 || last === null) break;
    if (total >= MAX_ROWS) {
      truncated = true;
      break;
    }
    since = last;
  }
  return {
    days,
    from: from.toISOString(),
    decisions: total,
    acceptAll: { count: totals.acceptAll, percent: share(totals.acceptAll, total) },
    rejectAll: { count: totals.rejectAll, percent: share(totals.rejectAll, total) },
    custom: { count: totals.custom, percent: share(totals.custom, total) },
    perCategory: categories.map((c) => ({
      key: c.key,
      label: c.display_name,
      required: c.required,
      granted: perCategory.get(c.key) ?? 0,
      percent: share(perCategory.get(c.key) ?? 0, total),
    })),
    perPolicyVersion: [...perVersion.entries()]
      .sort(([a], [b]) => a - b)
      .map(([policyVersion, k]) => ({
        policyVersion,
        decisions: k.acceptAll + k.rejectAll + k.custom,
        ...k,
      })),
    ...(truncated
      ? {
          truncated: true,
          note: `Counted the first ${MAX_ROWS} decisions; pass fewer days for the rest.`,
        }
      : {}),
    ...(unreadable > 0 ? { unreadableRecords: unreadable } : {}),
  };
}
