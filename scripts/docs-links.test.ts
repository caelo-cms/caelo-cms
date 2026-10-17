// SPDX-License-Identifier: MPL-2.0

/**
 * Developer docs stay in the repo; end-user docs live in the CMS at
 * caelo-cms.com/docs/ (epic #825). This test keeps the repo half intact:
 *
 * - every relative link in the repo's Markdown points at a file or
 *   directory that exists, so moving or deleting a doc cannot leave a
 *   dangling link behind (#826);
 * - `docs/README.md` indexes every file under `docs/`, so a new developer
 *   doc cannot land without an entry.
 *
 * External links (https://, mailto:) and in-page anchors are out of scope:
 * checking them needs the network, and anchors drift with headings.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * Markdown that is a historical record, not a maintained doc: release
 * entries and phase plans describe the tree as it was when written, so
 * their links are not rewritten when files move.
 */
const HISTORICAL = [/^CHANGELOG\.md$/, /^plans\//];

/** Directories never scanned (dependencies, build output, VCS, agent worktrees). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svelte-kit",
  "dist",
  "build",
  "coverage",
  ".claude",
]);

/** Every `.md` file under `dir`, repo-relative. */
function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.endsWith(".md")) out.push(relative(REPO_ROOT, full));
  }
  return out;
}

/** Every file under `dir`, repo-relative. */
function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(full));
    else out.push(relative(REPO_ROOT, full));
  }
  return out;
}

/**
 * Relative link targets in `text`: inline links and images `](target)`,
 * without fenced code blocks (examples there are not links), with any
 * `#anchor` or `?query` removed.
 */
function relativeLinkTargets(text: string): string[] {
  const prose = text.replace(/^```[\s\S]*?^```/gm, "");
  const targets: string[] = [];
  for (const match of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = match[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/"))
      continue;
    const path = target.replace(/[#?].*$/, "");
    if (path) targets.push(decodeURIComponent(path));
  }
  return targets;
}

describe("relativeLinkTargets", () => {
  it("keeps relative file links and drops anchors, URLs and code examples", () => {
    const text = [
      "[a](./docs/a.md#section) [b](../b.md) ![img](img.png)",
      "[web](https://example.com) [mail](mailto:x@example.com) [here](#top) [site](/docs/)",
      "```md",
      "[example](./not-a-link.md)",
      "```",
    ].join("\n");
    expect(relativeLinkTargets(text)).toEqual(["./docs/a.md", "../b.md", "img.png"]);
  });
});

describe("repo Markdown links", () => {
  const files = markdownFiles(REPO_ROOT).filter((f) => !HISTORICAL.some((re) => re.test(f)));

  it("scans the maintained docs", () => {
    expect(files).toContain("README.md");
    expect(files).toContain("docs/README.md");
  });

  for (const file of files) {
    it(`${file}: every relative link resolves`, () => {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      const dangling = relativeLinkTargets(text).filter(
        (target) => !existsSync(resolve(REPO_ROOT, dirname(file), target)),
      );
      expect(dangling).toEqual([]);
    });
  }
});

describe("docs/README.md", () => {
  const index = readFileSync(join(REPO_ROOT, "docs/README.md"), "utf8");
  const linked = new Set(
    relativeLinkTargets(index).map((t) => relative(REPO_ROOT, resolve(REPO_ROOT, "docs", t))),
  );

  it("indexes every file under docs/", () => {
    const unindexed = allFiles(join(REPO_ROOT, "docs")).filter(
      (f) => f !== "docs/README.md" && !linked.has(f),
    );
    expect(unindexed).toEqual([]);
  });

  it("points end users at the CMS docs", () => {
    expect(index).toContain("https://caelo-cms.com/docs/");
  });

  it("indexes no directory as a file", () => {
    for (const f of linked) expect(statSync(join(REPO_ROOT, f)).isFile()).toBe(true);
  });
});
