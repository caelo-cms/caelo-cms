// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "cli.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caelo-init-validation-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function init(...args: string[]) {
  return Bun.spawnSync([process.execPath, CLI, "init", ...args], {
    env: { ...process.env, CAELO_SELF_HOSTED_DIR: join(dir, ".caelo") },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("cms-provision init refuses a value the Caddyfile cannot hold before writing anything", () => {
  // Checked only when the Caddyfile was generated, a bad value left
  // config.json behind, and the re-run stopped at "config already exists".
  for (const [flag, value] of [
    ["--domain", "example.com,:80"],
    ["--domain", "example.com {\n  respond 200\n}"],
    ["--owner-email", "owner@example.com\n  debug"],
    ["--staging-domain", "staging.example.com #"],
  ] as const) {
    it(`${flag} ${JSON.stringify(value)}`, () => {
      const base: Record<string, string> = {
        "--domain": "example.com",
        "--owner-email": "owner@example.com",
      };
      base[flag] = value;
      const r = init(...Object.entries(base).flat());
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain(flag);
      expect(existsSync(join(dir, ".caelo"))).toBe(false);
    });
  }
});
