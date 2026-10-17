// SPDX-License-Identifier: MPL-2.0

/**
 * Internal-link integrity scan, run at stage/publish.
 *
 * Migrations (and ordinary editing) routinely author internal links —
 * `<a href="/pricing">`, a `link_href` content value of `/about` — that
 * point at pages which were never built, were renamed, or were deleted.
 * A dead internal link ships a 404 to a real visitor and strands SEO
 * authority. There is no compile step that would catch it, so we scan at
 * the stage/publish boundary: collect every internal href in the pages
 * being shipped and resolve each against the set of pages that will
 * exist, returning the ones that resolve to NO page.
 *
 * Loud-honesty (CLAUDE.md §2, §11): the scan NEVER blocks staging — it
 * surfaces a `brokenInternalLinks` list in the op result so the operator
 * (and the AI) see dead links BEFORE they reach production, rather than
 * silently letting them through OR hard-failing a publish over them.
 *
 * Content values are scanned by the module's declared field kinds (#846):
 * only link-bearing fields (`link`, `url`, `link-list` hrefs, `richtext`
 * hrefs) count, so image paths and path-shaped copy are never reported.
 *
 * Bounded by design: page slugs + home flag, one pass over placed
 * modules, then one batched query per nested-module level (capped at the
 * renderer's depth limit) — independent of site size, never per row.
 */

import type { defineOperation } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { jsonbParam } from "../../sql-helpers.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** Result of {@link scanBranchInternalLinks}. */
export interface LinkIntegrityResult {
  /**
   * Distinct internal hrefs (as authored, e.g. `/pricing`) that resolve
   * to no existing page. Sorted for stable output. Empty when clean.
   */
  readonly brokenInternalLinks: string[];
  /** Total distinct internal hrefs examined — for a summary line. */
  readonly scannedCount: number;
}

/** Declared field as stored in `modules.fields` — only what the scan reads. */
interface DeclaredField {
  readonly name: string;
  readonly kind: string;
  readonly default?: unknown;
}

/** A `{ moduleId, contentInstanceId }` nested-module reference (module / module-list values). */
interface NestedRef {
  readonly moduleId: string;
  readonly contentInstanceId: string;
}

/** One rendered module unit: its HTML template, field schema, and bound values. */
interface ScanUnitRow {
  readonly module_html: string | null;
  readonly module_fields: unknown;
  readonly ci_values: unknown;
}

/**
 * Mirrors `MAX_RECURSION_DEPTH` in `@caelo-cms/shared`'s nested-module
 * renderer: nothing deeper than this ever renders, so nothing deeper can
 * ship a link. It also caps the nested pass at this many queries.
 */
const NESTED_SCAN_MAX_DEPTH = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An internal link is a same-site path reference: starts with a single
 * `/` (not `//`, which is protocol-relative → external) and carries no
 * whitespace or angle brackets. Fragments (`#…`), `mailto:`/`tel:`, and
 * absolute `http(s)://` URLs are deliberately excluded — they can't be a
 * broken *internal* page link.
 */
function isInternalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//") && /^\/[^\s"'<>]*$/.test(href);
}

/**
 * Reduce an internal href to a slug-comparable path: drop the query +
 * fragment, then strip leading/trailing slashes. `/` and `/about/` both
 * normalize cleanly (`""` and `"about"`).
 */
function normalizePath(href: string): string {
  const noFragment = href.split("#", 1)[0] ?? "";
  const noQuery = noFragment.split("?", 1)[0] ?? "";
  return noQuery.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Pull every `href="…"` / `href='…'` target out of raw module HTML. */
function extractHtmlHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    if (m[1]) out.push(m[1]);
    m = re.exec(html);
  }
  return out;
}

/** Narrow a jsonb `modules.fields` column to the declared fields it holds. */
function parseFields(raw: unknown): DeclaredField[] {
  const parsed = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  const out: DeclaredField[] = [];
  for (const f of parsed) {
    if (f === null || typeof f !== "object") continue;
    const { name, kind } = f as { name?: unknown; kind?: unknown };
    if (typeof name !== "string" || typeof kind !== "string") continue;
    out.push(f as DeclaredField);
  }
  return out;
}

