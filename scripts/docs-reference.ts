// SPDX-License-Identifier: MPL-2.0

/**
 * Public developer reference generator (#828): renders the Plugin SDK, the
 * Query API and the provisioning CLI from the repository into markdown
 * pages for the `/docs/reference/` section of caelo-cms.com.
 *
 *   bun scripts/docs-reference.ts --release v0.10.53 --out <dir> [--from-tag]
 *
 * writes `<dir>/manifest.json` plus one `<slug>.md` per page. With
 * `--from-tag` the content is read from the release tag's git objects
 * (what the workflow does); without it, from this checkout's files.
 *
 * One way only: the repository is the source of truth (epic #825). Every
 * page opens with a "generated, do not edit here" notice, carries
 * `owner: repo` in its frontmatter and links each symbol to its source
 * line on GitHub at the release tag, so a reader (or the CMS's AI) can
 * tell it apart from hand-written docs and knows where a fix belongs.
 *
 * Deterministic by construction: no timestamps, no environment input
 * beyond the release tag, symbols in declaration/export order. The same
 * tree and tag always produce byte-identical output, which is what makes
 * a re-run for one release a no-op.
 *
 * Extraction lives in scripts/docs-reference-extract.ts. The output is checked for secret-shaped strings and local filesystem
 * paths before anything is written ({@link findLeaks}).
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { extractCliCommands, extractModule } from "./docs-reference-extract.ts";
import { fsTree, gitTree, type SourceTree } from "./docs-source-tree.ts";

/** Public repository the source links point at. */
export const REPO_URL = "https://github.com/caelo-cms/caelo-cms";

/** URL prefix of the mirrored section in the CMS. */
export const REFERENCE_ROOT = "/docs/reference/";

/** Longest code block rendered for one symbol before it is cut with a pointer to the source. */
const MAX_CODE_LINES = 120;

/** One page of the reference. */
export interface ReferenceSource {
  readonly slug: string;
  readonly title: string;
  /** Lead paragraph shown under the title when the entry file has no file-level TSDoc. */
  readonly intro: string;
  readonly kind: "tsdoc" | "cli";
  /** Repo-relative entry file (`tsdoc`) or the file holding the CLI catalogue (`cli`). */
  readonly entry: string;
}

/**
 * What is public reference. Developer docs that describe how Caelo is
 * built (docs/, ARCHITECTURE.md, CLAUDE.md) stay in the repository and
 * are deliberately not mirrored.
 */
export const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  {
    slug: "plugin-sdk",
    title: "Plugin SDK reference",
    intro: "The contract between Caelo's plugin host and every plugin.",
    kind: "tsdoc",
    entry: "packages/plugin-sdk/src/index.ts",
  },
  {
    slug: "query-api",
    title: "Query API reference",
    intro:
      "Every database access in Caelo goes through the Query API: named operations, validated input, executed by the database adapter under row-level security. This page lists its public surface.",
    kind: "tsdoc",
    entry: "packages/query-api/src/index.ts",
  },
  {
    slug: "provisioning-cli",
    title: "Provisioning CLI reference (cms-provision)",
    intro:
      "`cms-provision` installs and operates a Caelo install: `bunx @caelo-cms/provisioning --provider <name>` runs the install wizard; the sub-commands below cover the lifecycle afterwards.",
    kind: "cli",
    entry: "packages/provisioning/src/cli-routing.ts",
  },
];

/** A rendered page. */
export interface ReferencePage {
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  /** Repo-relative files the page was generated from. */
  readonly sources: readonly string[];
  readonly markdown: string;
}

