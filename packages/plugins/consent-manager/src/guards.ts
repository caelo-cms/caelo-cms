// SPDX-License-Identifier: MPL-2.0

/**
 * Embed verdicts: which modules reach a third party, and what was decided
 * about each (`module_guards`).
 *
 * ## Where the scan runs, and where it does not (#1214, #1267)
 *
 * Judging a module means reading its source and every content value it
 * renders with — the vendor URL usually sits in a value, not in markup.
 * Doing that for the whole site on every preview made a render's cost
 * grow with the site.
 *
 * So the judgement is STORED and kept current where content changes:
 *
 * - `module_changes` — the plugin's change consumer (#1267): the host
 *   hands it the committed module and content-instance changes from the
 *   change journal, per branch, in that branch's scope (a chat's branch or
 *   main), on any instance and after a restart alike (the cursor is
 *   persisted). Only those modules are re-read and their guards
 *   rewritten, so a draft's verdicts live on the draft and publish with it.
 * - `scan_modules` — the consumer's rebuild (first activation, or a cursor
 *   behind the journal's retention) and the scheduled worker rescan the
 *   whole site on main.
 *
 * Render hooks then read verdicts only (`gatedCategoryKeys`,
 * `guardsByModule`): no module or content-instance list on the render
 * path. The deferral gate still judges the content it is handed, so an
 * edit the verdicts have not caught up with is withheld, never shipped.
 */