/**
 * Narrow one nested-module reference. Anything not uuid-shaped is not a
 * ref the renderer could resolve — and must not reach the `::uuid` cast in
 * the nested query, where it would abort the publish tx.
 */
function asNestedRef(value: unknown): NestedRef | null {
  if (value === null || typeof value !== "object") return null;
  const { moduleId, contentInstanceId } = value as Record<string, unknown>;
  if (typeof moduleId !== "string" || typeof contentInstanceId !== "string") return null;
  if (!UUID_RE.test(moduleId) || !UUID_RE.test(contentInstanceId)) return null;
  return { moduleId, contentInstanceId };
}

/**
 * Collect the internal hrefs a content_instance's `values` will render,
 * driven by the module's DECLARED field kinds (#846). Only link-bearing
 * kinds contribute: `link` / `url` values, `link-list` item `href`s, and
 * `href` attributes inside `richtext`. `image` (`/media/...`), `text`,
 * `text-list`, `number`, and `boolean` are never links, even when the
 * string happens to start with `/` — counting them produced a wall of
 * false "broken link" warnings that buried the real ones.
 *
 * A value with no declared field is never rendered, so it is not a link —
 * there is no "any path-shaped string" fallback (CLAUDE.md §2). Lookup
 * mirrors the template engine: the instance's value wins, else the field's
 * `default` (which is what the page then renders); keys compare
 * case-insensitively.
 *
 * `module` / `module-list` values go onto `nestedRefs`: nested modules are
 * not `page_modules` placements, so the caller scans them separately.
 */
function collectValueHrefs(
  values: unknown,
  fields: readonly DeclaredField[],
  out: string[],
  nestedRefs: NestedRef[],
): void {
  const byName = new Map<string, unknown>();
  if (values !== null && typeof values === "object" && !Array.isArray(values)) {
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      byName.set(k.toLowerCase(), v);
    }
  }
  const pushIfInternal = (href: unknown): void => {
    if (typeof href === "string" && isInternalHref(href)) out.push(href);
  };

  for (const field of fields) {
    const key = field.name.toLowerCase();
    const raw = byName.has(key) ? byName.get(key) : field.default;
    switch (field.kind) {
      case "link":
      case "url":
        pushIfInternal(raw);
        break;
      case "link-list":
        if (Array.isArray(raw)) {
          for (const item of raw) {
            if (item !== null && typeof item === "object") {
              pushIfInternal((item as { href?: unknown }).href);
            }
          }
        }
        break;
      case "richtext":
        if (typeof raw === "string") {
          for (const h of extractHtmlHrefs(raw)) pushIfInternal(h);
        }
        break;
      case "module": {
        const ref = asNestedRef(raw);
        if (ref) nestedRefs.push(ref);
        break;
      }
      case "module-list":
        if (Array.isArray(raw)) {
          for (const item of raw) {
            const ref = asNestedRef(item);
            if (ref) nestedRefs.push(ref);
          }
        }
        break;
      default:
        // image / text / text-list / number / boolean: never a page link.
        break;
    }
  }
}

/** Add every internal href one module unit renders; queue its nested refs. */
function collectUnitHrefs(row: ScanUnitRow, hrefs: Set<string>, nestedRefs: NestedRef[]): void {
  if (typeof row.module_html === "string") {
    for (const h of extractHtmlHrefs(row.module_html)) {
      if (isInternalHref(h)) hrefs.add(h);
    }
  }
  const values = typeof row.ci_values === "string" ? safeParse(row.ci_values) : row.ci_values;
  const collected: string[] = [];
  collectValueHrefs(values, parseFields(row.module_fields), collected, nestedRefs);
  for (const h of collected) hrefs.add(h);
}

/**
 * Scan every internal link in the pages visible to `chatBranchId` (its
 * branched pages + published main pages) and return the hrefs that
 * resolve to no page. Call it AFTER the branch has been merged to the
 * live tables (so it reads post-merge state), inside the same tx.
 *
 * @param tx           Active admin-DB transaction.
 * @param chatBranchId The publishing chat's branch, or null for a
 *                     main-only scan. Branched pages of this chat are
 *                     included in both the link source and the slug set.
 */
