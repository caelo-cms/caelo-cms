// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the libvips THIRD_PARTY_NOTICES generator (issue #794):
 * a fixture install tree with `package.json` + `versions.json` + README, the
 * loud failures on missing data, the repo's licence texts, and the Dockerfile
 * steps that run the generator in the published images.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findLibvipsPackages, parseLicensingTable, renderNotice } from "./libvips-notice.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const TEXTS = { lgpl3: "LGPL-3.0 TEXT\n", gpl3: "GPL-3.0 TEXT\n" };

const README = `# \`@img/sharp-libvips-linux-x64\`

## Licensing

| Library       | Used under the terms of                                                  |
|---------------|--------------------------------------------------------------------------|
| cairo         | Mozilla Public License 1.1                                               |
| glib          | LGPLv3                                                                   |
| libpng        | [libpng License](https://github.com/pnggroup/libpng/blob/master/LICENSE) |
| librsvg       | LGPLv3                                                                   |
| libvips       | LGPLv3                                                                   |

Use of libraries under the terms of the LGPLv3 is via the
"any later version" clause of the LGPLv2 or LGPLv2.1.
`;

const VERSIONS = { cairo: "1.18.6", glib: "2.90.0", png: "1.6.58", rsvg: "2.63.2", vips: "8.18.7" };

function writePackage(
  root: string,
  location: string,
  name: string,
  files: { versions?: object; readme?: string; license?: string } = {},
): void {
  const dir = join(root, location, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.3.4", license: files.license ?? "LGPL-3.0-or-later" }),
  );
  writeFileSync(join(dir, "versions.json"), JSON.stringify(files.versions ?? VERSIONS));
  writeFileSync(join(dir, "README.md"), files.readme ?? README);
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "libvips-notice-"));
  writePackage(root, "", "@img/sharp-libvips-linux-x64");
  // Same package nested under a workspace: one entry, two locations.
  writePackage(root, "apps/admin", "@img/sharp-libvips-linux-x64");
  writePackage(root, "", "@img/sharp-libvips-linuxmusl-x64");
  // sharp's own binding package (Apache-2.0) must not be picked up.
  writePackage(root, "", "@img/sharp-linux-x64", { license: "Apache-2.0" });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("findLibvipsPackages", () => {
  it("finds every libvips platform package, deduplicated, and nothing else", () => {
    const pkgs = findLibvipsPackages(root);
    expect(pkgs.map((p) => `${p.name}@${p.version}`)).toEqual([
      "@img/sharp-libvips-linux-x64@1.3.4",
      "@img/sharp-libvips-linuxmusl-x64@1.3.4",
    ]);
    expect([...pkgs[0]!.locations].sort()).toEqual([
      join(root, "apps/admin/node_modules/@img/sharp-libvips-linux-x64"),
      join(root, "node_modules/@img/sharp-libvips-linux-x64"),
    ]);
    expect(pkgs[0]!.bundled).toEqual(VERSIONS);
  });

  it("returns nothing for a tree without libvips", () => {
    const empty = mkdtempSync(join(tmpdir(), "libvips-notice-empty-"));
    try {
      expect(findLibvipsPackages(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("parseLicensingTable", () => {
  it("reads the Licensing table and flattens markdown links", () => {
    expect(parseLicensingTable(README, "x")).toEqual({
      cairo: "Mozilla Public License 1.1",
      glib: "LGPLv3",
      libpng: "libpng License (https://github.com/pnggroup/libpng/blob/master/LICENSE)",
      librsvg: "LGPLv3",
      libvips: "LGPLv3",
    });
  });

  it("throws when the README has no Licensing section", () => {
    expect(() => parseLicensingTable("# readme\n", "pkg@1")).toThrow(
      /pkg@1: README has no "## Licensing"/,
    );
  });
});

describe("renderNotice", () => {
  const notice = () => renderNotice(findLibvipsPackages(root), TEXTS);

  it("states the package, libvips version and LGPL libraries with versions", () => {
    const text = notice();
    expect(text).toContain("@img/sharp-libvips-linux-x64@1.3.4 (LGPL-3.0-or-later)");
    expect(text).toContain("libvips 8.18.7");
    expect(text).toMatch(/^ {4}glib +2\.90\.0$/m);
    expect(text).toMatch(/^ {4}librsvg +2\.63\.2$/m);
    expect(text).toMatch(/^ {4}libvips +8\.18\.7$/m);
    expect(text).toMatch(/^ {4}cairo +Mozilla Public License 1\.1$/m);
  });

  it("links the matching sharp-libvips release for corresponding source", () => {
    expect(notice()).toContain("https://github.com/lovell/sharp-libvips/tree/v1.3.4");
    expect(notice()).toContain("https://github.com/lovell/sharp-libvips/releases/tag/v1.3.4");
  });

  it("appends the LGPL-3.0 and GPL-3.0 texts", () => {
    const text = notice();
    expect(text).toContain("LGPL-3.0 TEXT");
    expect(text).toContain("GPL-3.0 TEXT");
    expect(text.indexOf("LGPL-3.0 TEXT")).toBeLessThan(text.indexOf("\nGPL-3.0 TEXT"));
  });

  it("fails loudly with no libvips package", () => {
    expect(() => renderNotice([], TEXTS)).toThrow(/No @img\/sharp-libvips-\* package found/);
  });

  it("fails when an LGPL library has no recorded version", () => {
    const tree = mkdtempSync(join(tmpdir(), "libvips-notice-bad-"));
    try {
      const { glib: _omit, ...withoutGlib } = VERSIONS;
      writePackage(tree, "", "@img/sharp-libvips-linux-x64", { versions: withoutGlib });
      expect(() => renderNotice(findLibvipsPackages(tree), TEXTS)).toThrow(
        /versions.json has no entry for LGPL library "glib"/,
      );
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});

describe("repo licence texts", () => {
  // The canonical FSF texts (gnu.org/licenses/{lgpl,gpl}-3.0.txt). Pinned so
  // an accidental edit to a licence text fails here.
  it.each([
    ["licenses/LGPL-3.0.txt", "e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118"],
    ["licenses/GPL-3.0.txt", "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986"],
  ])("%s is the unmodified FSF text", (path, sha256) => {
    const text = readFileSync(resolve(REPO_ROOT, path));
    expect(createHash("sha256").update(text).digest("hex")).toBe(sha256);
  });
});

describe("images that ship sharp generate the notice", () => {
  it.each(["apps/admin/Dockerfile", "apps/api-gateway/Dockerfile"])("%s", (path) => {
    const dockerfile = readFileSync(resolve(REPO_ROOT, path), "utf8");
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    expect(runtime).toContain("COPY scripts/libvips-notice.ts /tmp/notice/libvips-notice.ts");
    expect(runtime).toContain("COPY licenses /tmp/notice/licenses");
    expect(runtime).toMatch(
      /RUN bun \/tmp\/notice\/libvips-notice\.ts --root \/app --licenses \/tmp\/notice\/licenses \\\n\s+--out \/app\/THIRD_PARTY_NOTICES\.txt/,
    );
  });
});
