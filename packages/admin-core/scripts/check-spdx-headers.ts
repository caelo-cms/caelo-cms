#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * P17 PR1 — lint that flags any source file missing the SPDX header.
 * CLAUDE.md §5 mandates `// SPDX-License-Identifier: MPL-2.0` on every
 * source file; this script keeps new files from regressing.
 *
 * Walks .ts / .svelte / .sql under repo root. Skips node_modules,
 * dist, output, and any path matching the standard exclude list.
 * Exits non-zero on hits.
 */

import { Glob } from "bun";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const patterns = ["**/*.ts", "**/*.svelte", "**/*.sql"];
const EXCLUDE = [
  "node_modules",
  "/dist/",
  "/output/",
  "/.svelte-kit/",
  "/_local/",
  "/coverage/",
  // Generated files — drizzle migrations land via codegen and we don't
  // own the header convention for those snapshot files.
  "/.drizzle/",
];

const SPDX_RE = /SPDX-License-Identifier:\s*MPL-2\.0/;

let total = 0;
let flagged = 0;
const hits: string[] = [];

for (const pattern of patterns) {
  const glob = new Glob(pattern);
  for await (const rel of glob.scan(root)) {
    if (EXCLUDE.some((needle) => rel.includes(needle))) continue;
    total++;
    const file = await Bun.file(`${root}/${rel}`).text();
    // Inspect only the first 20 lines — the header MUST be near the top
    // and inspecting the whole file is slow + false-positives on
    // documentation snippets that quote the SPDX line.
    const head = file.split("\n").slice(0, 20).join("\n");
    if (SPDX_RE.test(head)) continue;
    flagged++;
    hits.push(rel);
  }
}

if (flagged > 0) {
  console.error(
    `\n[check-spdx-headers] ${flagged}/${total} source files missing SPDX header.\n`,
  );
  for (const h of hits.slice(0, 30)) console.error(`  ${h}`);
  if (hits.length > 30) console.error(`  …and ${hits.length - 30} more.`);
  console.error(
    `\nFix: add \`// SPDX-License-Identifier: MPL-2.0\` (or \`-- SPDX-License-Identifier: MPL-2.0\` for .sql) as the first source line.\n`,
  );
  process.exit(1);
}
console.log(`[check-spdx-headers] OK (${total} files checked).`);
