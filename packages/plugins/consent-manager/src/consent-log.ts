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
        field: "consent_id",
        content:
          "A random identifier the banner creates on the first decision and keeps in the caelo_consent cookie, so one browser's later changes can be shown as one history. It identifies nothing outside the consent log: no other cookie, plugin or request uses it.",
      },
    ],
    notStored: [
      "IP address or any hash of it",
      "user agent",
      "page URL",
      "any identifier other plugins use (e.g. the visitor id of ratings)",
      "name, e-mail or any account data",
    ],
    retentionDays,
    storage:
      "In this site's own public database (cms_public, table plugin_consent_manager.consent_log) on the site's hosting — not sent to Caelo or any third party.",
    deletion: [
      `Automatically after ${retentionDays} days by the daily retention job.`,
      "All records at once when the consent plugin is uninstalled (export first in the admin's consent panel — there is no recovery).",
    ],
    privacyPolicyText: `When you make a choice in our cookie banner, we store a record of it as proof of your consent: the date and time, the categories you accepted, the version of our consent policy and a random consent identifier that is also kept in the consent cookie in your browser, so that later changes to your choice can be matched to it. The record contains no IP address and no browser details. The record is kept on our own hosting for ${retentionDays} days and then deleted automatically. The legal basis is our legal obligation to be able to demonstrate consent (Art. 7(1) and Art. 6(1)(c) GDPR). You can change or withdraw your choice at any time through the cookie settings link on every page.`,
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
    // The same shares labelled for the Owner's consent panel.
    categoryShares: categories
      .filter((c) => !c.required)
      .map((c) => ({
        label: `${c.display_name} granted (%)`,
        value: share(perCategory.get(c.key) ?? 0, total),
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

/**
 * One CSV cell of the consent export. The rows are visitor-written
 * cms_public data (#635), and the file is meant to be opened in a
 * spreadsheet: every cell is quoted with its quotes doubled, and a value a
 * spreadsheet would run as a formula (=, +, -, @, tab, CR) is prefixed with
 * an apostrophe so it stays text.
 */
export function csvCell(value: string | null | undefined): string {
  const text = value ?? "";
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

const logPageArgs = z
  .object({
    before: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

/** A logged decision as the Owner sees it. */
const loggedRecord = z.object({
  id: z.string(),
  consent_id: z.string().nullable(),
  granted: z.array(z.string()),
  policy_version: z.number().int(),
  created_at: z.union([z.date(), z.string()]),
});

/** One decision, ready to show or export. */
export interface ConsentRecord {
  readonly id: string;
  readonly recordedAt: string;
  readonly consentId: string;
  readonly policyVersion: number;
  readonly granted: ReadonlyArray<string>;
}

const millis = (at: Date | string) => new Date(at).getTime();

/**
 * One newest-first page of the log, for the Owner's consent panel.
 *
 * The page never ends inside a millisecond: the driver hands timestamps
 * back at millisecond precision while the column keeps microseconds, so a
 * cursor taken from a row that shares its millisecond with the next row
 * would either repeat or skip that row on the next page. The page is
 * therefore cut before such a millisecond, and the cursor (`nextBefore`)
 * excludes exactly the milliseconds already shown.
 */
export async function consentLogPage(query: PluginQuery, args: unknown) {
  const parsed = logPageArgs.safeParse(args ?? {});
  if (!parsed.success) throw new Error(describeIssues("list_log", parsed.error));
  const limit = parsed.data.limit ?? 50;
  const raw = await query.list("consent_log", {
    ...(parsed.data.before ? { before: parsed.data.before } : {}),
    limit: limit + 1,
    orderBy: "created_at",
    orderDir: "desc",
  });
  const rows: ConsentRecord[] = [];
  let unreadable = 0;
  for (const r of raw) {
    // cms_public rows are visitor-written (#635): shown only in the
    // declared shape, and a row that does not fit is counted, not shown.
    const row = loggedRecord.safeParse(r);
    if (!row.success) {
      unreadable += 1;
      continue;
    }
    rows.push({
      id: row.data.id,
      recordedAt: new Date(row.data.created_at).toISOString(),
      // Records written before the consent id existed carry none.
      consentId: row.data.consent_id ?? "",
      policyVersion: row.data.policy_version,
      granted: row.data.granted,
    });
  }
  const hasMore = raw.length > limit;
  let page = hasMore ? rows.slice(0, limit) : rows;
  const lastKept = rows[limit - 1];
  const firstLeft = rows[limit];
  if (hasMore && lastKept && firstLeft) {
    const boundary = millis(lastKept.recordedAt);
    if (millis(firstLeft.recordedAt) === boundary) {
      page = page.filter((r) => millis(r.recordedAt) !== boundary);
      if (page.length === 0) {
        throw new Error(
          `list_log: more than ${limit} decisions were recorded in the same millisecond; ask for a larger \`limit\` (up to 500)`,
        );
      }
    }
  }
  const last = page.at(-1);
  return {
    rows: page,
    hasMore,
    ...(hasMore && last ? { nextBefore: last.recordedAt } : {}),
    ...(unreadable > 0 ? { unreadableRecords: unreadable } : {}),
  };
}

/** The most records one export holds; retention normally keeps the log far below it. */
const MAX_EXPORT_ROWS = 200_000;

/**
 * The whole log as CSV, newest first — the evidence a DPO or an authority
 * asks for. Only the Owner reaches it (the admin panel's download).
 */
export async function consentLogCsv(query: PluginQuery) {
  const lines = ["recorded_at,consent_id,policy_version,granted"];
  let before: string | undefined;
  let count = 0;
  for (;;) {
    const page = await consentLogPage(query, { limit: 500, ...(before ? { before } : {}) });
    for (const r of page.rows) {
      lines.push(
        [r.recordedAt, r.consentId, String(r.policyVersion), r.granted.join(" ")]
          .map(csvCell)
          .join(","),
      );
    }
    count += page.rows.length;
    if (!page.hasMore || !page.nextBefore) break;
    if (count >= MAX_EXPORT_ROWS) {
      throw new Error(
        `export_log: the consent log holds more than ${MAX_EXPORT_ROWS} records; shorten the retention period in the consent settings or export from the database directly`,
      );
    }
    before = page.nextBefore;
  }
  return { csv: lines.join("\n"), rows: count };
}
