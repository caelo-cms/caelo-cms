// SPDX-License-Identifier: MPL-2.0

/**
 * #1340 (epic #763 E2-B) — the gateway's entry into the plugin host
 * (`@caelo-cms/plugin-host/gateway`) reaches no plugin code path: not the
 * loader (which imports dists), not the sandbox, not the plugin validator,
 * not an installed plugin's sandbox proxy. Walks the value imports of
 * gateway.ts (type-only imports are erased) and fails on any of them, so a
 * later import cannot bring plugin code back into the gateway's bundle.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const SRC = import.meta.dir;

/** Local modules and external packages `file` reaches through value imports. */
function walk(file: string, seen = new Set<string>(), external = new Set<string>()) {
  if (seen.has(file)) return { seen, external };
  seen.add(file);
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s+)?"([^"]+)"/gm)) {
    const spec = m[1] as string;
    if (spec.startsWith(".")) {
      const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (existsSync(target)) walk(target, seen, external);
    } else {
      external.add(spec);
    }
  }
  return { seen, external };
}

describe("the gateway entry (#1340)", () => {
  const { seen, external } = walk(resolve(SRC, "gateway.ts"));
  const modules = [...seen].map((f) => relative(SRC, f));

  it("reaches no plugin loader, sandbox or installed-plugin proxy", () => {
    for (const banned of [
      "loader.ts",
      "sandbox-runtime.ts",
      "sandbox-entry.ts",
      "external-plugin.ts",
      "dev-signing.ts",
      "image-self-check.ts",
    ])
      expect(modules, banned).not.toContain(banned);
  });

  it("imports no plugin validator: only the sandbox package's data modules", () => {
    expect(external).not.toContain("@caelo-cms/plugin-sandbox");
    expect(external).not.toContain("oxc-parser");
    for (const pkg of external)
      if (pkg.startsWith("@caelo-cms/plugin-sandbox/"))
        expect(["artifact", "installation-policy", "manifest", "schema"]).toContain(
          pkg.slice("@caelo-cms/plugin-sandbox/".length),
        );
  });

  it("imports no plugin package", () => {
    for (const pkg of external) expect(pkg).not.toMatch(/^@caelo-cms\/plugin-(?!sdk|sandbox|host)/);
  });
});
