// SPDX-License-Identifier: MPL-2.0

/**
 * The service images run `bun install` over the workspace manifests they
 * copy first (the layer that caches dependencies). bun refuses when a
 * copied workspace depends on a workspace whose manifest is missing ("…
 * depends on workspace X, which is listed in bun.lock but not on disk"),
 * which a new plugin package hit in #1666 only once the image build ran.
 * This guard checks the closure: every workspace a copied manifest depends
 * on (`workspace:*`, any dependency kind) is copied too.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DOCKERFILES = ["apps/admin/Dockerfile", "apps/api-gateway/Dockerfile"];

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Every workspace directory, by package name. */
function workspaces(): Map<string, string> {
  const out = new Map<string, string>();
  for (const parent of ["apps", "packages", "packages/plugins"]) {
    for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${parent}/${entry.name}`;
      const file = join(ROOT, dir, "package.json");
      if (!existsSync(file)) continue;
      out.set((JSON.parse(readFileSync(file, "utf8")) as Manifest).name, dir);
    }
  }
  return out;
}

function workspaceDeps(dir: string): string[] {
  const m = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as Manifest;
  return [m.dependencies, m.devDependencies, m.optionalDependencies, m.peerDependencies]
    .flatMap((d) => Object.entries(d ?? {}))
    .filter(([, spec]) => spec.startsWith("workspace:"))
    .map(([name]) => name);
}

describe("service images copy every workspace manifest bun install needs", () => {
  const byName = workspaces();
  for (const dockerfile of DOCKERFILES) {
    it(dockerfile, () => {
      const text = readFileSync(join(ROOT, dockerfile), "utf8");
      const copied = new Set(
        [...text.matchAll(/^COPY (\S+)\/package\.json \S+$/gm)].map((m) => m[1] as string),
      );
      const missing: string[] = [];
      for (const dir of copied) {
        for (const dep of workspaceDeps(dir)) {
          const depDir = byName.get(dep);
          if (depDir && !copied.has(depDir)) missing.push(`${dir} → ${depDir}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
