// SPDX-License-Identifier: MPL-2.0

/**
 * #587 — the build carries the redirects table: the `_redirects` dump the
 * cloud publishers read, and a Caddy snippet planned against the complete
 * build (a row whose old path the build serves is left out).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRedirectsFile } from "@caelo-cms/shared";
import { listBuildFiles, writeRedirectFiles } from "./redirects-pass.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function build(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "caelo-587-build-"));
  dirs.push(dir);
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "x");
  }
  return dir;
}

const ROWS = [
  { fromPath: "/old", toPath: "/about", statusCode: 301 },
  { fromPath: "/about", toPath: "/elsewhere", statusCode: 301 },
];

describe("writeRedirectFiles", () => {
  it("writes the table dump twice and a Caddy snippet planned against the build", async () => {
    const dir = build(["index.html", "about/index.html"]);
    expect(await writeRedirectFiles({ buildDir: dir, rows: ROWS, pageUrlStyle: "directory" })).toBe(
      3,
    );
    const table = readFileSync(join(dir, "_redirects"), "utf8");
    expect(parseRedirectsFile(table)).toEqual(ROWS);
    expect(readFileSync(join(dir, "_redirects.cloudflare"), "utf8")).toBe(table);
    const caddy = readFileSync(join(dir, "_redirects.caddy"), "utf8");
    expect(caddy).toContain("\t/old /about/{?query} 301\n");
    // The live /about page wins over its recorded redirect.
    expect(caddy).not.toContain("/elsewhere");
  });

  it("fails the build on a row no host can serve", async () => {
    const dir = build(["index.html"]);
    await expect(
      writeRedirectFiles({
        buildDir: dir,
        rows: [
          { fromPath: "/a", toPath: "/b", statusCode: 301 },
          { fromPath: "/b", toPath: "/a", statusCode: 301 },
        ],
        pageUrlStyle: "directory",
      }),
    ).rejects.toThrow(/form a loop/);
  });
});

describe("listBuildFiles", () => {
  it("lists every file relative to the build root", async () => {
    const dir = build(["index.html", "de/preise/index.html", "_assets/a.png"]);
    expect([...(await listBuildFiles(dir))].sort()).toEqual([
      "_assets/a.png",
      "de/preise/index.html",
      "index.html",
    ]);
  });
});
