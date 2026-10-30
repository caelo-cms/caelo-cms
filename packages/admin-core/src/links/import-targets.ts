// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout C, maintainer decision on open point 1: option b) —
 * the pages an active site import has planned but not rebuilt yet, as
 * pending link targets.
 *
 * In the migrate flow (#278) the AI rebuilds a crawled site page by
 * page: the homepage links to /pricing long before /pricing is built,
 * and write-time canonicalisation refuses a link to a page that does
 * not exist. While an import run is active for the WRITING chat, a link
 * to one of that run's planned pages is therefore kept literal (never
 * refused) and recorded against the run in `import_run_links`.
 * `imports.resolve_links` (the skill's closing step; the run's cleanup
 * runs it too) converts those links once the pages exist; what still
 * matches no page is a finding in the run report.
 *
 * The scope is import-run state, never a flag a caller sets:
 *
 *   - the run belongs to the writing chat (`import_runs.chat_session_id`
 *     → that session's branch) and is still active (not completed /
 *     failed);
 *   - "planned" is what the crawl recorded for the run: every import
 *     page's source path, the URL it was requested under and its
 *     proposed slug, the run's approved URL list, and every same-site
 *     page the crawled pages link to (the homepage's own navigation is
 *     the page map of a homepage-first migration). A link to any other
 *     unknown path is still refused — a typo is not a planned page.
 *
 * A planned page that is ALREADY rebuilt (`import_pages.accepted_page_id`)
 * resolves straight to that page, even when it was rebuilt under a
 * translated slug: the source path names it.
 */

import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import { normaliseLinkPath, type PendingLinkTarget } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** The active import runs of one chat and the paths they plan. */
export interface ActiveImportTargets {
  /** Planned path → the runs that plan it (normally one). */
  readonly runsByPath: ReadonlyMap<string, readonly string[]>;
  /** Planned path → the live page that already rebuilds it. */
  readonly rebuiltByPath: ReadonlyMap<string, string>;
  /** The crawled sites' hosts (and www / apex twins): an absolute link to them means a planned page. */
  readonly sourceHosts: readonly string[];
}

function pathOf(url: string | null, base?: string): string | null {
  if (!url) return null;
  try {
    return normaliseLinkPath(new URL(url, base).pathname);
  } catch {
    return null;
  }
}

function hostsOf(sourceUrl: string): string[] {
  let u: URL;
  try {
    u = new URL(sourceUrl);
  } catch {
    // Every run is created through a z.string().url() input, so this is
    // corrupt data: refusing beats silently treating the run as off-site.
    throw new Error(
      `import run source_url ${JSON.stringify(sourceUrl)} is not a URL; its links cannot be planned`,
    );
  }
  const host = u.hostname.toLowerCase();
  const port = u.port ? `:${u.port}` : "";
  const twin = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  return [`${host}${port}`, `${twin}${port}`];
}

// `href="…"` / `href='…'` in crawled module HTML. The value classes
// exclude their own quote, so each match is linear.
const HREF_RE = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** Same-site page paths the crawled HTML links to. */
function linkedPaths(html: string, pageUrl: string, hosts: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(HREF_RE)) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (raw.length === 0 || raw.startsWith("#") || raw.includes("{{")) continue;
    let u: URL;
    try {
      u = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (!hosts.has(u.host.toLowerCase())) continue;
    out.push(normaliseLinkPath(u.pathname));
  }
  return out;
}

/**
 * Load the planned pages of every import run that is still active
 * (neither completed nor failed) for the chat on `chatBranchId`. Null
 * when there is none — the common case, and then nothing changes for
 * the write.
 */
