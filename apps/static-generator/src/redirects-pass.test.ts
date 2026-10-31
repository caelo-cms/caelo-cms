// SPDX-License-Identifier: MPL-2.0

/**
 * #587 — the build carries the redirects table: the `_redirects` dump the
 * cloud publishers read, and a Caddy snippet planned against the complete
 * build (a row whose old path the build serves is left out).
 */

import { describe, expect, it } from "bun:test";
import { parseRedirectsFile } from "@caelo-cms/shared";
import { redirectFiles } from "./redirects-pass.js";

const ROWS = [
  { fromPath: "/old", toPath: "/about", statusCode: 301 },
  { fromPath: "/about", toPath: "/elsewhere", statusCode: 301 },
];

describe("redirectFiles", () => {
  it("gives the table dump twice and a Caddy snippet planned against the served files", () => {
    const files = new Map(
      redirectFiles({
        rows: ROWS,
        pageUrlStyle: "directory",
        servedFiles: new Set(["index.html", "about/index.html"]),
      }).map((f) => [f.name, f.content]),
    );
    expect([...files.keys()]).toEqual(["_redirects", "_redirects.cloudflare", "_redirects.caddy"]);
    const table = files.get("_redirects") ?? "";
    expect(parseRedirectsFile(table)).toEqual(ROWS);
    expect(files.get("_redirects.cloudflare")).toBe(table);
    const caddy = files.get("_redirects.caddy") ?? "";
    expect(caddy).toContain("\t/old /about/{?query} 301\n");
    // The live /about page wins over its recorded redirect.
    expect(caddy).not.toContain("/elsewhere");
  });

  it("fails the build on a row no host can serve", () => {
    expect(() =>
      redirectFiles({
        rows: [
          { fromPath: "/a", toPath: "/b", statusCode: 301 },
          { fromPath: "/b", toPath: "/a", statusCode: 301 },
        ],
        pageUrlStyle: "directory",
        servedFiles: new Set(["index.html"]),
      }),
    ).toThrow(/form a loop/);
  });
});
