// SPDX-License-Identifier: MPL-2.0

/**
 * `ensureDevSignedManifests` validates every `.js` in a plugin's dist
 * BEFORE importing it: importing runs the module's top-level code in the
 * host process, and signing would bless whatever it exported. A dist the
 * validator refuses must be reported `failed`, never imported, never
 * signed — including when the offending code sits in a sibling file.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateManifestKeyPair } from "@caelo-cms/plugin-sandbox";
import { ensureDevSignedManifests } from "./dev-signing.js";

const root = mkdtempSync(join(tmpdir(), "caelo-dev-signing-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function plugin(slug: string, files: Record<string, string>): string {
  const dist = join(root, slug, "dist");
  mkdirSync(dist, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dist, name), body);
  return join(root, slug);
}

const IMPORT_MARKER = "__caeloDevSigningImported";

describe("ensureDevSignedManifests refuses a dist the validator rejects", () => {
  it("reports failed without importing or signing it", async () => {
    const entryDir = plugin("bad-entry", {
      "index.js": `globalThis.${IMPORT_MARKER} = true;\nexport default { slug: "bad-entry", run: () => eval("1") };\n`,
    });
    const siblingDir = plugin("bad-sibling", {
      "index.js": `import { helper } from "./helper.js";\nexport default { slug: "bad-sibling", helper };\n`,
      "helper.js": `export const helper = () => (0, eval)("1");\n`,
    });

    const { reports } = await ensureDevSignedManifests({
      pluginsRoot: root,
      keyPath: join(root, "unused-key.json"),
      key: await generateManifestKeyPair(),
    });

    const byDir = new Map(reports.map((r) => [r.slug, r]));
    expect(byDir.get("bad-entry")).toMatchObject({ status: "failed" });
    expect(byDir.get("bad-entry")?.reason).toContain("validator rejected source (index.js)");
    expect(byDir.get("bad-entry")?.reason).toContain("forbidden-eval");
    expect(byDir.get("bad-sibling")).toMatchObject({ status: "failed" });
    expect(byDir.get("bad-sibling")?.reason).toContain("validator rejected source (helper.js)");

    expect((globalThis as Record<string, unknown>)[IMPORT_MARKER]).toBeUndefined();
    for (const dir of [entryDir, siblingDir]) {
      expect(existsSync(join(dir, "manifest.json"))).toBe(false);
      expect(existsSync(join(dir, "manifest.sig"))).toBe(false);
    }
  });
});
