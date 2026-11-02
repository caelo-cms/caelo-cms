// SPDX-License-Identifier: MPL-2.0

/**
 * #1328 — the MCP-Auth-Proxy has no database code, by construction: it sees
 * the operators' Google ID tokens, so nothing in it may be able to reach a
 * database, the admin's code or a plugin. Three checks, each catching what
 * the others could miss:
 *
 *   1. every import in src/ is relative, a `node:` builtin, `zod` or
 *      `@caelo-cms/shared` (`bun:test` in tests);
 *   2. package.json depends on exactly zod + @caelo-cms/shared;
 *   3. the bundle the image ships (`bun build src/server.ts`, as the
 *      Dockerfile runs it) contains no module of a database driver, the
 *      Query API, the admin, migrations or the plugin system — the shared
 *      package's barrel must not drag one in either.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const APP = resolve(import.meta.dir, "..");
const SRC = join(APP, "src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** Every module specifier of `source`: static imports/exports, dynamic imports, require. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) if (m[1]) out.push(m[1]);
  return out;
}

function allowed(spec: string, isTest: boolean): boolean {
  if (spec.startsWith("./") || spec.startsWith("../")) return true;
  if (spec.startsWith("node:")) return true;
  if (spec === "zod" || spec === "@caelo-cms/shared") return true;
  return isTest && spec === "bun:test";
}

describe("MCP-Auth-Proxy has no database code (#1328)", () => {
  it("imports only relative modules, node builtins, zod and @caelo-cms/shared", () => {
    const offending: string[] = [];
    for (const file of tsFiles(SRC)) {
      const isTest = file.endsWith(".test.ts") || file.includes("/__tests__/");
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (!allowed(spec, isTest)) offending.push(`${relative(APP, file)}: ${spec}`);
      }
    }
    expect(offending).toEqual([]);
  });

  it("depends on exactly zod and @caelo-cms/shared", () => {
    const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["@caelo-cms/shared", "zod"]);
    expect(pkg.devDependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
    expect(pkg.optionalDependencies ?? {}).toEqual({});
  });

  it("ships a bundle without any database, admin or plugin module", async () => {
    const result = await Bun.build({
      entrypoints: [join(SRC, "server.ts")],
      target: "bun",
      // Module paths stay in the output as comments only without minify.
      minify: false,
    });
    expect(result.success).toBe(true);
    const code = await result.outputs[0]?.text();
    expect(code).toBeDefined();
    const forbidden = [
      /node_modules\/postgres\//,
      /node_modules\/pg\//,
      /node_modules\/drizzle-orm\//,
      /packages\/query-api\//,
      /packages\/admin-core\//,
      /packages\/migrations\//,
      /packages\/plugin-[a-z-]+\//,
      /packages\/plugins\//,
      /packages\/mcp-server\//,
      /apps\/api-gateway\//,
      /apps\/admin\//,
    ];
    const found = forbidden.filter((re) => re.test(code ?? ""));
    expect(found.map(String)).toEqual([]);
    // The check above relies on Bun keeping `// <path>` module markers.
    expect(code).toContain("apps/mcp-auth-proxy/src/routes.ts");
  });
});
