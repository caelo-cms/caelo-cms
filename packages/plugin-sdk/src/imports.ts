// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports a plugin offers (docs/data-imports.md).
 *
 * A plugin declares the kinds of data it can take over from another system
 * in `imports`: the fields of one row and, optionally, the operations that
 * store and remove the rows. Core does everything else: it reads files and
 * tool calls, checks every row against the fields, resolves pages and
 * parents, keeps rows idempotent, reports, gives the AI one tool per kind
 * (`import_<kind>`), and decides when rows reach visitors.
 *
 * Core always keeps the rows, and the plugin reads them with
 * `ctx.imports.rows(kind)` as the environment it runs for shows them
 * (rating totals added to the votes a worker counts). Optionally:
 *
 * - `apply`: core hands every batch of checked rows to it before keeping
 *   them. It may refuse single rows (a check across fields) and may store
 *   them in the plugin's own storage too (comments write their archive
 *   through a core operation).
 * - `remove`: an `apply` that stores rows declares it; it takes an
 *   import's rows away again when the import is undone before a Stage
 *   shipped it.
 *
 * Needs the `chat_runner_tools` grant: every kind is an AI tool.
 */

import {
  CORE_IMPORT_KINDS,
  type ImportKindBase,
  type ImportValue,
  importKindBase,
} from "@caelo-cms/shared";
import { z } from "zod";

/** Most import kinds one plugin declares. */
export const MAX_IMPORT_KINDS = 4;

/** Manifest form of one import kind. */
export const pluginImportKind = importKindBase
  .extend({
    /** The operation that stores checked rows ({@link PluginImportApplyArgs}). */
    apply: z.string().min(1).max(120).optional(),
    /** The operation that removes an import's rows ({@link PluginImportRemoveArgs}). */
    remove: z.string().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((k, ctx) => {
    if (k.remove !== undefined && k.apply === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["remove"],
        message: "`remove` takes away what `apply` stored: declare `apply` too",
      });
    if (k.release === "target" && k.apply === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["release"],
        message:
          "release `target` means the plugin's storage keeps the rows: declare `apply` and `remove`",
      });
    if ((CORE_IMPORT_KINDS as readonly string[]).includes(k.kind))
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: `"${k.kind}" is a core import kind`,
      });
  });
export type PluginImportKind = z.infer<typeof pluginImportKind>;
/** What a plugin definition writes (fields before defaults). */
export type PluginImportKindInput = z.input<typeof pluginImportKind>;

/** One row `apply` receives: checked, with its page and parent resolved. */
export interface PluginImportRow {
  /** The row's id; use it as the stored row's id so a retried call overwrites instead of duplicating. */
  readonly rowId: string;
  readonly sourceKey: string;
  /** The parent row's id (`parentKey` resolved), when the kind has parents. */
  readonly parentRowId: string | null;
  /** The page a `pageRef` field resolved to. */
  readonly pageId: string | null;
  readonly values: Readonly<Record<string, ImportValue | null>>;
  /** The import already holds the row; this call changes it. */
  readonly update: boolean;
}

/** Arguments of a kind's `apply` operation. */
export interface PluginImportApplyArgs {
  readonly importId: string;
  readonly rows: readonly PluginImportRow[];
}

/** What `apply` returns: the rows it refused, with why (others count as stored). */
export interface PluginImportApplyResult {
  readonly refused?: ReadonlyArray<{ readonly rowId: string; readonly detail: string }>;
}

/** Arguments of a kind's `remove` operation. */
export interface PluginImportRemoveArgs {
  readonly importId: string;
}

/** One imported row as `ctx.imports.rows` returns it. */
export interface PluginImportedRow {
  readonly rowId: string;
  readonly sourceKey: string;
  readonly parentRowId: string | null;
  readonly pageId: string | null;
  readonly values: Readonly<Record<string, ImportValue | null>>;
}

/**
 * `ctx.imports`: the rows of the plugin's own kinds, as the public database
 * the call writes shows them. A staging run sees what the Stage shipped, a
 * build's render what the build carries, every other call (worker, tool,
 * panel) what Publish live shipped. Drafts never reach a plugin.
 */
export interface PluginImports {
  /** Up to `limit` (1000 at most) rows, ordered by `rowId`, after `afterRowId`. */
  rows(
    kind: string,
    opts?: {
      readonly pageIds?: readonly string[];
      readonly afterRowId?: string;
      readonly limit?: number;
    },
  ): Promise<readonly PluginImportedRow[]>;
}

export type { ImportKindBase };
