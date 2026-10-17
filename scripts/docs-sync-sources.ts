// SPDX-License-Identifier: MPL-2.0

/**
 * Pure input side of the release docs-sync (#827): which release range a
 * run covers, which merged PRs in it change what operators and editors
 * see, what each PR says about the docs, and the seed pages of the
 * one-time `seed` mode.
 *
 * Contracts this file reads (owned elsewhere, kept as constants so a
 * rename shows up as a failing test rather than a silently empty run):
 *   - the `user-facing` PR label (#829),
 *   - the PR template heading `## User docs affected` (#829),
 *   - the `docs/cms-seed` branch's `seed/*.md` files with `path:` and
 *     `title:` frontmatter (#826).
 *
 * Everything here is deterministic and side-effect free; git / gh I/O
 * lives in scripts/docs-sync.ts.
 */

import { z } from "zod";

/** Label a PR carries when operators or editors notice the change. */
export const USER_FACING_LABEL = "user-facing";

/** PR template heading whose section tells the docs run what to change. */
export const USER_DOCS_HEADING = "## User docs affected";

/** Branch + directory the seed mode reads (#826). */
export const SEED_BRANCH = "docs/cms-seed";
export const SEED_DIR = "seed";

/** Only stable `vX.Y.Z` releases get a docs run; pre-releases do not. */
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** Whether `tag` names a stable release (`v1.2.3`, no pre-release suffix). */
export function isStableTag(tag: string): boolean {
  return STABLE_TAG.test(tag);
}

function semverKey(tag: string): [number, number, number] {
  const m = STABLE_TAG.exec(tag);
  if (!m) throw new Error(`not a stable release tag: ${tag}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareTags(a: string, b: string): number {
  const ka = semverKey(a);
  const kb = semverKey(b);
  for (let i = 0; i < 3; i++) {
    const d = (ka[i] as number) - (kb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The stable release directly before `current` among `tags`, or `null`
 * when `current` is the first one. Pre-release tags are ignored, so the
 * range of `v0.11.0` starts at `v0.10.x` even when `v0.11.0-rc.1` exists.
 *
 * @throws when `current` is not a stable tag — a docs run for a
 *   pre-release is a caller bug, not something to guess around.
 */
export function previousStableTag(tags: readonly string[], current: string): string | null {
  if (!isStableTag(current)) throw new Error(`not a stable release tag: ${current}`);
  const older = tags.filter((t) => isStableTag(t) && compareTags(t, current) < 0);
  older.sort(compareTags);
  return older.at(-1) ?? null;
}

/**
 * PR numbers merged in a release range, read from the commit subjects of
 * `git log --format=%s <prev>..<tag>`. Squash merges end in `(#N)` — when
 * a subject carries several (`fix: … (#799) (#812)`), the last one is the
 * PR, the earlier ones are issue references in the title. Classic merge
 * commits read `Merge pull request #N from …`. Sorted, de-duplicated.
 */
export function prNumbersFromSubjects(subjects: readonly string[]): number[] {
  const out = new Set<number>();
  for (const raw of subjects) {
    const subject = raw.trim();
    const squash = /\(#(\d+)\)\s*$/.exec(subject);
    const merge = /^Merge pull request #(\d+) /.exec(subject);
    const n = squash?.[1] ?? merge?.[1];
    if (n) out.add(Number(n));
  }
  return [...out].sort((a, b) => a - b);
}

/** The fields of `gh pr view --json number,title,body,labels,url,state` the run uses. */
export const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.string().url(),
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })),
});

export type PullRequest = z.infer<typeof pullRequestSchema>;

/** A user-facing PR and what it says the docs need. */
export interface DocsChange {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** The `## User docs affected` section, comments stripped. */
  readonly userDocs: string;
}

/** Why a user-facing PR could not be used; the job fails and names it. */
export interface DocsProblem {
  readonly number: number;
  readonly url: string;
  readonly problem: string;
}

/** Answers that mean "this PR changes no end-user docs". */
const NO_DOCS = /^(none|n\/a|na|no|-+|nothing)\.?$/i;

/**
 * The section under the exact `## User docs affected` heading of a PR
 * body, up to the next heading of level 1 or 2, with HTML comments (the
 * template's guidance) removed and surrounding blank lines trimmed.
 * Returns `null` when the heading is absent.
 */
export function extractUserDocsSection(body: string): string | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === USER_DOCS_HEADING);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
  const section = (end === -1 ? rest : rest.slice(0, end)).join("\n");
  return stripHtmlComments(section).trim();
}

/**
 * Remove `<!-- … -->` comments in one left-to-right scan; an unterminated
 * comment drops the rest. (A scan, not a regex replace: a replace can leave
 * a fresh `<!--` behind when comments are nested or interleaved.)
 */
function stripHtmlComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<!--", i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const close = text.indexOf("-->", open + 4);
    if (close === -1) break;
    i = close + 3;
  }
  return out;
}

/**
 * Split the PRs of a release into docs changes, PRs that explicitly
 * change no docs (skipped), and problems. Only merged PRs carrying
 * {@link USER_FACING_LABEL} are considered. A user-facing PR without the
 * section, or with the template left blank, is a problem: the run must
 * not guess what an unlabelled change means for operators (CLAUDE.md §2,
 * no fallbacks) — the fix is editing that PR's description and re-running.
 */
export function classifyPullRequests(prs: readonly PullRequest[]): {
  changes: DocsChange[];
  skipped: number[];
  problems: DocsProblem[];
} {
  const changes: DocsChange[] = [];
  const skipped: number[] = [];
  const problems: DocsProblem[] = [];
  const relevant = prs
    .filter((p) => p.state === "MERGED" && p.labels.some((l) => l.name === USER_FACING_LABEL))
    .sort((a, b) => a.number - b.number);
  for (const pr of relevant) {
    const section = extractUserDocsSection(pr.body);
    if (section === null) {
      problems.push({
        number: pr.number,
        url: pr.url,
        problem: `labelled ${USER_FACING_LABEL} but its description has no "${USER_DOCS_HEADING}" section — add it to the PR description and re-run the docs-sync workflow`,
      });
    } else if (section === "") {
      problems.push({
        number: pr.number,
        url: pr.url,
        problem: `labelled ${USER_FACING_LABEL} but its "${USER_DOCS_HEADING}" section is empty — say which docs change (or "none") and re-run the docs-sync workflow`,
      });
    } else if (NO_DOCS.test(section)) {
      skipped.push(pr.number);
    } else {
      changes.push({ number: pr.number, title: pr.title, url: pr.url, userDocs: section });
    }
  }
  return { changes, skipped, problems };
}

/** URL path of an end-user docs page: under `/docs/`, lowercase slug segments, trailing slash. */
const DOCS_PATH = /^\/docs\/(?:[a-z0-9][a-z0-9-]*\/)*$/;

/** Frontmatter of one seed file (#826). Extra keys are allowed and ignored. */
export const seedFrontmatterSchema = z.object({
  path: z
    .string()
    .regex(
      DOCS_PATH,
      "must be a /docs/ URL path of lowercase slug segments ending in a slash, e.g. /docs/install/gcp/",
    )
    .refine((p) => !p.startsWith("/docs/reference/"), {
      message: "/docs/reference/ is the repo-owned developer reference (#828), not seed content",
    }),
  title: z.string().trim().min(1).max(200),
});

/** One end-user page of the seed. */
export interface SeedPage {
  readonly file: string;
  readonly path: string;
  readonly title: string;
  /** Markdown body without the frontmatter. */
  readonly body: string;
}

/**
 * Parse a seed file: a `---`-delimited frontmatter block of `key: value`
 * lines (values optionally quoted) followed by the markdown body.
 *
 * @throws naming the file and what is wrong — a malformed seed must stop
 *   the run, not produce a half-seeded docs section.
 */
export function parseSeedFile(file: string, content: string): SeedPage {
  const text = content.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: missing the --- frontmatter block with path: and title:`);
  const fields: Record<string, string> = {};
  for (const line of (m[1] as string).split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${file}: unreadable frontmatter line "${line}"`);
    fields[kv[1] as string] = (kv[2] as string).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  const parsed = seedFrontmatterSchema.safeParse(fields);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`${file}: invalid frontmatter (${why})`);
  }
  const body = (m[2] as string).trim();
  if (!body) throw new Error(`${file}: empty page body`);
  return { file, path: parsed.data.path, title: parsed.data.title, body };
}

/**
 * Parse every seed file and check the set: at least one page, no two
 * files claiming the same URL path. Sorted by path so re-runs send the
 * pages in the same order.
 */
export function parseSeed(files: ReadonlyArray<{ file: string; content: string }>): SeedPage[] {
  if (files.length === 0) {
    throw new Error(`no ${SEED_DIR}/*.md files found on the ${SEED_BRANCH} branch`);
  }
  const pages = files.map((f) => parseSeedFile(f.file, f.content));
  const byPath = new Map<string, string>();
  for (const p of pages) {
    const other = byPath.get(p.path);
    if (other) throw new Error(`${p.file} and ${other} both claim ${p.path}`);
    byPath.set(p.path, p.file);
  }
  return pages.sort((a, b) => a.path.localeCompare(b.path));
}
