// SPDX-License-Identifier: MPL-2.0

/**
 * Release docs-sync, prepare step (#827, #828). Run by
 * `.github/workflows/docs-sync.yml`; also runnable locally:
 *
 *   bun scripts/docs-sync.ts release --release v0.10.53 --repo caelo-cms/caelo-cms --out <dir> \
 *     [--source-root <checkout of the release tag>]
 *   bun scripts/docs-sync.ts seed --seed-dir <checkout>/seed --out <dir>
 *
 * Writes into `<dir>`:
 *   - `messages/NN.md`  the chat messages for Caelo's AI on caelo-cms.com,
 *   - `plan.json`       what the run covers (PRs used / skipped / problems),
 *   - `summary.md`      the same for a human (also appended to the GitHub
 *                       job summary),
 *   - `reference/`      release mode only: the generated developer
 *                       reference (scripts/docs-reference.ts).
 *
 * It reads the repository (git) and GitHub (gh, the workflow's read-only
 * token) and nothing else: it never talks to a Caelo install. Sending the
 * messages over MCP waits on CI access through the admin's IAP (#827).
 *
 * Exits 1 after writing everything when a user-facing PR is unusable
 * (missing or empty "User docs affected" section), naming each one.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { generateReference, writeReference } from "./docs-reference.ts";
import { buildReleaseMessages, buildSeedMessages, runMarker } from "./docs-sync-prompt.ts";
import {
  classifyPullRequests,
  type DocsChange,
  type DocsProblem,
  isStableTag,
  type PullRequest,
  parseSeed,
  previousStableTag,
  prNumbersFromSubjects,
  pullRequestSchema,
  SEED_BRANCH,
  SEED_DIR,
  USER_FACING_LABEL,
} from "./docs-sync-sources.ts";

/** Runs a command and returns stdout; rejects with stderr on a non-zero exit. */
export type Run = (argv: readonly string[]) => Promise<string>;

/** `gh`'s answer when a number names an issue, not a PR. */
const NOT_A_PR = /Could not resolve to a PullRequest/;

/** What one release's docs run covers. */
export interface ReleasePlan {
  readonly mode: "release";
  readonly marker: string;
  readonly release: string;
  readonly previousRelease: string | null;
  readonly releaseNotes: string;
  readonly prNumbers: readonly number[];
  readonly changes: readonly DocsChange[];
  readonly skipped: readonly number[];
  readonly problems: readonly DocsProblem[];
}

/**
 * Collect the release range, its PRs and the release notes via git + gh.
 *
 * @throws when `release` is not a stable tag — pre-releases get no docs run.
 */
export async function collectRelease(
  release: string,
  repo: string,
  run: Run,
): Promise<ReleasePlan> {
  if (!isStableTag(release)) {
    throw new Error(
      `${release} is not a stable release tag (vX.Y.Z); pre-releases get no docs run`,
    );
  }
  const tags = (await run(["git", "tag", "--list", "v*"])).split("\n").filter(Boolean);
  if (!tags.includes(release)) throw new Error(`tag ${release} does not exist in this checkout`);
  const previousRelease = previousStableTag(tags, release);
  const range = previousRelease ? `${previousRelease}..${release}` : release;
  const subjects = (await run(["git", "log", "--format=%s", range])).split("\n");
  const prNumbers = prNumbersFromSubjects(subjects);

  const prs: PullRequest[] = [];
  for (const n of prNumbers) {
    let raw: string;
    try {
      raw = await run([
        "gh",
        "pr",
        "view",
        String(n),
        "--repo",
        repo,
        "--json",
        "number,title,body,labels,url,state",
      ]);
    } catch (e) {
      if (e instanceof Error && NOT_A_PR.test(e.message)) continue;
      throw e;
    }
    prs.push(pullRequestSchema.parse(JSON.parse(raw)));
  }
  const notes = z
    .object({ body: z.string() })
    .parse(
      JSON.parse(await run(["gh", "release", "view", release, "--repo", repo, "--json", "body"])),
    );
  const { changes, skipped, problems } = classifyPullRequests(prs);
  return {
    mode: "release",
    marker: runMarker(release),
    release,
    previousRelease,
    releaseNotes: notes.body,
    prNumbers,
    changes,
    skipped,
    problems,
  };
}