export async function scanBranchInternalLinks(
  tx: Tx,
  chatBranchId: string | null,
): Promise<LinkIntegrityResult> {
  const branchFilter = chatBranchId
    ? sql`AND (p.chat_branch_id IS NULL OR p.chat_branch_id = ${chatBranchId}::uuid)`
    : sql`AND p.chat_branch_id IS NULL`;

  // (1) The path universe every link resolves against (#390): the
  // COMPOSED public paths of pages visible to the branch — plugin
  // prefixes included — plus the slug shape as a legacy alias so
  // pre-composition content that links "/<slug>" doesn't false-flag.
  const pageRows = (await tx.execute(sql`
    SELECT DISTINCT p.slug AS slug, p.current_path AS current_path,
           (p.parent_page_id IS NOT NULL) AS nested
    FROM pages p
    WHERE p.deleted_at IS NULL ${branchFilter}
  `)) as unknown as { slug: string; current_path: string; nested: boolean }[];
  const validSlugs = new Set<string>();
  for (const r of pageRows) {
    validSlugs.add(normalizePath(r.current_path));
    // The legacy alias is a top-level shape only: "/<slug>" is not where
    // a nested page lives (0263), so a link there must not count as valid.
    if (!r.nested) validSlugs.add(normalizePath(`/${r.slug}`));
  }

  const homeRows = (await tx.execute(sql`
    SELECT home_page_id::text AS home_page_id FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as { home_page_id: string | null }[];
  const hasHomepage = (homeRows[0]?.home_page_id ?? null) !== null;

  // (2) One pass over placed modules: raw module HTML + its declared
  // fields (they decide which values are links) + the bound
  // content_instance values, for every placement on a visible page.
  const placementRows = (await tx.execute(sql`
    SELECT DISTINCT m.html AS module_html, m.fields AS module_fields, ci."values" AS ci_values
    FROM page_modules pm
    JOIN pages p ON p.id = pm.page_id AND p.deleted_at IS NULL ${branchFilter}
    JOIN modules m ON m.id = pm.module_id AND m.deleted_at IS NULL
    JOIN content_instances ci ON ci.id = pm.content_instance_id
  `)) as unknown as ScanUnitRow[];

  const hrefs = new Set<string>();
  let pending: NestedRef[] = [];
  for (const row of placementRows) collectUnitHrefs(row, hrefs, pending);

  // (3) Nested modules (`module` / `module-list` values) render inside
  // their parent but have no placement of their own, so step (2) never
  // sees their HTML or values. Walk them breadth-first — one batched
  // query per nesting level, capped at the renderer's depth limit — and
  // visit each (module, instance) pair once so reference cycles terminate.
  const visited = new Set<string>();
  for (let depth = 0; depth < NESTED_SCAN_MAX_DEPTH && pending.length > 0; depth += 1) {
    const level: NestedRef[] = [];
    for (const ref of pending) {
      const key = `${ref.moduleId}:${ref.contentInstanceId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      level.push(ref);
    }
    pending = [];
    if (level.length === 0) break;
    const nestedRows = (await tx.execute(sql`
      SELECT m.html AS module_html, m.fields AS module_fields, ci."values" AS ci_values
      FROM jsonb_to_recordset(${jsonbParam(level)}) AS r("moduleId" uuid, "contentInstanceId" uuid)
      JOIN modules m ON m.id = r."moduleId" AND m.deleted_at IS NULL
      JOIN content_instances ci ON ci.id = r."contentInstanceId" AND ci.deleted_at IS NULL
    `)) as unknown as ScanUnitRow[];
    for (const row of nestedRows) collectUnitHrefs(row, hrefs, pending);
  }

  /**
   * A path resolves if it's a known slug or the site root (when a
   * homepage exists). Leniency is deliberate — this warns, it doesn't
   * block, so a false positive is worse than missing an edge case
   * (CLAUDE.md §2 loud-but-honest).
   */
  const resolves = (path: string): boolean => {
    if (path === "") return hasHomepage; // bare `/`
    return validSlugs.has(path);
  };

  const broken: string[] = [];
  for (const href of hrefs) {
    if (!resolves(normalizePath(href))) broken.push(href);
  }
  broken.sort();

  return { brokenInternalLinks: broken, scannedCount: hrefs.size };
}

/** Parse a jsonb-as-text column; tolerate a malformed blob. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