import type { PluginAdminQuery, PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import { moduleHosts } from "./scan.js";
import { adminQueryOf, cmsOf, type GuardRow } from "./storage.js";

/**
 * Which consent category a set of third-party hosts falls under, or
 * null when any of them is unrecognised.
 *
 * Null is deliberately sticky: one unknown host makes the whole module
 * unclassified, because the known ones say nothing about what the
 * unknown one does.
 */
export function classifyHosts(hosts: ReadonlyArray<string>): string | null {
  let strongest: string | null = null;
  for (const host of hosts) {
    const match = Object.entries(HOST_CATEGORIES).find(
      ([domain]) => host === domain || host.endsWith(`.${domain}`),
    );
    if (!match) return null;
    const category = match[1];
    // Marketing wins over analytics: a module carrying both must be
    // held to the stricter of the two.
    if (category === "marketing" || strongest === null) strongest = category;
  }
  return strongest;
}

/**
 * Vendors whose category is not in question, so the common cases need
 * no operator decision. Everything else is `pending` until someone
 * says otherwise — the list is a shortcut, never a judgement that an
 * absent host is harmless.
 */
const HOST_CATEGORIES: Readonly<Record<string, string>> = {
  "youtube.com": "marketing",
  "youtube-nocookie.com": "functional",
  "vimeo.com": "marketing",
  "google.com": "marketing",
  "googleapis.com": "marketing",
  "gstatic.com": "functional",
  "googletagmanager.com": "marketing",
  "google-analytics.com": "analytics",
  "doubleclick.net": "marketing",
  "facebook.net": "marketing",
  "facebook.com": "marketing",
  "twitter.com": "marketing",
  "x.com": "marketing",
  "linkedin.com": "marketing",
  "instagram.com": "marketing",
  "hotjar.com": "analytics",
  "openstreetmap.org": "functional",
  "soundcloud.com": "marketing",
  "spotify.com": "marketing",
};

/** A module's third-party hosts now, next to the verdict stored for it (if any). */
export interface EmbedScan {
  readonly moduleId: string;
  readonly moduleSlug: string;
  /** Site chrome (header, footer, navigation): withheld, it vanishes from every page. */
  readonly siteChrome: boolean;
  readonly hosts: string[];
  readonly guard: GuardRow | undefined;
}

/** The verdict a guard row should hold, as stored fields. */
type GuardVerdict = Pick<GuardRow, "category_key" | "detected_hosts" | "status" | "decided_by">;

/**
 * What a module's guard should say given the hosts it reaches now (the
 * same `moduleHosts` judgement the render-time gate applies):
 *
 * - `null` — no third-party host; any stored guard is stale.
 * - the stored guard — the hosts it was decided about are unchanged.
 * - a fresh verdict — vendor-table classification, else pending.
 */
export function verdictFor(scan: EmbedScan): GuardVerdict | null {
  if (scan.hosts.length === 0) return null;
  const existing = scan.guard;
  if (existing && JSON.stringify(existing.detected_hosts ?? []) === JSON.stringify(scan.hosts)) {
    return existing;
  }
  // Hosts changed under an existing verdict (or none was recorded): the
  // decision was made about a different set, so it no longer applies.
  const known = classifyHosts(scan.hosts);
  return {
    category_key: known ?? existing?.category_key ?? "marketing",
    detected_hosts: scan.hosts,
    status: known ? "gated" : "pending",
    decided_by: known ? "vendor-table" : "",
  };
}

/** Rows (and `anyOf` values) per storage read — the broker's ceiling. */
const PAGE = 1000;

/**
 * Every guard row, read page by page — no cap, because a guard missing
 * from the read is a verdict silently ignored (CLAUDE.md §2).
 *
 * Pages follow `created_at`. The rows sharing the last timestamp of a
 * full page are read as their own group before moving past it, so a tie
 * at a page boundary can neither drop nor repeat a row.
 */
export async function allGuards(q: PluginAdminQuery): Promise<GuardRow[]> {
  const out = new Map<string, GuardRow>();
  let since: string | undefined;
  for (;;) {
    const page = (await q.list("module_guards", {
      orderBy: "created_at",
      orderDir: "asc",
      limit: PAGE,
      ...(since ? { since } : {}),
    })) as unknown as Array<GuardRow & { created_at: string }>;
    for (const g of page) out.set(g.id, g);
    const last = page[page.length - 1]?.created_at;
    if (page.length < PAGE || last === undefined) return [...out.values()];
    const tied = (await q.list("module_guards", {
      created_at: last,
      limit: PAGE,
    })) as unknown as GuardRow[];
    if (tied.length >= PAGE) {
      throw new Error(
        `consent-manager: ${PAGE} or more module guards share the creation time ${last}, so they cannot be paged by it — rescan with scan_modules to rewrite them`,
      );
    }
    for (const g of tied) out.set(g.id, g);
    since = last;
  }
}

/** The stored guard of each of these modules, in reads of at most 1000 ids. */
export async function guardsByModule(
  q: PluginAdminQuery,
  moduleIds: ReadonlyArray<string>,
): Promise<Map<string, GuardRow>> {
  const ids = [...new Set(moduleIds)];
  const out = new Map<string, GuardRow>();
  for (let i = 0; i < ids.length; i += PAGE) {
    const rows = (await q.list("module_guards", {
      anyOf: { module_id: ids.slice(i, i + PAGE) },
      limit: PAGE,
    })) as unknown as GuardRow[];
    for (const g of rows) out.set(g.module_id, g);
  }
  return out;
}

/**
 * The consent categories a stored verdict withholds something behind —
 * what the banner must offer so those modules can be consented to. One
 * "is there any" read per category, so the cost does not grow with the
 * number of modules or guards.
 */
export async function gatedCategoryKeys(
  q: PluginAdminQuery,
  categoryKeys: ReadonlyArray<string>,
): Promise<Set<string>> {
  const used = new Set<string>();
  for (const key of categoryKeys) {
    const hit = await q.list("module_guards", { status: "gated", category_key: key, limit: 1 });
    if (hit.length > 0) used.add(key);
  }
  return used;
}

interface ModuleRow {
  id: string;
  slug: string;
  kind: string;
  html: string;
  css: string;
  js: string;
  fields?: unknown;
}

/**
 * Modules with their current hosts and stored guard — every module, or
 * only `moduleIds`. Read-only; in a chat it reads the chat's branch, so
 * the verdicts follow the modules the chat just edited. Not for render
 * hooks: with no `moduleIds` it reads the whole site.
 */
export async function scanEmbeds(
  ctx: PluginContextTier1,
  moduleIds?: ReadonlyArray<string>,
): Promise<EmbedScan[]> {
  const q = adminQueryOf(ctx);
  const cms = cmsOf(ctx);
  const filter = moduleIds ? { moduleIds: [...new Set(moduleIds)] } : {};
  const { modules } = await cms.call<{ modules: ModuleRow[] }>("modules.list", filter);
  // The vendor URL is DATA, not markup. Authoring lifts
  // `src="https://youtube.com/…"` out of the HTML into a field
  // default, and a placement can point the same module at a
  // different vendor through its content values. Scanning the HTML
  // alone would therefore find nothing on exactly the modules that
  // matter most.
  const { instances } = await cms.call<{
    instances: Array<{ moduleId: string; values: unknown }>;
  }>("content_instances.list", filter);
  const valuesByModule = new Map<string, unknown[]>();
  for (const inst of instances) {
    const bucket = valuesByModule.get(inst.moduleId) ?? [];
    bucket.push(inst.values ?? {});
    valuesByModule.set(inst.moduleId, bucket);
  }
  const guards = await guardsByModule(
    q,
    modules.map((m) => m.id),
  );
  return modules.map((m) => ({
    moduleId: m.id,
    moduleSlug: m.slug,
    siteChrome: m.kind === "chrome",
    hosts: moduleHosts({ ...m, contentValues: valuesByModule.get(m.id) ?? [] }),
    guard: guards.get(m.id),
  }));
}

/**
 * Bring guard rows in line with what modules reach now — every module
 * (`scan_modules`, first activation), or the ones a write changed
 * (`module_changes`). A guard whose module is gone, or no longer reaches
 * out, is dropped: left in place it would keep its category on offer and
 * withhold a now-harmless module.
 */
export async function syncGuards(
  ctx: PluginContextTier1,
  moduleIds?: ReadonlyArray<string>,
): Promise<{ flagged: number; cleared: number }> {
  const q = adminQueryOf(ctx);
  let flagged = 0;
  let cleared = 0;
  if (moduleIds && moduleIds.length === 0) return { flagged, cleared };
  const scans = await scanEmbeds(ctx, moduleIds);
  const present = new Set(scans.map((s) => s.moduleId));
  const stored = moduleIds
    ? [...(await guardsByModule(q, moduleIds)).values()]
    : await allGuards(q);
  for (const orphan of stored.filter((g) => !present.has(g.module_id))) {
    await q.delete("module_guards", orphan.id);
    cleared += 1;
  }
  for (const scan of scans) {
    const verdict = verdictFor(scan);
    const existing = scan.guard;
    if (verdict === null) {
      if (existing) {
        await q.delete("module_guards", existing.id);
        cleared += 1;
      }
      continue;
    }
    if (verdict === existing) continue;
    if (existing) {
      await q.update("module_guards", existing.id, verdict);
    } else {
      await q.insert("module_guards", { module_id: scan.moduleId, ...verdict });
    }
    flagged += 1;
  }
  return { flagged, cleared };
}
