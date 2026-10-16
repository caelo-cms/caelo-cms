// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 guardrail (c): the public gateway's code cannot reach the
 * authoring side.
 *
 * Walks the static import graph from the gateway's entry point and from
 * every shipped plugin it may load (their public operations run inside the
 * gateway), following workspace sources only, and fails when any module of
 * an admin-only package is reachable. Then checks the gateway's operation
 * registry: every core operation it can run must target cms_public.
 *
 * A failure here means a change pulled authoring code into the public
 * process. Fix the import, do not widen the list: the gateway reads what
 * the admin publishes into cms_public (docs/dev/public-admin-boundary.md).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { registerGatewayOperations } from "@caelo-cms/plugin-host";
import { OperationRegistry } from "@caelo-cms/query-api";

const REPO = resolve(import.meta.dir, "../../..");

/** Workspace directories whose code must never load in the gateway. */
const ADMIN_ONLY = [
  "apps/admin",
  "apps/static-generator",
  "packages/admin-core",
  "packages/mcp-server",
  "packages/migrations",
  "packages/platform-updater",
  "packages/provisioning",
  "packages/redeploy-orchestrator",
  "packages/site-importer",
].map((d) => `${resolve(REPO, d)}/`);

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Every workspace source file reachable from `entries`, with the import that first reached it. */
function reachable(entries: readonly string[]): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = entries.map((e) => [e, "<entry>"] as const);
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const [file, from] = next;
    if (seen.has(file)) continue;
    seen.set(file, from);
    const source = readFileSync(file, "utf8");
    const imports = transpiler.scanImports(source);
    for (const imp of imports) {
      let target: string;
      try {
        target = Bun.resolveSync(imp.path, dirname(file));
      } catch {
        continue; // a type-only or optional import that does not resolve at runtime
      }
      // Third-party code is out of scope; workspace code is followed.
      if (target.includes("/node_modules/") && !target.includes("/@caelo-cms/")) continue;
      if (!/\.(ts|js|mjs)$/.test(target) || target.endsWith(".d.ts")) continue;
      queue.push([realpathSync(target), relative(REPO, file)]);
    }
  }
  return seen;
}

function pluginEntries(): string[] {
  const root = resolve(REPO, "packages/plugins");
  return readdirSync(root)
    .map((d) => resolve(root, d, "src/index.ts"))
    .filter((p) => existsSync(p));
}

describe("the gateway's import graph reaches no admin-only code (#635)", () => {
  const graph = reachable([resolve(import.meta.dir, "server.ts"), ...pluginEntries()]);

  it("walks the real graph", () => {
    // A walker that silently stopped would pass vacuously.
    expect(graph.size).toBeGreaterThan(30);
    for (const pkg of ["plugin-host", "query-api", "shared", "plugin-sdk", "plugins/comments"]) {
      expect([...graph.keys()].some((f) => f.includes(`/packages/${pkg}/`))).toBe(true);
    }
  });

  it("would catch an admin-only import (the walker follows workspace packages)", () => {
    const probe = reachable([resolve(REPO, "packages/redeploy-orchestrator/src/index.ts")]);
    expect([...probe.keys()].some((f) => f.includes("/packages/site-importer/"))).toBe(true);
  });

  it("contains no module of an admin-only package", () => {
    const leaks = [...graph]
      .filter(([file]) => ADMIN_ONLY.some((dir) => file.startsWith(dir)))
      .map(([file, from]) => `${relative(REPO, file)} (imported by ${from})`);
    expect(leaks).toEqual([]);
  });
});

describe("the gateway's operation registry (#635)", () => {
  it("holds only operations on cms_public", () => {
    const registry = new OperationRegistry();
    registerGatewayOperations(registry);
    const onAdmin = [...registry.names()].filter((name) => {
      const op = registry.lookup(name);
      return !op.ok || op.value.database !== "cms_public";
    });
    expect(onAdmin).toEqual([]);
  });
});
