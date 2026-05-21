// SPDX-License-Identifier: MPL-2.0

/**
 * Asserts on the `e2e` job in `.github/workflows/ci.yml`. The workflow itself
 * is CI-only and has no runtime code to integration-test; these pure-string
 * checks are the test surface for issue #36's contract (and the #52 follow-up
 * that removed the mask).
 *
 * Failures here are regressions in: the `Build @caelo-cms/shared (admin SSR
 * dep)` step (presence, exact filter form, exact name, ordering relative to
 * `Bootstrap databases`), the removed `continue-on-error: true` mask (issue
 * #52 — a failure must block merging), the dropped "best-effort" wording, or
 * the retained `needs: check`. U-numbers track plan §8.1.
 *
 * No YAML parser dependency by design — plan §8.1 commits to pure-string
 * assertions so this stays in `bun test` without dragging in `js-yaml` or
 * `actionlint`.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github/workflows/ci.yml");
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

// Slice out the `e2e:` job body so per-job assertions don't accidentally
// match content in `lockfile` / `check` (e.g. a `continue-on-error` legitimately
// added to a different job later). The contract: jobs are 2-space-indented
// keys nested under the top-level `jobs:` block, and the job body runs until
// the next sibling key or EOF.
function extractJobBody(yaml: string, jobName: string): string {
  const jobsIdx = yaml.indexOf("\njobs:\n");
  if (jobsIdx === -1) throw new Error("no `jobs:` block in workflow");
  const fromJobs = yaml.slice(jobsIdx);
  const jobHeader = `\n  ${jobName}:\n`;
  const start = fromJobs.indexOf(jobHeader);
  if (start === -1) throw new Error(`no \`${jobName}\` job in workflow`);
  // Find the next sibling 2-space-indented key after this job's header.
  const afterHeader = start + jobHeader.length;
  const nextSibling = fromJobs.slice(afterHeader).search(/\n {2}[a-z][a-zA-Z0-9_-]*:\n/);
  return nextSibling === -1
    ? fromJobs.slice(afterHeader)
    : fromJobs.slice(afterHeader, afterHeader + nextSibling);
}

const e2e = extractJobBody(workflow, "e2e");

describe("e2e job — issue #36 contract", () => {
  it("U1: contains the `bun run --filter '@caelo-cms/shared' build` step command", () => {
    expect(e2e).toContain("bun run --filter '@caelo-cms/shared' build");
  });

  it("U2: the build step's name is `Build @caelo-cms/shared (admin SSR dep)`", () => {
    expect(e2e).toContain("- name: Build @caelo-cms/shared (admin SSR dep)");
  });

  it("U3: no `continue-on-error: true` mask — #52 fixed the Rollup SIGILL at root, failures must block merging", () => {
    // Earlier revisions of this job tolerated failures with
    // `continue-on-error: true` while the Bun 1.3.13 / Rollup native-binding
    // SIGILL was unresolved. #52's fix (non-frozen `bun install` in the e2e
    // job, see ci.yml ~line 173) removes the SIGILL at root, so the mask is
    // gone — and must stay gone. Line-start match so we're asserting on the
    // actual YAML key, not a prose mention inside the `#` comment block.
    expect(e2e).not.toMatch(/^\s*continue-on-error:\s+true\b/m);
  });

  it("U4: retains `needs: check` so ordering after the typecheck/test job holds", () => {
    expect(e2e).toContain("needs: check");
  });

  it("U5: drops the stale `Best-effort` / `see follow-up issue` comment", () => {
    expect(e2e).not.toContain("Best-effort");
    expect(e2e).not.toContain("see follow-up issue");
  });

  it("U6: the build step appears before `Bootstrap databases` inside the e2e job", () => {
    const buildIdx = e2e.indexOf("bun run --filter '@caelo-cms/shared' build");
    const bootstrapIdx = e2e.indexOf("- name: Bootstrap databases");
    expect(buildIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(bootstrapIdx);
  });

  it("U7: zero `continue-on-error:` keys in the e2e job — guards against the mask being silently re-added", () => {
    // With #52 fixed at root, no `continue-on-error:` YAML key should appear
    // anywhere in the e2e job — neither at job level nor under any step.
    // Line-start match — the global flag with the multiline regex counts
    // YAML-key occurrences only, not the prose mention in the `#` comment.
    const matches = e2e.match(/^\s*continue-on-error:/gm) ?? [];
    expect(matches).toHaveLength(0);
  });

  it("U8: filter uses the quoted space-separated form, not the `=` form", () => {
    // Pin the exact form used elsewhere in the workspace (bun run --filter '<pkg>').
    // The `--filter=@caelo-cms/shared` shape is also valid Bun but inconsistent;
    // catching the drift here keeps log-grep + future test assertions reliable.
    expect(e2e).toContain("--filter '@caelo-cms/shared'");
    expect(e2e).not.toMatch(/--filter=['"]?@caelo-cms\/shared/);
  });
});
