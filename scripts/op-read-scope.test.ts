// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 (rule 7 of docs/dev/state-and-changes.md) — every Query API
 * operation declares how much of the site one call may read, and a
 * whole-site operation says why.
 *
 * `readScope: "request"` holds the op to O(what the request names): the
 * rows-read test in PR CI measures it on a small and a 10x larger fixture.
 * `readScope: "site"` exempts it, so it needs a `// Why site-wide: <reason>`
 * comment right above the declaration — the Stage build, a whole-site link
 * check, an export, a rebuild op. The TypeScript type makes the field
 * required; this scan makes the justification required and keeps the
 * whole-site set reviewable.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { OperationRegistry } from "@caelo-cms/query-api";

const REPO_ROOT = resolve(import.meta.dir, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.ts$/.test(path) && !/\.(test|bench|browser)\.ts$/.test(path)) out.push(path);
  }
  return out;
}

/** `readScope: "site"` lines without a `// Why site-wide:` comment in the three lines above. */
export function unjustifiedSiteScopes(text: string): number[] {
  const lines = text.split("\n");
  const missing: number[] = [];
  lines.forEach((line, i) => {
    if (!/^\s*readScope:\s*"site"/.test(line)) return;
    const above = lines.slice(Math.max(0, i - 3), i).join("\n");
    if (!/\/\/\s*Why site-wide:\s*\S/.test(above)) missing.push(i + 1);
  });
  return missing;
}

describe("#1267 — operation read scope", () => {
  it("recognises a justified and an unjustified whole-site op", () => {
    expect(
      unjustifiedSiteScopes(
        `  name: "a.b",\n  // Why site-wide: builds the site.\n  readScope: "site",`,
      ),
    ).toEqual([]);
    expect(unjustifiedSiteScopes(`  name: "a.b",\n  readScope: "site",`)).toEqual([2]);
    expect(unjustifiedSiteScopes(`  name: "a.b",\n  readScope: "request",`)).toEqual([]);
  });

  it("every whole-site operation says why", () => {
    const offenders: string[] = [];
    for (const root of ["packages", "apps"]) {
      for (const dir of readdirSync(resolve(REPO_ROOT, root))) {
        const src = resolve(REPO_ROOT, root, dir, "src");
        try {
          statSync(src);
        } catch {
          continue;
        }
        for (const file of sources(src)) {
          for (const line of unjustifiedSiteScopes(readFileSync(file, "utf8"))) {
            offenders.push(`${relative(REPO_ROOT, file)}:${line}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every registered admin operation declares request or site", async () => {
    const { registerAdminOps } = await import("@caelo-cms/admin-core");
    const registry = new OperationRegistry();
    registerAdminOps(registry);
    const bad = registry.names().filter((n) => {
      const op = registry.lookup(n);
      if (!op.ok) return true;
      return op.value.readScope !== "request" && op.value.readScope !== "site";
    });
    expect(bad).toEqual([]);
  });
});
