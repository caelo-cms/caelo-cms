// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — writes `packages/shared/test-fixtures/template-core-parity.golden.json`:
 * what a base checkout's template engine renders for the core-parity
 * matrix (`packages/shared/src/template-core-parity-fixtures.test.ts`), and
 * what its `fieldPathProblems` says of `{{&…}}` paths. The test of the same
 * name holds this checkout's engine to it, with core values only and with
 * an unused plugin value next to them: a plugin's value must never change
 * how core values render.
 *
 * Run it against the commit whose core rendering is the reference (a
 * worktree of main, with node_modules reachable from it), only when core
 * rendering changes on purpose:
 *
 *   git worktree add --detach /tmp/base origin/main
 *   ln -s "$PWD/node_modules" /tmp/base/node_modules
 *   bun scripts/template-core-parity-golden.ts /tmp/base
 */

import { join } from "node:path";
import {
  CORE_PARITY_FIELD_PATHS,
  CORE_PARITY_FIELDS,
  CORE_PARITY_VALUES,
  coreParityTemplates,
} from "../packages/shared/src/template-core-parity-fixtures.test.js";

const base = process.argv[2];
if (!base) throw new Error("usage: bun scripts/template-core-parity-golden.ts <base checkout>");
const engine = await import(join(base, "packages/shared/src/template-engine.ts"));
const sections = await import(join(base, "packages/shared/src/template-sections.ts"));
const renders = coreParityTemplates().map((html) => {
  const r = engine.renderTemplate({
    html,
    fields: CORE_PARITY_FIELDS,
    contentValues: CORE_PARITY_VALUES,
  });
  return [r.html, r.missingSlots];
});
const fieldPaths = sections.fieldPathProblems(CORE_PARITY_FIELD_PATHS, CORE_PARITY_FIELDS);
const out = join(
  import.meta.dir,
  "../packages/shared/test-fixtures/template-core-parity.golden.json",
);
await Bun.write(out, `${JSON.stringify({ renders, fieldPaths })}\n`);
console.log(`wrote ${renders.length} renders to ${out}`);