export async function loadActiveImportTargets(
  tx: TransactionRunner,
  chatBranchId: string,
): Promise<ActiveImportTargets | null> {
  const runs = (await tx.execute(sql`
    SELECT r.id::text AS id, r.source_url, r.explicit_urls
      FROM import_runs r
      JOIN chat_sessions cs ON cs.id = r.chat_session_id
     WHERE cs.chat_branch_id = ${chatBranchId}::uuid
       AND r.status NOT IN ('completed', 'failed')
  `)) as unknown as { id: string; source_url: string; explicit_urls: unknown }[];
  if (runs.length === 0) return null;
  const pages = (await tx.execute(sql`
    SELECT ip.run_id::text AS run_id, ip.source_url, ip.requested_url, ip.proposed_slug,
           ip.proposed_modules, p.id::text AS rebuilt_page_id
      FROM import_pages ip
      LEFT JOIN pages p ON p.id = ip.accepted_page_id AND p.deleted_at IS NULL
     WHERE ip.run_id = ANY(${uuidArray(runs.map((r) => r.id))})
       AND ip.rejected_at IS NULL
  `)) as unknown as {
    run_id: string;
    source_url: string;
    requested_url: string | null;
    proposed_slug: string;
    proposed_modules: unknown;
    rebuilt_page_id: string | null;
  }[];

  const runsByPath = new Map<string, string[]>();
  const rebuiltByPath = new Map<string, string>();
  const add = (path: string | null, runId: string): void => {
    if (path === null) return;
    const list = runsByPath.get(path) ?? [];
    if (!list.includes(runId)) list.push(runId);
    runsByPath.set(path, list);
  };
  const hostsByRun = new Map<string, Set<string>>();
  const sourceHosts: string[] = [];
  for (const r of runs) {
    const hosts = hostsOf(r.source_url);
    hostsByRun.set(r.id, new Set(hosts));
    sourceHosts.push(...hosts);
    const explicit = r.explicit_urls;
    if (Array.isArray(explicit)) {
      for (const u of explicit) if (typeof u === "string") add(pathOf(u), r.id);
    }
  }
  for (const p of pages) {
    const own = [pathOf(p.source_url), pathOf(p.requested_url)];
    const slug = p.proposed_slug.trim().replace(/^\/+/, "");
    if (slug.length > 0) own.push(normaliseLinkPath(`/${slug}`));
    for (const path of own) {
      add(path, p.run_id);
      if (path !== null && p.rebuilt_page_id !== null) rebuiltByPath.set(path, p.rebuilt_page_id);
    }
    const hosts = hostsByRun.get(p.run_id) ?? new Set<string>();
    const modules = p.proposed_modules;
    if (Array.isArray(modules)) {
      for (const m of modules) {
        const html = (m as { html?: unknown } | null)?.html;
        if (typeof html === "string") {
          for (const path of linkedPaths(html, p.source_url, hosts)) add(path, p.run_id);
        }
      }
    }
  }
  return { runsByPath, rebuiltByPath, sourceHosts };
}

/** What a write must record: its pending links and the entity holding them. */
export interface PendingLinkRecord {
  readonly targets: ActiveImportTargets;
  readonly pending: readonly PendingLinkTarget[];
}

/**
 * The entity kinds whose links an import run's finalisation rewrites:
 * content instances, modules (HTML + field defaults) and shared lists
 * (epic #1107 — a migrated menu links pages the run builds later).
 */
export const IMPORT_LINK_ENTITY_KINDS = ["content_instance", "module", "list"] as const;

/** One of {@link IMPORT_LINK_ENTITY_KINDS}. */
export type ImportLinkEntityKind = (typeof IMPORT_LINK_ENTITY_KINDS)[number];

/**
 * Record links a write kept literal because they point at a planned
 * page, against the entity that holds them. A link seen again is
 * re-marked pending (a later write may have re-introduced a literal the
 * finalisation had already converted).
 */
export async function recordPendingImportLinks(
  tx: TransactionRunner,
  record: PendingLinkRecord | null,
  entity: { readonly kind: ImportLinkEntityKind; readonly id: string },
): Promise<void> {
  if (record === null) return;
  for (const p of record.pending) {
    for (const runId of record.targets.runsByPath.get(p.path) ?? []) {
      await tx.execute(sql`
        INSERT INTO import_run_links (run_id, value, status, entity_kind, entity_id, location)
        VALUES (${runId}::uuid, ${p.value}, 'pending', ${entity.kind}, ${entity.id}::uuid, ${p.where})
        ON CONFLICT (run_id, value, entity_kind, entity_id) DO UPDATE SET
          status = 'pending', location = EXCLUDED.location, updated_at = now()
      `);
    }
  }
}