/** The job-summary markdown for a release run. */
export function releaseSummary(plan: ReleasePlan, messageCount: number, referencePages: number) {
  const lines = [
    `## Docs sync: ${plan.release}`,
    "",
    `Range: ${plan.previousRelease ? `${plan.previousRelease}..${plan.release}` : `up to ${plan.release}`} · ${plan.prNumbers.length} merged PR(s) · marker \`${plan.marker}\``,
    "",
    `### ${plan.changes.length} user-facing change(s) to document`,
    ...(plan.changes.length > 0
      ? plan.changes.map((c) => `- [#${c.number}](${c.url}) ${c.title}`)
      : [`- none (no merged PR carries the \`${USER_FACING_LABEL}\` label with docs to change)`]),
  ];
  if (plan.skipped.length > 0) {
    lines.push(
      "",
      `Labelled ${USER_FACING_LABEL} but "none" for the docs: ${plan.skipped.map((n) => `#${n}`).join(", ")}`,
    );
  }
  if (plan.problems.length > 0) {
    lines.push(
      "",
      "### Problems (the run fails until they are fixed)",
      ...plan.problems.map((p) => `- [#${p.number}](${p.url}): ${p.problem}`),
    );
  }
  lines.push(
    "",
    "### Output",
    `- ${messageCount} chat message(s) for caelo-cms.com in the \`docs-sync\` artifact (\`messages/\`)`,
    `- ${referencePages} developer reference page(s) for /docs/reference/ (\`reference/\`)`,
    "",
    "Nothing was sent to caelo-cms.com: the workflow cannot reach the IAP-protected admin yet (#827). Until it can, paste the messages into a new chat on caelo-cms.com, review the chat's preview and publish by click.",
  );
  return `${lines.join("\n")}\n`;
}

/** The job-summary markdown for a seed run. */
export function seedSummary(paths: readonly string[]): string {
  return [
    `## Docs sync: seed from ${SEED_BRANCH}`,
    "",
    `${paths.length} page(s), one chat message each:`,
    ...paths.map((p) => `- ${p}`),
    "",
    "Nothing was sent to caelo-cms.com: the workflow cannot reach the IAP-protected admin yet (#827). Until it can, paste the messages into a chat on caelo-cms.com, review the chat's preview and publish by click.",
    "",
  ].join("\n");
}

function writeMessages(out: string, messages: readonly string[]) {
  const dir = join(out, "messages");
  mkdirSync(dir, { recursive: true });
  messages.forEach((m, i) => {
    writeFileSync(join(dir, `${String(i + 1).padStart(2, "0")}.md`), `${m}\n`);
  });
}

function publishSummary(out: string, summary: string) {
  writeFileSync(join(out, "summary.md"), summary);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) appendFileSync(stepSummary, summary);
  console.log(summary);
}

const execRun: Run = async (argv) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${argv.join(" ")} failed (${code}): ${stderr.trim()}`);
  return stdout;
};

const releaseArgs = z.object({
  release: z.string().min(1),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name"),
  out: z.string().min(1),
  sourceRoot: z.string().min(1),
});
const seedArgs = z.object({ seedDir: z.string().min(1), out: z.string().min(1) });

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const USAGE =
  "Usage: bun scripts/docs-sync.ts release --release <vX.Y.Z> --repo <owner/name> --out <dir> [--source-root <checkout of the release>]\n" +
  `       bun scripts/docs-sync.ts seed --seed-dir <checkout of ${SEED_BRANCH}>/${SEED_DIR} --out <dir>`;

async function main(): Promise<number> {
  const mode = process.argv[2];
  if (mode === "release") {
    const a = releaseArgs.safeParse({
      release: argValue("release"),
      repo: argValue("repo"),
      out: argValue("out"),
      sourceRoot: argValue("source-root") ?? join(import.meta.dir, ".."),
    });
    if (!a.success) {
      console.error(USAGE);
      return 2;
    }
    const out = resolve(a.data.out);
    mkdirSync(out, { recursive: true });
    const plan = await collectRelease(a.data.release, a.data.repo, execRun);
    const messages = buildReleaseMessages({
      release: plan.release,
      previousRelease: plan.previousRelease,
      releaseNotes: plan.releaseNotes,
      changes: plan.changes,
    });
    writeMessages(out, messages);
    const pages = await generateReference(resolve(a.data.sourceRoot), plan.release);
    writeReference(join(out, "reference"), plan.release, pages);
    writeFileSync(join(out, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    publishSummary(out, releaseSummary(plan, messages.length, pages.length));
    return plan.problems.length > 0 ? 1 : 0;
  }
  if (mode === "seed") {
    const a = seedArgs.safeParse({ seedDir: argValue("seed-dir"), out: argValue("out") });
    if (!a.success) {
      console.error(USAGE);
      return 2;
    }
    const dir = resolve(a.data.seedDir);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({ file: `${SEED_DIR}/${f}`, content: readFileSync(join(dir, f), "utf8") }));
    const pages = parseSeed(files);
    const out = resolve(a.data.out);
    mkdirSync(out, { recursive: true });
    writeMessages(out, buildSeedMessages(pages));
    writeFileSync(
      join(out, "plan.json"),
      `${JSON.stringify({ mode: "seed", marker: runMarker("seed"), pages: pages.map(({ file, path, title }) => ({ file, path, title })) }, null, 2)}\n`,
    );
    publishSummary(out, seedSummary(pages.map((p) => p.path)));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) {
  process.exit(await main());
}
