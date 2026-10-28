// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #820 — the structure check's sources, read through the Query API
 * (`modules.list`, `layouts.list`) as the audit worker's system actor. A
 * system actor carries no chat branch, so it reads main — the state the
 * staged build was rendered from.
 *
 * A failed read throws: the runner then reports the check as failed and
 * the audit fails loudly (runner.ts), instead of reading as "no findings".
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "../../ai/tools/_describe-error.js";
import type { StructureLayout, StructureSources } from "./structure.js";
import type { StructureModule } from "./structure-analysis.js";

/** Sources backed by the Query API. */
export function structureSourcesFromOps(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
): StructureSources {
  const read = async <T>(op: string, pick: (value: unknown) => T): Promise<T> => {
    const r = await execute(registry, adapter, ctx, op, { includeDeleted: false });
    if (!r.ok) throw new Error(`${op} failed: ${describeError(r.error)}`);
    return pick(r.value);
  };
  return {
    modules: () =>
      read("modules.list", (v) =>
        (v as { modules: StructureModule[] }).modules.map((m) => ({
          id: m.id,
          slug: m.slug,
          displayName: m.displayName,
          html: m.html,
          js: m.js,
        })),
      ),
    layouts: () =>
      read("layouts.list", (v) =>
        (v as { layouts: StructureLayout[] }).layouts.map((l) => ({
          id: l.id,
          displayName: l.displayName,
          html: l.html,
          css: l.css,
        })),
      ),
  };
}
