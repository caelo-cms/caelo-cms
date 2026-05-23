// SPDX-License-Identifier: MPL-2.0

/**
 * Lint-style guard: every mutation op file in `ops/content/` and the
 * mutation revert ops in `ops/snapshots/` must call `emitSnapshot`.
 *
 * Why this exists instead of Postgres triggers:
 *   - Triggers force the state JSONB shape to be duplicated in PL/pgSQL,
 *     which would undo the parseAndUpgrade*State validators added under
 *     improvement #4. State construction lives in TypeScript where it's
 *     typechecked.
 *   - Multi-row aggregates (pages.set_modules, template_blocks.set,
 *     revert_site) need one snapshot per *operation*, not one per row.
 *     A FOR EACH ROW trigger over-emits; a FOR EACH STATEMENT trigger
 *     can't see the full payload from inside Postgres.
 *
 * This test reads the source files and asserts the invariant — it's the
 * structural guarantee, just written in TypeScript instead of SQL.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONTENT_OPS_DIR = join(__dirname, "..", "ops", "content");
const SNAPSHOT_OPS_DIR = join(__dirname, "..", "ops", "snapshots");

/** Heuristic: a mutation op exports a defineOperation whose name ends with
 * one of these verbs. Read-only ops (.list, .get, .render_preview, .impact)
 * intentionally do NOT emit snapshots. */
const MUTATION_VERB_RE =
  /name:\s*"(\w+)\.(create|update|delete|set|set_modules|revert_site|revert_module|revert_template|revert_page)"/;

function listTsFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".ts"));
}

// v0.12.0 — page-module-content.ts is a routing shim that delegates
// to content_instances.set_values for the actual write + snapshot.
// The lint counts the op declaration but the emitSnapshot lives in
// content-instances.ts; allowlist this file so the lint doesn't flag
// the legitimate router pattern.
const ROUTER_SHIM_FILES = new Set(["page-module-content.ts"]);

describe("snapshot-emission coverage", () => {
  it("every mutation op in ops/content/ calls emitSnapshot", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(CONTENT_OPS_DIR)) {
      if (ROUTER_SHIM_FILES.has(file)) continue;
      const path = join(CONTENT_OPS_DIR, file);
      const text = readFileSync(path, "utf8");
      // Skip non-op files (preview, etc.).
      if (!MUTATION_VERB_RE.test(text)) continue;
      // Each mutation handler must call emitSnapshot at least once.
      const opMatches = text.match(/name:\s*"\w+\.\w+"/g) ?? [];
      const emitMatches = text.match(/emitSnapshot\(tx/g) ?? [];
      // Count mutation ops in this file (defineOperation entries with a
      // mutation verb in the name).
      const mutationOps = opMatches.filter((m) => MUTATION_VERB_RE.test(m)).length;
      if (mutationOps > emitMatches.length) {
        offenders.push(
          `${file}: ${mutationOps} mutation ops, ${emitMatches.length} emitSnapshot calls`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every revert op in ops/snapshots/ calls emitSnapshot with revertOf set", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SNAPSHOT_OPS_DIR)) {
      if (!file.startsWith("revert_")) continue;
      const path = join(SNAPSHOT_OPS_DIR, file);
      const text = readFileSync(path, "utf8");
      if (!text.includes("emitSnapshot(tx")) {
        offenders.push(`${file}: missing emitSnapshot call`);
        continue;
      }
      if (!text.includes("revertOf:")) {
        offenders.push(`${file}: missing revertOf field on emitSnapshot call`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
