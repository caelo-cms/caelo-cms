// SPDX-License-Identifier: MPL-2.0

/**
 * Nested modules in the static build: the modules a page reaches only
 * through a `module` / `module-list` field (a card inside a card grid,
 * a plan inside a pricing table). They have no `page_modules` row, so
 * the per-page placement query never sees them; this pass batch-loads
 * them for the composer's recursive renderer (the one the editor
 * preview uses — `nested-module-render.ts` in shared), and afterwards
 * refuses any page that still carries a render failure marker.
 *
 * Main-line rows only, the same rule as every other generator read: a
 * nested instance a chat created but has not staged yet is absent here,
 * which renders as `content-instance-missing` and fails the build loudly
 * (CLAUDE.md §2) instead of shipping the parent without it.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type ComposeModuleFailure,
  collectNestedRefs,
  type ModuleFieldKind,
  type NestedContentInstanceResource,
  type NestedModuleResource,
  type NestedRenderResolver,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/**
 * The renderer stops at depth 8, so 8 rounds of reference-following is
 * enough to load everything it can reach.
 */
const MAX_LOAD_ROUNDS = 8;

/** A module as the composer receives it — what the pass reads refs from. */
interface ComposeModuleValues {
  readonly fields?: readonly { name: string; kind?: ModuleFieldKind; default?: unknown }[];
  readonly contentValues?: Readonly<Record<string, unknown>>;
}

/**
 * The values a placed module renders with: its content values over its
 * field defaults (a layout module has only defaults; a list default can
 * hold nested refs too).
 */
function effectiveValues(m: ComposeModuleValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of m.fields ?? []) if (f.default !== undefined) out[f.name] = f.default;
  return { ...out, ...(m.contentValues ?? {}) };
}

function parseJson(raw: unknown): unknown {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

function parseFields(raw: unknown): NestedModuleResource["fields"] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  const out: { name: string; kind: ModuleFieldKind; default?: unknown }[] = [];
  for (const f of parsed) {
    if (!f || typeof f !== "object") continue;
    const o = f as { name?: unknown; kind?: unknown; default?: unknown };
    if (typeof o.name !== "string") continue;
    // Same deliberate cast as generate.ts' parseModuleFields: an unknown
    // kind reaches the engine, which reports kind-mismatch loudly.
    const kind = (typeof o.kind === "string" ? o.kind : "text") as ModuleFieldKind;
    out.push({ name: o.name, kind, default: o.default });
  }
  return out;
}

/**
 * Batch-load every module and content instance reachable through nested
 * refs from `placed` (the composer-ready modules of every page in the
 * build, after content variants), following refs transitively.
 *
 * @returns a resolver for `ComposeInput.nestedModules`. Refs that point
 *   at deleted or chat-only rows stay unresolved; the renderer reports
 *   them as `module-missing` / `content-instance-missing`.
 */
