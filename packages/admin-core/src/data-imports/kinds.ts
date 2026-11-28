// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: the kinds that can be imported right now. The core's own
 * kinds (redirects) and every kind an active plugin declares in `imports`.
 * A plugin that is not active has no kinds: its tools are absent, not
 * filtered (CLAUDE.md §2, activation is a hard state).
 *
 * A kind writes checked, resolved rows into its storage and removes them
 * again. Core kinds do it through their own ops; plugin kinds through the
 * operations they name, called by the plugin host under the caller's
 * invocation, so a plugin writes with its own grants only.
 */

import { isPluginDisabled, loadedPlugins, runPluginOperation } from "@caelo-cms/plugin-host";
import type { PluginImportKind, PluginInvocation } from "@caelo-cms/plugin-sdk";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, ImportKindBase, ImportValue } from "@caelo-cms/shared";
import { redirectsImportKind } from "./kinds-redirects.js";

/** Who the writes run as, and the plugin invocation for plugin kinds. */
export interface ImportWriteContext {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  readonly ctx: ExecutionContext;
  readonly invocation: PluginInvocation;
}

/** One checked, resolved row a kind writes. */
export interface ImportWriteRow {
  readonly rowId: string;
  readonly sourceKey: string;
  readonly parentRowId: string | null;
  readonly pageId: string | null;
  readonly values: Readonly<Record<string, ImportValue | null>>;
  /** The import already holds this row: overwrite it. */
  readonly update: boolean;
}

/** What a write did. `written` lists the rows the kind stored, with what it calls them. */
export type ImportWriteResult =
  | {
      readonly ok: true;
      readonly written: ReadonlyMap<string, string | null>;
      readonly refused: ReadonlyArray<{ readonly rowId: string; readonly detail: string }>;
    }
  | { readonly ok: false; readonly message: string };

/** One importable kind. */
export interface ImportKind {
  /** `core` or the owning plugin's slug. */
  readonly owner: string;
  readonly declaration: ImportKindBase;
  /** Most rows one `write` call takes. */
  readonly writeBatch: number;
  write(
    w: ImportWriteContext,
    importId: string,
    rows: readonly ImportWriteRow[],
  ): Promise<ImportWriteResult>;
  /**
   * Remove rows the kind stored for this import. `targetRefs` are what
   * `write` reported per row. Called when an import is undone before any
   * build carried it, and always for kinds with release `target`.
   */
  remove(
    w: ImportWriteContext,
    importId: string,
    targetRefs: readonly (string | null)[],
  ): Promise<void>;
}

const CORE_KINDS: readonly ImportKind[] = [redirectsImportKind];

/** Names the core keeps for its own kinds; a plugin cannot declare them. */
export const CORE_IMPORT_KIND_NAMES: ReadonlySet<string> = new Set(
  CORE_KINDS.map((k) => k.declaration.kind),
);

/** Most rows one call of a plugin's apply operation takes. */
const PLUGIN_WRITE_BATCH = 500;

/** How a plugin kind runs its operations: the plugin host, or a test's stand-in. */
export type PluginOperationRunner = (opts: {
  readonly pluginSlug: string;
  readonly operationName: string;
  readonly args: unknown;
  readonly invocation: PluginInvocation;
}) => Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly message: string } }
>;

/** The kind a plugin declares, writing through its operations. */
export function pluginImportKind(
  slug: string,
  decl: PluginImportKind,
  run: PluginOperationRunner,
): ImportKind {
  const { apply, remove, ...declaration } = decl;
  return {
    owner: slug,
    declaration,
    writeBatch: PLUGIN_WRITE_BATCH,
    write: async (w, importId, rows) => {
      // Without an apply operation core's rows are all there is; the plugin
      // reads them through `ctx.imports`.
      if (!apply)
        return { ok: true, written: new Map(rows.map((r) => [r.rowId, null])), refused: [] };
      const r = await run({
        pluginSlug: slug,
        operationName: apply,
        args: { importId, rows },
        invocation: w.invocation,
      });
      if (!r.ok) return { ok: false, message: r.error.message };
      const refused = refusedOf(r.value);
      const refusedIds = new Set(refused.map((x) => x.rowId));
      return {
        ok: true,
        written: new Map(rows.filter((x) => !refusedIds.has(x.rowId)).map((x) => [x.rowId, null])),
        refused,
      };
    },
    remove: async (w, importId) => {
      if (!remove) return;
      const r = await run({
        pluginSlug: slug,
        operationName: remove,
        args: { importId },
        invocation: w.invocation,
      });
      if (!r.ok) throw new Error(`${slug}.${remove} failed: ${r.error.message}`);
    },
  };
}

const pluginKindCache = new WeakMap<PluginImportKind, ImportKind>();

/** One kind object per declaration, so its tool stays the same object across turns. */
function pluginKind(slug: string, decl: PluginImportKind): ImportKind {
  const cached = pluginKindCache.get(decl);
  if (cached) return cached;
  const kind = pluginImportKind(
    slug,
    decl,
    (opts) => runPluginOperation(opts) as ReturnType<PluginOperationRunner>,
  );
  pluginKindCache.set(decl, kind);
  return kind;
}

/** The `refused` rows a plugin's apply operation reported, checked. */
function refusedOf(value: unknown): { rowId: string; detail: string }[] {
  const list = (value as { refused?: unknown } | null)?.refused;
  if (!Array.isArray(list)) return [];
  return list.flatMap((x) =>
    x && typeof x.rowId === "string" && typeof x.detail === "string"
      ? [{ rowId: x.rowId, detail: x.detail.slice(0, 300) }]
      : [],
  );
}

/** Every kind that can be imported now: the core's, then active plugins' by slug. */
export function importKinds(): ImportKind[] {
  const plugins = loadedPlugins
    .all()
    .filter((lp) => lp.tier === 1 && !isPluginDisabled(lp.slug))
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .flatMap((lp) => (lp.definition.imports ?? []).map((d) => pluginKind(lp.slug, d)));
  return [...CORE_KINDS, ...plugins];
}

/** The kind named `kind`, or undefined when no active owner declares it. */
export function importKind(kind: string): ImportKind | undefined {
  return importKinds().find((k) => k.declaration.kind === kind);
}
