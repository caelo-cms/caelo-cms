// SPDX-License-Identifier: MPL-2.0

/**
 * Regression contract for the bug surfaced on PR #57's first
 * release-images run: `apps/admin/Dockerfile` did NOT copy
 * `bunfig.toml` into the Docker build context before `bun install`.
 *
 * Without `bunfig.toml`, Bun falls back to its default `isolated`
 * linker inside the container. Transitive deps like `oxc-parser`
 * (declared only in `packages/plugin-sandbox/package.json`) end up
 * under `node_modules/.bun/<pkg>@<ver>/...` instead of being hoisted
 * to `node_modules/<pkg>/`. `apps/admin/vite.config.ts`'s
 * `createRequire(import.meta.url).resolve("oxc-parser/src-js/index.js")`
 * at config-load time then throws `MODULE_NOT_FOUND` and tanks
 * `bun x vite build` at Dockerfile line 139.
 *
 * The bunfig pins `linker = "hoisted"`. Both runtime image builds need
 * it in place BEFORE `bun install` runs, so it must appear in a COPY
 * directive earlier in the file than the first `bun install` line.
 *
 * The two assertions below pin that contract for the admin and gateway
 * Dockerfiles. Failing this test points at the exact regression class
 * that ate ~8 hours of red CI on main (post-PR #51).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface DockerfileCase {
  readonly path: string;
  readonly label: string;
}

const CASES: readonly DockerfileCase[] = [
  { path: "apps/admin/Dockerfile", label: "admin" },
  { path: "apps/api-gateway/Dockerfile", label: "gateway" },
];

function copyBunfigBeforeInstall(src: string): boolean {
  const firstInstall = src.indexOf("\nRUN bun install");
  if (firstInstall === -1) return false;
  const head = src.slice(0, firstInstall);
  // Match `COPY ... bunfig.toml ...` (any flags + other files in the
  // same COPY line are fine — what matters is the file is present in
  // SOME COPY directive before bun install runs).
  return /\nCOPY\s+[^\n]*\bbunfig\.toml\b/.test(head);
}

describe.each(
  CASES.map((c) => [c.label, c]),
)("%s Dockerfile — bunfig.toml is copied before bun install", (_label, { path }) => {
  const src = readFileSync(resolve(REPO_ROOT, path), "utf8");

  it("contains a COPY directive that includes bunfig.toml before the first `RUN bun install`", () => {
    expect(
      copyBunfigBeforeInstall(src),
      `${path}: \`COPY ... bunfig.toml ...\` must appear before \`RUN bun install\` so Bun's hoisted linker setting is in effect during install`,
    ).toBe(true);
  });
});
