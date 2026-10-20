// SPDX-License-Identifier: MPL-2.0
/**
 * Contract for release-cut's guard against main moving between the cut and
 * the merge of the release PR. The cut generates files from main as it was
 * (version stamps, the Power-MCP catalogue); a PR merged while the release
 * PR was open lands under the release commit without them, and release.yml's
 * gate then fails after the release PR has merged (the v0.10.54 class).
 *
 * M1: tag-and-publish runs the guard before it tags or dispatches anything.
 * M2: the guard compares the release PR head's parent (the cut base) with
 *     the parent of the merged commit, and fails when they differ.
 * M3: the guard reads the SHA through env, not `${{ }}` inside `run:`.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
}
interface Job {
  readonly steps?: Step[];
}

const cut = yaml.load(
  readFileSync(resolve(REPO_ROOT, ".github/workflows/release-cut.yml"), "utf8"),
) as { jobs: Record<string, Job> };
const steps = cut.jobs["tag-and-publish"]?.steps ?? [];
const guardIndex = steps.findIndex((s) =>
  (s.name ?? "").startsWith("Guard — main must not have moved"),
);
const guard = steps[guardIndex];

describe("release-cut — refuse a release PR merged onto a moved main", () => {
  it("M1: the guard runs before the tag and the pipeline dispatch", () => {
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    const tag = steps.findIndex((s) => s.name === "Tag the release commit");
    const dispatch = steps.findIndex((s) => s.name === "Dispatch the release pipeline");
    expect(tag).toBeGreaterThan(guardIndex);
    expect(dispatch).toBeGreaterThan(guardIndex);
  });

  it("M2: compares the cut base with the commit the PR was squashed onto", () => {
    const run = guard?.run ?? "";
    expect(run).toContain("repos/$REPO/commits/$SHA\" --jq '.parents[0].sha'");
    expect(run).toContain('startswith("release/v")');
    expect(run).toContain("repos/$REPO/commits/$pr_head\" --jq '.parents[0].sha'");
    expect(run).toContain('if [ "$cut_from" != "$merged_onto" ]; then');
    expect(run).toMatch(/main moved after this release was cut[\s\S]*exit 1/);
  });

  it("M3: takes the SHA from env, never `${{ }}` inside run", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
    expect(guard?.env?.SHA).toBe("${{ github.sha }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
    expect(guard?.run ?? "").not.toContain("${{");
  });
});
