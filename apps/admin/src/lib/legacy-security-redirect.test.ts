// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { legacySecurityRedirect } from "./legacy-security-redirect.js";

const AUTHED_ROUTES = join(import.meta.dir, "..", "routes", "(authed)");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** A concrete path for every page and endpoint under /settings (params filled in). */
function settingsPaths(): string[] {
  const glob = new Glob("settings/**/+{page.svelte,server.ts}");
  return [...glob.scanSync({ cwd: AUTHED_ROUTES })].map(
    (f) => `/${f.replace(/\/?\+(page\.svelte|server\.ts)$/, "").replace(/\[[^\]]+\]/g, "abc-123")}`,
  );
}

const at = (path: string) => legacySecurityRedirect(new URL(path, "https://admin.example"));

describe("legacySecurityRedirect (#684)", () => {
  it("moves every old /security page and endpoint to /settings", () => {
    const paths = settingsPaths();
    expect(paths.length).toBeGreaterThan(60);
    for (const p of paths) {
      const old = p.replace(/^\/settings/, "/security");
      expect(at(old)).toBe(p);
    }
  });

  it("keeps the query string, including form-action selectors", () => {
    expect(at("/security/import/pending?/approve")).toBe("/settings/import/pending?/approve");
    expect(at("/security/costs?days=7&x=%2F")).toBe("/settings/costs?days=7&x=%2F");
    expect(at("/security?q=1")).toBe("/settings?q=1");
  });

  it("leaves other paths alone", () => {
    expect(at("/settings/ai")).toBeNull();
    expect(at("/security-review")).toBeNull();
    expect(at("/securityx/ai")).toBeNull();
    expect(at("/content/security")).toBeNull();
  });
});

/**
 * Old paths still work through the redirect, but new text must name the
 * section the operator sees. Code directories called `security` (ops,
 * secret-box, operator-access) are not admin URLs; migrations are history.
 */
describe("no admin link still points at /security", () => {
  it("finds none in source, prompts or docs", () => {
    // One glob per root: Bun's Glob matches nothing for a brace group that
    // contains a slash (`{…,a/b}`), which once left this guard scanning zero
    // files and passing vacuously — hence the count check.
    const roots = ["apps", "packages", "docs"];
    const files = roots.flatMap((root) =>
      [...new Glob("**/*.{ts,svelte,md,json,yaml}").scanSync({ cwd: join(REPO_ROOT, root) })].map(
        (f) => `${root}/${f}`,
      ),
    );
    expect(files.length).toBeGreaterThan(1000);
    const stale: string[] = [];
    const pattern = /(?<![A-Za-z0-9_.-])\/security(?=\/[a-z]|["'`\s?]|$)/m;
    for (const rel of files) {
      if (/(^|\/)(node_modules|dist|build|\.svelte-kit)\//.test(rel)) continue;
      if (rel.startsWith("packages/migrations/migrations/")) continue;
      if (
        rel.endsWith("legacy-security-redirect.ts") ||
        rel.endsWith("legacy-security-redirect.test.ts") ||
        rel.endsWith("settings-section.browser.ts")
      ) {
        continue;
      }
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      if (pattern.test(text)) stale.push(rel);
    }
    expect(stale).toEqual([]);
  });
});