export async function loadNestedModules(
  tx: TransactionRunner,
  placed: Iterable<ComposeModuleValues>,
): Promise<NestedRenderResolver> {
  const modules = new Map<string, NestedModuleResource>();
  const instances = new Map<string, NestedContentInstanceResource>();
  const tried = new Set<string>();
  let pendingModules = new Set<string>();
  let pendingInstances = new Set<string>();
  const enqueue = (values: Record<string, unknown>): void => {
    for (const ref of collectNestedRefs(values)) {
      if (!tried.has(`m:${ref.moduleId}`)) pendingModules.add(ref.moduleId);
      if (!tried.has(`ci:${ref.contentInstanceId}`)) pendingInstances.add(ref.contentInstanceId);
    }
  };
  for (const m of placed) enqueue(effectiveValues(m));

  for (let round = 0; round < MAX_LOAD_ROUNDS; round += 1) {
    if (pendingModules.size === 0 && pendingInstances.size === 0) break;
    const moduleIds = [...pendingModules].filter(isUuid);
    const instanceIds = [...pendingInstances].filter(isUuid);
    for (const id of pendingModules) tried.add(`m:${id}`);
    for (const id of pendingInstances) tried.add(`ci:${id}`);
    pendingModules = new Set();
    pendingInstances = new Set();

    if (moduleIds.length > 0) {
      const rows = (await tx.execute(sql`
        SELECT id::text AS id, slug, html, css, js, fields::text AS fields
        FROM modules
        WHERE id IN (${sql.join(
          moduleIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          AND deleted_at IS NULL
          AND chat_branch_id IS NULL
      `)) as unknown as {
        id: string;
        slug: string;
        html: string;
        css: string;
        js: string;
        fields: string | null;
      }[];
      for (const r of rows) {
        modules.set(r.id, {
          moduleId: r.id,
          slug: r.slug,
          html: r.html,
          css: r.css,
          js: r.js,
          fields: parseFields(r.fields),
        });
      }
    }
    if (instanceIds.length > 0) {
      const rows = (await tx.execute(sql`
        SELECT id::text AS id, module_id::text AS module_id, "values"::text AS values
        FROM content_instances
        WHERE id IN (${sql.join(
          instanceIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          AND deleted_at IS NULL
          AND chat_branch_id IS NULL
      `)) as unknown as { id: string; module_id: string; values: string | null }[];
      for (const r of rows) {
        const parsed = parseJson(r.values);
        const values =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
        instances.set(r.id, { id: r.id, moduleId: r.module_id, values, deletedAt: null });
        enqueue(values);
      }
    }
  }

  return {
    getModule: (id) => modules.get(id) ?? null,
    getContentInstance: (id) => instances.get(id) ?? null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A ref whose id is not a UUID can match no row; querying with it would
 * make Postgres reject the whole batch. Skipping it leaves the ref
 * unresolved, which the renderer reports as missing.
 */
function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * Failure markers that leave the author's raw `{{…}}` text in place
 * instead of a `caelo:` comment. Visible on the page rather than silent,
 * and a placeholder can be legitimate copy (documentation showing the
 * template syntax), so they are reported by the editor's missing-content
 * surface and do not stop a deploy. `plugin-list-unavailable` is refused
 * separately, with plugin-specific guidance (assertNoPluginMarkers).
 */
const LOUD_RAW_MARKERS = [
  "field-not-declared:",
  "theme-asset-unbound:",
  "plugin-list-unavailable:",
];

/**
 * A `caelo:` marker comment in finished HTML: the engine's
 * `caelo:missing reason=…` and the nested escape hatch
 * `caelo:module(-list) <name> needs recursive renderer`.
 */
const MARKER_COMMENT_RE = /<!--\s*caelo:(?:missing|module|module-list)\b[^>]*-->/g;

/** How many failures the error lists before summarising the rest. */
const MAX_LISTED = 25;

/** One composed page as the render-failure gate inspects it. */
export interface RenderedPageForGate {
  readonly pageSlug: string;
  readonly html: string;
  readonly moduleFailures: readonly ComposeModuleFailure[];
}

/**
 * Throw when any page would ship a render failure: a module or nested
 * module whose content could not be rendered (malformed list item,
 * missing or deleted nested module, depth limit, cycle, …) or any
 * `caelo:` marker comment in the HTML. Before this gate those pages
 * deployed with the section silently empty — the HTML comment is
 * invisible to visitors and to the operator (CLAUDE.md §2).
 *
 * Exported for tests.
 */
export function assertNoRenderFailures(pages: readonly RenderedPageForGate[]): void {
  const lines: string[] = [];
  for (const page of pages) {
    let structured = 0;
    for (const f of page.moduleFailures) {
      if (LOUD_RAW_MARKERS.some((p) => f.reason.startsWith(p))) continue;
      structured += 1;
      const field = f.field.length > 0 ? ` field "${f.field}"` : "";
      lines.push(
        `page "${page.pageSlug}" module "${f.moduleSlug}" (block ${f.blockName})${field}: ${f.reason}`,
      );
    }
    // Backstop for markers that did not come through the structured
    // channel (e.g. a marker comment stored inside module HTML).
    if (structured === 0) {
      for (const m of page.html.matchAll(MARKER_COMMENT_RE)) {
        lines.push(`page "${page.pageSlug}": ${m[0]}`);
      }
    }
  }
  if (lines.length === 0) return;
  const listed = lines.slice(0, MAX_LISTED).join("; ");
  const more = lines.length > MAX_LISTED ? `; …and ${lines.length - MAX_LISTED} more` : "";
  throw new Error(
    `static-generator: ${lines.length} render failure(s) would ship as missing content — ${listed}${more}. ` +
      "Each names the page, the module and the field whose content could not be rendered. " +
      "Next step: open the page in the editor (the preview flags the same spots), then repair the field — " +
      "AI: get_content_instance on the module's content, then set_content_instance_values with a valid " +
      "{ moduleId, contentInstanceId } reference or without the broken item — and Stage again.",
  );
}