/** `manifest.json` next to the pages: what the mirror run consumes. */
export const referenceManifestSchema = z.object({
  release: z.string(),
  repo: z.string().url(),
  pages: z.array(
    z.object({
      slug: z.string(),
      path: z.string(),
      title: z.string(),
      file: z.string(),
      sources: z.array(z.string()),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

export type ReferenceManifest = z.infer<typeof referenceManifestSchema>;

/** GitHub URL of `file` at `release`, optionally at a line. */
export function sourceUrl(release: string, file: string, line?: number): string {
  return `${REPO_URL}/blob/${release}/${file}${line ? `#L${line}` : ""}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function codeFence(code: string, info: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}${info}\n${code}\n${f}`;
}

function capLines(code: string, link: string): string {
  const lines = code.split("\n");
  // A cut only pays off when it saves a real amount of text.
  if (lines.length <= MAX_CODE_LINES + 20) return code;
  return [
    ...lines.slice(0, MAX_CODE_LINES),
    `// … ${lines.length - MAX_CODE_LINES} more lines, see ${link}`,
  ].join("\n");
}

function frontmatter(page: { path: string; title: string }, release: string, source: string) {
  return [
    "---",
    `path: ${page.path}`,
    `title: ${JSON.stringify(page.title)}`,
    "owner: repo",
    `release: ${release}`,
    `source: ${source}`,
    "---",
  ].join("\n");
}

/**
 * The notice every mirrored page opens with: who owns the page, which
 * release it shows, and where an edit has to go instead.
 */
export function repoOwnedNotice(release: string, files: readonly string[]): string {
  const links = files.map((f) => `[\`${f}\`](${sourceUrl(release, f)})`).join(", ");
  return `> **Generated from the Caelo repository. Do not edit this page in the CMS.** It mirrors ${links} at release \`${release}\` and is replaced on every release. To change it, edit the source on GitHub.`;
}

function renderTsdocPage(tree: SourceTree, src: ReferenceSource, release: string): ReferencePage {
  const mod = extractModule(tree, src.entry);
  const path = `${REFERENCE_ROOT}${src.slug}/`;
  const files = [...new Set([src.entry, ...mod.symbols.map((s) => s.file)])].sort();
  const parts = [
    frontmatter({ path, title: src.title }, release, sourceUrl(release, src.entry)),
    "",
    repoOwnedNotice(release, files),
    "",
    `# ${src.title}`,
    "",
    mod.fileDoc || src.intro,
  ];
  for (const s of mod.symbols) {
    const link = sourceUrl(release, s.file, s.line);
    parts.push(
      "",
      `## \`${s.name}\``,
      "",
      `*${s.kind}* · [source](${link})`,
      ...(s.doc ? ["", s.doc] : []),
      "",
      codeFence(capLines(s.code, link), "ts"),
    );
  }
  if (mod.foreign.length > 0) {
    parts.push("", "## Re-exported from other packages", "");
    for (const f of mod.foreign) {
      parts.push(`- from \`${f.from}\`: ${f.names.map((n) => `\`${n}\``).join(", ")}`);
    }
  }
  return {
    slug: src.slug,
    path,
    title: src.title,
    sources: files,
    markdown: `${parts.join("\n")}\n`,
  };
}

function renderCliPage(tree: SourceTree, src: ReferenceSource, release: string): ReferencePage {
  const commands = extractCliCommands(tree, src.entry);
  const path = `${REFERENCE_ROOT}${src.slug}/`;
  const parts = [
    frontmatter({ path, title: src.title }, release, sourceUrl(release, src.entry)),
    "",
    repoOwnedNotice(release, [src.entry]),
    "",
    `# ${src.title}`,
    "",
    src.intro,
    "",
    "Run any command as `bunx @caelo-cms/provisioning <command>`. With several installs on one machine, pick one with `--install <install-id or domain>`.",
  ];
  for (const c of commands) {
    parts.push(
      "",
      `## \`${c.name}\``,
      "",
      codeFence(`cms-provision ${c.name}${c.args ? ` ${c.args}` : ""}`, "sh"),
      "",
      c.summary,
    );
  }
  return {
    slug: src.slug,
    path,
    title: src.title,
    sources: [src.entry],
    markdown: `${parts.join("\n")}\n`,
  };
}

function renderIndexPage(pages: readonly ReferencePage[], release: string): ReferencePage {
  const title = "Developer reference";
  const parts = [
    frontmatter({ path: REFERENCE_ROOT, title }, release, `${REPO_URL}/tree/${release}`),
    "",
    `> **Generated from the Caelo repository. Do not edit this section in the CMS.** It shows release \`${release}\` and is replaced on every release. Contributor documentation (architecture, conventions, runbooks) lives in the [repository](${REPO_URL}/tree/${release}).`,
    "",
    `# ${title}`,
    "",
    "Reference for developers building on Caelo: plugins, the Query API and the provisioning CLI.",
    "",
    ...pages.map((p) => `- [${p.title}](${p.path})`),
  ];
  return {
    slug: "index",
    path: REFERENCE_ROOT,
    title,
    sources: [],
    markdown: `${parts.join("\n")}\n`,
  };
}

/**
 * Every page of the reference for `release`, index first.
 *
 * @param tree - the release the pages describe (the source links point at
 *   `release`, so the content must come from that tree too).
 * @throws when the output would leak a secret-shaped string or a local path.
 */
export function generateReference(
  tree: SourceTree,
  release: string,
  sources: readonly ReferenceSource[] = REFERENCE_SOURCES,
): ReferencePage[] {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release)) {
    throw new Error(`--release must be a release tag like v1.2.3, got "${release}"`);
  }
  const pages = sources.map((s) =>
    s.kind === "cli" ? renderCliPage(tree, s, release) : renderTsdocPage(tree, s, release),
  );
  const all = [renderIndexPage(pages, release), ...pages];
  const leaks = all.flatMap((p) => findLeaks(p.markdown).map((l) => `${p.path}: ${l}`));
  if (leaks.length > 0) {
    throw new Error(`refusing to publish the reference, it contains:\n${leaks.join("\n")}`);
  }
  return all;
}

// ---------------------------------------------------------------------------
// Leak guard
// ---------------------------------------------------------------------------

const LEAK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a local home-directory path", /(?:^|[\s"'`(])(?:\/Users\/|\/home\/[a-z]|[A-Z]:\\Users\\)/m],
  ["an operator secrets directory (~/.caelo-*)", /~\/\.caelo-[a-z0-9]/],
  ["a link into docs/internal/", /docs\/internal\//],
  ["an Anthropic API key", /sk-ant-[A-Za-z0-9_-]{16,}/],
  ["an OpenAI-style API key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["an AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a database URL with a password", /\bpostgres(?:ql)?:\/\/[^\s:/@]+:[^\s@/]+@/],
];

/** Human-readable reasons `text` must not be published; empty when it is clean. */
export function findLeaks(text: string): string[] {
  return LEAK_PATTERNS.filter(([, re]) => re.test(text)).map(([what]) => what);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** The manifest for `pages`; `file` is the page's markdown file name in the output dir. */
export function buildManifest(release: string, pages: readonly ReferencePage[]): ReferenceManifest {
  return referenceManifestSchema.parse({
    release,
    repo: REPO_URL,
    pages: pages.map((p) => ({
      slug: p.slug,
      path: p.path,
      title: p.title,
      file: `${p.slug}.md`,
      sources: [...p.sources],
      sha256: createHash("sha256").update(p.markdown).digest("hex"),
    })),
  });
}

/** Write the pages and `manifest.json` into `outDir`. */
export function writeReference(outDir: string, release: string, pages: readonly ReferencePage[]) {
  mkdirSync(outDir, { recursive: true });
  for (const p of pages) writeFileSync(join(outDir, `${p.slug}.md`), p.markdown);
  writeFileSync(
    join(outDir, "manifest.json"),
    `${JSON.stringify(buildManifest(release, pages), null, 2)}\n`,
  );
}

const cliArgs = z.object({ release: z.string().min(1), out: z.string().min(1) });

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

if (import.meta.main) {
  const parsed = cliArgs.safeParse({
    release: argValue(process.argv, "release"),
    out: argValue(process.argv, "out"),
  });
  if (!parsed.success) {
    console.error(
      "Usage: bun scripts/docs-reference.ts --release <vX.Y.Z> --out <dir> [--from-tag]",
    );
    process.exit(2);
  }
  const repoRoot = join(import.meta.dir, "..");
  const tree = process.argv.includes("--from-tag")
    ? gitTree(`refs/tags/${parsed.data.release}`, repoRoot)
    : fsTree(repoRoot);
  const pages = generateReference(tree, parsed.data.release);
  writeReference(resolve(parsed.data.out), parsed.data.release, pages);
  console.log(`Wrote ${pages.length} reference page(s) to ${parsed.data.out}`);
}
