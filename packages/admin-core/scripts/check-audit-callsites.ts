#!/usr/bin/env bun

// SPDX-License-Identifier: MPL-2.0

/**
 * P16 hardening — lint that flags `recordAudit(...)` callsites missing
 * `requestId:` (or which should use `recordAuditFromCtx(tx, ctx, ...)`).
 * Run from CI to keep new ops from regressing the request-correlation
 * surface that audit_events.request_id depends on.
 *
 * Heuristic: any `recordAudit(` call whose argument block doesn't
 * contain the literal token `requestId:` AND whose containing function
 * has a parameter named `ctx` is flagged. Hits prefer `recordAuditFromCtx`.
 *
 * Exit non-zero on hits.
 */

import { resolve } from "node:path";
import { Glob } from "bun";

const root = resolve(import.meta.dir, "..");
const glob = new Glob("src/**/*.ts");

let total = 0;
let flagged = 0;
const hits: Array<{ file: string; line: number; snippet: string }> = [];

for await (const rel of glob.scan(root)) {
  if (rel.includes("/__tests__/") || rel.endsWith(".test.ts")) continue;
  if (rel.endsWith("audit.ts")) continue; // the helper itself
  const text = await Bun.file(`${root}/${rel}`).text();
  const lines = text.split("\n");

  // Find each recordAudit( call; collect lines until matching close paren.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !/\brecordAudit\s*\(/.test(line)) continue;
    if (/\brecordAuditFromCtx\s*\(/.test(line)) continue;
    total++;
    let depth = 0;
    let started = false;
    let snippet = "";
    let endLine = i;
    for (let j = i; j < Math.min(i + 40, lines.length); j++) {
      const l = lines[j];
      if (!l) continue;
      snippet += `${l}\n`;
      for (const ch of l) {
        if (ch === "(") {
          depth++;
          started = true;
        } else if (ch === ")") {
          depth--;
        }
      }
      if (started && depth === 0) {
        endLine = j;
        break;
      }
    }
    void endLine;
    if (snippet.includes("requestId:")) continue;
    flagged++;
    hits.push({ file: rel, line: i + 1, snippet: snippet.split("\n").slice(0, 3).join(" ⏎ ") });
  }
}

if (flagged > 0) {
  console.error(
    `\n[check-audit-callsites] ${flagged}/${total} recordAudit() callsites missing requestId.\n`,
  );
  for (const h of hits.slice(0, 20)) {
    console.error(`  ${h.file}:${h.line}`);
    console.error(`    ${h.snippet}`);
  }
  if (hits.length > 20) console.error(`  …and ${hits.length - 20} more.`);
  console.error(
    `\nFix: thread the ExecutionContext.requestId via \`recordAudit(tx, { …, requestId: ctx.requestId })\`\n      or use \`recordAuditFromCtx(tx, ctx, { … })\`.\n`,
  );
  process.exit(1);
}

console.log(`[check-audit-callsites] OK (${total} callsites checked, all carry requestId).`);
