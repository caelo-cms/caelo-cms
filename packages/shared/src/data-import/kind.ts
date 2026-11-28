// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: what an import kind declares. The core declares its own
 * kinds (redirects); a plugin declares its kinds in `imports` of its
 * definition (`@caelo-cms/plugin-sdk`, which adds the operations that write
 * and remove the rows). Every kind gets one AI tool, `import_<kind>`.
 * Docs: docs/data-imports.md.
 */

import { z } from "zod";
import { importFieldMap } from "./fields.js";

/** A kind's name: also the tool name after `import_`. */
export const IMPORT_KIND_NAME = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * When imported rows reach visitors.
 *
 * - `stage`: the import framework decides. The rows are a draft until the
 *   Stage that ships the import's chat, are on staging from that Stage on and
 *   on the live site from the Publish live that ships it (a rollback takes
 *   them back with the release). The kind's storage filters by it.
 * - `target`: the storage the kind writes has a draft model of its own
 *   (redirects: Draft, Staged, Live); the import only writes into it.
 */
export const IMPORT_RELEASE_MODES = ["stage", "target"] as const;
export type ImportReleaseMode = (typeof IMPORT_RELEASE_MODES)[number];

/** The part of a kind every owner declares the same way. */
export const importKindBase = z
  .object({
    kind: z
      .string()
      .regex(IMPORT_KIND_NAME, "a kind name is lowercase letters, digits and `_` (e.g. comments)"),
    /** What the operator calls one row's kind, plural ("Comments"). */
    label: z.string().min(1).max(60),
    /** For the AI: what is imported and where it ends up. The tool description's first line. */
    description: z.string().min(1).max(600),
    /** For the AI: where common systems keep this data. Names systems, never code paths of them. */
    sources: z.string().min(1).max(600).optional(),
    fields: importFieldMap,
    /** Rows may name a parent row by its `sourceKey` (`parentKey`). */
    parents: z.boolean().optional(),
    release: z.enum(IMPORT_RELEASE_MODES),
  })
  .strict();
export type ImportKindBase = z.infer<typeof importKindBase>;

/** Kind names the core keeps for its own kinds; no plugin declares them. */
export const CORE_IMPORT_KINDS = ["redirects"] as const;

/** The tool name of a kind. */
export function importToolName(kind: string): string {
  return `import_${kind}`;
}
