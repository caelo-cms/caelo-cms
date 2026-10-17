// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import type { SourceTree } from "./docs-source-tree.ts";
import {
  collectRelease,
  type Run,
  readSeedFiles,
  releaseSummary,
  SEED_REF,
  seedSummary,
} from "./docs-sync.ts";
import { USER_DOCS_HEADING, USER_FACING_LABEL } from "./docs-sync-sources.ts";

const REPO = "caelo-cms/caelo-cms";

function prJson(n: number, labels: string[], body: string) {
  return JSON.stringify({
    number: n,
    title: `Change ${n}`,
    body,
    url: `https://github.com/${REPO}/pull/${n}`,
    state: "MERGED",
    labels: labels.map((name) => ({ name })),
  });
}

/** A fake git/gh: answers by command prefix, records every call. */
function fakeRun(answers: Record<string, string | Error>): Run & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (argv: readonly string[]) => {
    const cmd = argv.join(" ");
    calls.push(cmd);
    const key = Object.keys(answers).find((k) => cmd.startsWith(k));
    if (key === undefined) throw new Error(`unexpected command: ${cmd}`);
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return answer as string;
  }) as Run & { calls: string[] };
  run.calls = calls;
  return run;
}

describe("collectRelease", () => {
  const answers = {
    "git tag --list v*": "v0.10.51\nv0.10.52\nv0.10.53-rc.1\nv0.10.53\n",
    "git log --format=%s v0.10.52..v0.10.53":
      "feat: theme logo slot (#901)\nfix: typo (#902)\nchore: issue ref only (#903)\n",
    "gh pr view 901": prJson(901, [USER_FACING_LABEL], `${USER_DOCS_HEADING}\n\nThemes page.`),
    "gh pr view 902": prJson(902, ["bug"], ""),
    "gh pr view 903": new Error(
      "gh pr view 903 failed (1): GraphQL: Could not resolve to a PullRequest with the number of 903.",
    ),
    "gh release view v0.10.53": JSON.stringify({ body: "## v0.10.53 notes" }),
  };

  it("collects the range, the user-facing PRs and the notes", async () => {
    const run = fakeRun(answers);
    const plan = await collectRelease("v0.10.53", REPO, run);
    expect(plan.previousRelease).toBe("v0.10.52");
    expect(plan.prNumbers).toEqual([901, 902, 903]);
    expect(plan.changes.map((c) => c.number)).toEqual([901]);
    expect(plan.releaseNotes).toBe("## v0.10.53 notes");
    expect(plan.marker).toBe("docs-sync:v0.10.53");
    expect(run.calls).toContain(
      `gh pr view 901 --repo ${REPO} --json number,title,body,labels,url,state`,
    );
  });

  it("fails on gh errors other than 'not a PR'", async () => {
    const run = fakeRun({ ...answers, "gh pr view 902": new Error("HTTP 502") });
    await expect(collectRelease("v0.10.53", REPO, run)).rejects.toThrow(/HTTP 502/);
  });

  it("refuses pre-releases and unknown tags", async () => {
    await expect(collectRelease("v0.10.53-rc.1", REPO, fakeRun(answers))).rejects.toThrow(
      /pre-releases get no docs run/,
    );
    await expect(collectRelease("v0.10.99", REPO, fakeRun(answers))).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe("readSeedFiles", () => {
  it("reads the markdown files of seed/ from a tree", () => {
    const files: Record<string, string> = { "seed/b.md": "B", "seed/a.md": "A" };
    const tree: SourceTree = {
      label: "test",
      read: (p) => files[p] ?? null,
      list: (dir) => (dir === "seed" ? ["README.txt", "a.md", "b.md"] : []),
    };
    expect(readSeedFiles(tree)).toEqual([
      { file: "seed/a.md", content: "A" },
      { file: "seed/b.md", content: "B" },
    ]);
    expect(SEED_REF).toBe("refs/remotes/origin/docs/cms-seed");
  });
});

describe("summaries", () => {
  it("lists changes and problems and says nothing was sent", () => {
    const md = releaseSummary(
      {
        mode: "release",
        marker: "docs-sync:v1.0.0",
        release: "v1.0.0",
        previousRelease: "v0.9.0",
        releaseNotes: "",
        prNumbers: [1, 2, 3],
        changes: [{ number: 1, title: "A", url: "https://x/1", userDocs: "a" }],
        skipped: [2],
        problems: [{ number: 3, url: "https://x/3", problem: "no section" }],
      },
      1,
      4,
    );
    expect(md).toContain("v0.9.0..v1.0.0");
    expect(md).toContain("[#1](https://x/1) A");
    expect(md).toContain("#2");
    expect(md).toContain("[#3](https://x/3): no section");
    expect(md).toContain("Nothing was sent to caelo-cms.com");
    expect(seedSummary(["/docs/a/"])).toContain("- /docs/a/");
  });
});

describe("docs-sync.yml", () => {
  const raw = readFileSync(resolve(import.meta.dir, "../.github/workflows/docs-sync.yml"), "utf8");
  const wf = yaml.load(raw) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, { if?: string; steps: Array<{ uses?: string; run?: string }> }>;
  };

  it("never runs for pull requests and only dispatches from main", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["workflow_dispatch", "workflow_run"]);
    expect(raw).not.toMatch(/pull_request_target/);
    const cond = wf.jobs.prepare?.if ?? "";
    expect(cond).toContain("github.ref == 'refs/heads/main'");
    expect(cond).toContain("github.event.workflow_run.conclusion == 'success'");
  });

  it("holds a read-only token and no secrets", () => {
    expect(wf.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(raw).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("pins third-party actions to a commit SHA", () => {
    for (const step of wf.jobs.prepare?.steps ?? []) {
      if (!step.uses || step.uses.startsWith("actions/")) continue;
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("passes untrusted event values through env, never inline in run scripts", () => {
    for (const step of wf.jobs.prepare?.steps ?? []) {
      expect(step.run ?? "").not.toMatch(/\$\{\{/);
    }
  });
});
