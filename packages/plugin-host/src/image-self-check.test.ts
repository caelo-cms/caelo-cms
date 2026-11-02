// SPDX-License-Identifier: MPL-2.0

/**
 * The image self-check (issue #1327) refuses an image whose plugins would
 * not load, and proves the sandbox path runs (validator → bundler → Deno).
 * The verification of a correctly signed plugin is the loader's own test
 * (loader.integration.test.ts); here it is the failures a broken image
 * build produces.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPluginRuntime } from "./image-self-check.js";

const roots: string[] = [];
function pluginsRoot(dirs: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "image-self-check-"));
  roots.push(root);
  for (const [dir, files] of Object.entries(dirs)) {
    mkdirSync(join(root, dir), { recursive: true });
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(root, dir, name), content);
  }
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("checkPluginRuntime", () => {
  it("names a shipped plugin whose manifest was never signed", async () => {
    const report = await checkPluginRuntime({
      pluginsRoot: pluginsRoot({ forms: { "package.json": "{}" }, "not-a-plugin": {} }),
    });
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      { slug: "forms", reason: "no manifest.json: the image build did not sign it" },
    ]);
  });

  it("names a plugin whose signature does not verify", async () => {
    const manifest = JSON.stringify({
      slug: "forms",
      version: "1.0.0",
      tier: 1,
      schema: {},
      operations: [],
      hasStaticRender: false,
    });
    const report = await checkPluginRuntime({
      pluginsRoot: pluginsRoot({
        ".": { ".tier1-trust-root": "00".repeat(32) },
        forms: { "package.json": "{}", "manifest.json": manifest, "manifest.sig": "00".repeat(64) },
      }),
    });
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.slug).toBe("forms");
    expect(report.failures[0]?.reason).toMatch(/signature verification failed|manifest invalid/);
  });

  it("checks a manifest-bearing directory even without package.json (boot loads it)", async () => {
    const report = await checkPluginRuntime({
      pluginsRoot: pluginsRoot({ forms: { "manifest.json": "{}", "manifest.sig": "00" } }),
    });
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.slug).toBe("forms");
  });

  it("fails an image that ships no plugins at all", async () => {
    const empty = await checkPluginRuntime({ pluginsRoot: pluginsRoot({}) });
    expect(empty.failures).toEqual([
      { slug: "<root>", reason: expect.stringMatching(/^no plugin directories/) },
    ]);
    const missing = await checkPluginRuntime({
      pluginsRoot: join(tmpdir(), "no-such-plugins-root"),
    });
    expect(missing.failures[0]?.slug).toBe("<root>");
    expect(missing.ok).toBe(false);
  });

  it("runs the probe plugin through the Deno sandbox", async () => {
    const report = await checkPluginRuntime({ pluginsRoot: pluginsRoot({}) });
    expect(report.sandbox).toBe("ok");
  }, 30_000);
});
