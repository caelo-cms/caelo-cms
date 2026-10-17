// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  classifyPullRequests,
  extractUserDocsSection,
  isStableTag,
  type PullRequest,
  parseSeed,
  parseSeedFile,
  previousStableTag,
  prNumbersFromSubjects,
  USER_DOCS_HEADING,
  USER_FACING_LABEL,
} from "./docs-sync-sources.ts";

function pr(n: number, body: string, labels: string[] = [USER_FACING_LABEL]): PullRequest {
  return {
    number: n,
    title: `Change ${n}`,
    body,
    url: `https://github.com/caelo-cms/caelo-cms/pull/${n}`,
    state: "MERGED",
    labels: labels.map((name) => ({ name })),
  };
}

const TEMPLATE_BODY = (section: string) =>
  [
    "## What changed",
    "",
    "Something.",
    "",
    USER_DOCS_HEADING,
    "",
    "<!-- none / what changes for operators and editors -->",
    section,
    "",
    "## How verified",
    "",
    "- tests",
  ].join("\n");

describe("release range", () => {
  it("recognises stable tags only", () => {
    expect(isStableTag("v0.10.52")).toBe(true);
    expect(isStableTag("v0.11.0-rc.1")).toBe(false);
    expect(isStableTag("0.10.52")).toBe(false);
  });

  it("picks the highest stable tag below the release, ignoring pre-releases", () => {
    const tags = ["v0.9.0", "v0.10.2", "v0.10.10", "v0.11.0-rc.1", "v0.11.0", "v0.10.9"];
    expect(previousStableTag(tags, "v0.11.0")).toBe("v0.10.10");
    expect(previousStableTag(tags, "v0.10.10")).toBe("v0.10.9");
    expect(previousStableTag(tags, "v0.9.0")).toBeNull();
  });

  it("refuses a pre-release as the current release", () => {
    expect(() => previousStableTag(["v0.10.0"], "v0.11.0-rc.1")).toThrow(/not a stable/);
  });
});

describe("prNumbersFromSubjects", () => {
  it("reads squash-merge and merge-commit subjects, last (#N) wins", () => {
    expect(
      prNumbersFromSubjects([
        "fix(provisioning): bump INFRA_CONTRACT_VERSION (#799) (#812)",
        "feat(static): ship the 404 page (#802) (#805)",
        "Merge pull request #700 from caelo-cms/branch",
        "chore: direct commit without a PR",
        "fix: something (#812)",
        "",
      ]),
    ).toEqual([700, 805, 812]);
  });
});

describe("extractUserDocsSection", () => {
  it("returns the section text without template comments", () => {
    expect(extractUserDocsSection(TEMPLATE_BODY("The upgrade page: new --region flag."))).toBe(
      "The upgrade page: new --region flag.",
    );
  });

  it("returns null without the exact heading", () => {
    expect(extractUserDocsSection("## User docs\n\nsomething")).toBeNull();
    expect(extractUserDocsSection("")).toBeNull();
  });

  it("keeps level-3 sub-headings and stops at the next level-2 heading", () => {
    const body = `${USER_DOCS_HEADING}\n\n### Install\nstep\n\n## Next\nignored`;
    expect(extractUserDocsSection(body)).toBe("### Install\nstep");
  });

  it("handles CRLF bodies", () => {
    expect(extractUserDocsSection(`${USER_DOCS_HEADING}\r\nText\r\n`)).toBe("Text");
  });
});

describe("classifyPullRequests", () => {
  it("keeps labelled PRs with docs, skips 'none', reports missing or empty sections", () => {
    const r = classifyPullRequests([
      pr(5, TEMPLATE_BODY("Themes page: dark logo slot.")),
      pr(3, TEMPLATE_BODY("None")),
      pr(4, "## What changed\n\nno section"),
      pr(6, TEMPLATE_BODY("")),
      pr(7, TEMPLATE_BODY("Should be ignored"), ["bug"]),
      { ...pr(8, TEMPLATE_BODY("closed, not merged")), state: "CLOSED" },
    ]);
    expect(r.changes.map((c) => c.number)).toEqual([5]);
    expect(r.changes[0]?.userDocs).toBe("Themes page: dark logo slot.");
    expect(r.skipped).toEqual([3]);
    expect(r.problems.map((p) => p.number)).toEqual([4, 6]);
    expect(r.problems[0]?.problem).toContain(USER_DOCS_HEADING);
  });

  it("sorts changes by PR number", () => {
    const r = classifyPullRequests([pr(9, TEMPLATE_BODY("b")), pr(2, TEMPLATE_BODY("a"))]);
    expect(r.changes.map((c) => c.number)).toEqual([2, 9]);
  });
});

describe("seed files", () => {
  const page = (path: string, title = "Install on GCP", body = "# Install\n\nText.") =>
    `---\npath: ${path}\ntitle: "${title}"\norder: 3\n---\n${body}\n`;

  it("parses frontmatter and body", () => {
    expect(parseSeedFile("seed/gcp.md", page("/docs/install/gcp/"))).toEqual({
      file: "seed/gcp.md",
      path: "/docs/install/gcp/",
      title: "Install on GCP",
      body: "# Install\n\nText.",
    });
  });

  it("rejects bad paths, the reference section, missing frontmatter and empty bodies", () => {
    expect(() => parseSeedFile("a.md", page("/install/gcp/"))).toThrow(/a.md: invalid frontmatter/);
    expect(() => parseSeedFile("a.md", page("/docs/Install"))).toThrow(/path/);
    expect(() => parseSeedFile("a.md", page("/docs/reference/x/"))).toThrow(/repo-owned/);
    expect(() => parseSeedFile("a.md", "# no frontmatter")).toThrow(/frontmatter/);
    expect(() => parseSeedFile("a.md", page("/docs/a/", "T", ""))).toThrow(/empty page body/);
    expect(() => parseSeedFile("a.md", "---\npath: /docs/a/\n---\nbody")).toThrow(/title/);
  });

  it("sorts by path and rejects two files claiming one path", () => {
    const pages = parseSeed([
      { file: "seed/b.md", content: page("/docs/b/") },
      { file: "seed/a.md", content: page("/docs/a/") },
    ]);
    expect(pages.map((p) => p.path)).toEqual(["/docs/a/", "/docs/b/"]);
    expect(() =>
      parseSeed([
        { file: "seed/a.md", content: page("/docs/a/") },
        { file: "seed/c.md", content: page("/docs/a/") },
      ]),
    ).toThrow(/both claim \/docs\/a\//);
    expect(() => parseSeed([])).toThrow(/no seed/);
  });
});
