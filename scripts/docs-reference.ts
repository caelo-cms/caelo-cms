// SPDX-License-Identifier: MPL-2.0

/**
 * Public developer reference generator (#828): renders the Plugin SDK, the
 * Query API and the provisioning CLI from the repository into markdown
 * pages for the `/docs/reference/` section of caelo-cms.com.
 *
 *   bun scripts/docs-reference.ts --release v0.10.53 --out <dir> [--source-root <checkout>]
 *
 * writes `<dir>/manifest.json` plus one `<slug>.md` per page. The content
 * comes from `--source-root` (default: this checkout), which must be the
 * tree of the release the page links point at.
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
 * TSDoc is read with the TypeScript parser (syntax only, no type
 * checker): exported declarations of a package entry, following relative
 * re-exports into sibling files. Symbols tagged `@internal` are left out.
 * The output is checked for secret-shaped strings and local filesystem
 * paths before anything is written ({@link findLeaks}).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { z } from "zod";

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
// TSDoc extraction
// ---------------------------------------------------------------------------

/** One exported symbol as the reference shows it. */
export interface ExtractedSymbol {
  readonly name: string;
  readonly kind: string;
  /** Repo-relative file of the declaration. */
  readonly file: string;
  readonly line: number;
  readonly doc: string;
  readonly code: string;
}

/** A name re-exported from another package (`export { z }`, `export type { … } from "@caelo-cms/shared"`). */
export interface ForeignReexport {
  readonly names: readonly string[];
  readonly from: string;
}

/** The public surface of one entry file. */
export interface ExtractedModule {
  readonly fileDoc: string;
  readonly symbols: readonly ExtractedSymbol[];
  readonly foreign: readonly ForeignReexport[];
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** The last `/** … *\/` comment directly before `node`, as raw text. */
function leadingJsDoc(sf: ts.SourceFile, node: ts.Node): string | null {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  const docs = ranges
    .map((r) => sf.text.slice(r.pos, r.end))
    .filter((t) => t.startsWith("/**") && !t.startsWith("/**/"));
  return docs.at(-1) ?? null;
}

/** `/** a\n * b *\/` → `a\nb`, keeping blank lines and indentation inside the comment. */
export function jsDocText(raw: string): string {
  const inner = raw.replace(/^\/\*\*/, "").replace(/\*\/$/, "");
  return inner
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, "").trimEnd())
    .join("\n")
    .trim();
}

function isInternal(doc: string): boolean {
  return /(^|\s)@internal\b/.test(doc);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Replace a function-like body with `{ … }` so the reference shows signatures, not implementation. */
function withoutBody(sf: ts.SourceFile, node: ts.Node, body: ts.Node | undefined): string {
  if (!body) return node.getText(sf);
  return `${sf.text.slice(node.getStart(sf), body.getStart(sf)).trimEnd()} { … }`;
}

function classText(sf: ts.SourceFile, node: ts.ClassDeclaration): string {
  const header = sf.text
    .slice(node.getStart(sf), node.members.pos)
    .replace(/\{\s*$/, "")
    .trimEnd();
  const members: string[] = [];
  for (const m of node.members) {
    const mods = ts.canHaveModifiers(m) ? (ts.getModifiers(m) ?? []) : [];
    if (mods.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)) continue;
    if (m.name && ts.isPrivateIdentifier(m.name)) continue;
    if (ts.isClassStaticBlockDeclaration(m)) continue;
    const doc = leadingJsDoc(sf, m);
    if (doc && isInternal(jsDocText(doc))) continue;
    const body =
      ts.isMethodDeclaration(m) ||
      ts.isConstructorDeclaration(m) ||
      ts.isGetAccessorDeclaration(m) ||
      ts.isSetAccessorDeclaration(m)
        ? m.body
        : undefined;
    let text = withoutBody(sf, m, body);
    if (ts.isPropertyDeclaration(m) && m.initializer) {
      text = `${sf.text.slice(m.getStart(sf), m.initializer.getFullStart()).replace(/\s*=\s*$/, "")};`;
    }
    // Re-indent relative to the member's own column so JSDoc `*` columns
    // and nested blocks keep their alignment.
    const col = sf.getLineAndCharacterOfPosition(m.getStart(sf)).character;
    const dedent = (l: string) => l.replace(new RegExp(`^ {0,${col}}`), "");
    const indented = [doc, text]
      .filter((t): t is string => Boolean(t))
      .join("\n")
      .split("\n")
      .map((l, i) => (l.trim() === "" ? "" : `  ${i === 0 ? l : dedent(l)}`));
    members.push(indented.join("\n"));
  }
  return `${header} {\n${members.join("\n\n")}\n}`;
}

function variableText(sf: ts.SourceFile, stmt: ts.VariableStatement, d: ts.VariableDeclaration) {
  const keyword = stmt.declarationList.flags & ts.NodeFlags.Const ? "const" : "let";
  const init = d.initializer;
  const fnBody =
    init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isBlock(init.body)
      ? init.body
      : undefined;
  const declText = fnBody ? withoutBody(sf, d, fnBody) : d.getText(sf);
  return `export ${keyword} ${declText};`;
}

function declarationKind(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isEnumDeclaration(node)) return "enum";
  return "const";
}

/** Top-level declarations of a file by name (function overloads keep every signature). */
function declarationsByName(sf: ts.SourceFile): Map<string, ts.Node[]> {
  const out = new Map<string, ts.Node[]>();
  const add = (name: string, node: ts.Node) => out.set(name, [...(out.get(name) ?? []), node]);
  for (const s of sf.statements) {
    if (
      (ts.isFunctionDeclaration(s) ||
        ts.isInterfaceDeclaration(s) ||
        ts.isTypeAliasDeclaration(s) ||
        ts.isClassDeclaration(s) ||
        ts.isEnumDeclaration(s)) &&
      s.name
    ) {
      add(s.name.text, s);
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) add(d.name.text, d);
      }
    }
  }
  return out;
}

/** Import bindings of a file: local name → module specifier. */
function importsByName(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const from = s.moduleSpecifier.text;
    const clause = s.importClause;
    if (!clause) continue;
    if (clause.name) out.set(clause.name.text, from);
    const nb = clause.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) out.set(el.name.text, from);
    if (nb && ts.isNamespaceImport(nb)) out.set(nb.name.text, from);
  }
  return out;
}

class ModuleReader {
  private readonly cache = new Map<string, ts.SourceFile>();

  constructor(private readonly root: string) {}

  read(file: string): ts.SourceFile {
    const hit = this.cache.get(file);
    if (hit) return hit;
    const abs = join(this.root, file);
    if (!existsSync(abs)) throw new Error(`reference source not found: ${file}`);
    const sf = ts.createSourceFile(
      file,
      readFileSync(abs, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    this.cache.set(file, sf);
    return sf;
  }

  /** `./x.js` from `packages/a/src/index.ts` → `packages/a/src/x.ts` (or `x/index.ts`). */
  resolveRelative(from: string, spec: string): string {
    const base = join(dirname(from), spec.replace(/\.js$/, ""));
    for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
      if (existsSync(join(this.root, candidate)))
        return relative(this.root, resolve(this.root, candidate));
    }
    throw new Error(`cannot resolve ${spec} from ${from}`);
  }
}

function symbolFrom(
  sf: ts.SourceFile,
  exportedName: string,
  nodes: readonly ts.Node[],
): ExtractedSymbol | null {
  const first = nodes[0] as ts.Node;
  // A variable's TSDoc sits on its statement, not on the declarator.
  const docHost = (n: ts.Node) => (ts.isVariableDeclaration(n) ? n.parent.parent : n);
  const rawDoc = nodes.map((n) => leadingJsDoc(sf, docHost(n))).find((d) => d !== null) ?? null;
  const doc = rawDoc ? jsDocText(rawDoc) : "";
  if (isInternal(doc)) return null;
  const code = nodes
    .map((n) => {
      if (ts.isFunctionDeclaration(n)) return withoutBody(sf, n, n.body);
      if (ts.isClassDeclaration(n)) return classText(sf, n);
      if (ts.isVariableDeclaration(n))
        return variableText(sf, n.parent.parent as ts.VariableStatement, n);
      return n.getText(sf);
    })
    .join("\n");
  return {
    name: exportedName,
    kind: declarationKind(first),
    file: sf.fileName,
    line: lineOf(sf, docHost(first)),
    doc,
    code,
  };
}

/**
 * The public surface of `entry` (repo-relative, under `root`): its
 * file-level TSDoc, every exported declaration in export order, and
 * re-exports from other packages as a list of names.
 */
export function extractModule(root: string, entry: string): ExtractedModule {
  const reader = new ModuleReader(root);
  const sf = reader.read(entry);
  const symbols: ExtractedSymbol[] = [];
  const foreign: ForeignReexport[] = [];
  const seen = new Set<string>();

  const push = (s: ExtractedSymbol | null) => {
    if (!s || seen.has(s.name)) return;
    seen.add(s.name);
    symbols.push(s);
  };

  const collectAll = (file: string, visited: Set<string>) => {
    if (visited.has(file)) return;
    visited.add(file);
    const f = reader.read(file);
    walk(f, visited);
  };

  const fromFile = (file: string, name: string, exportedAs: string) => {
    const f = reader.read(file);
    const nodes = declarationsByName(f).get(name);
    if (!nodes) {
      // A barrel re-exporting a re-export: follow it one more hop.
      for (const s of f.statements) {
        if (
          ts.isExportDeclaration(s) &&
          s.moduleSpecifier &&
          ts.isStringLiteral(s.moduleSpecifier) &&
          s.moduleSpecifier.text.startsWith(".") &&
          s.exportClause &&
          ts.isNamedExports(s.exportClause)
        ) {
          const el = s.exportClause.elements.find((e) => e.name.text === name);
          if (el) {
            fromFile(
              reader.resolveRelative(file, s.moduleSpecifier.text),
              (el.propertyName ?? el.name).text,
              exportedAs,
            );
            return;
          }
        }
      }
      throw new Error(`${file}: no declaration named ${name} (re-exported as ${exportedAs})`);
    }
    push(symbolFrom(f, exportedAs, nodes));
  };

  function walk(f: ts.SourceFile, visited: Set<string>) {
    const local = declarationsByName(f);
    const imports = importsByName(f);
    const emitted = new Set<string>();
    for (const s of f.statements) {
      if (ts.isExportDeclaration(s)) {
        const spec =
          s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)
            ? s.moduleSpecifier.text
            : null;
        const elements =
          s.exportClause && ts.isNamedExports(s.exportClause) ? s.exportClause.elements : null;
        if (spec?.startsWith(".")) {
          const target = reader.resolveRelative(f.fileName, spec);
          if (!elements) collectAll(target, visited);
          else
            for (const el of elements)
              fromFile(target, (el.propertyName ?? el.name).text, el.name.text);
        } else if (spec) {
          foreign.push({ names: elements ? elements.map((e) => e.name.text) : ["*"], from: spec });
        } else if (elements) {
          for (const el of elements) {
            const name = (el.propertyName ?? el.name).text;
            const nodes = local.get(name);
            if (nodes) push(symbolFrom(f, el.name.text, nodes));
            else {
              const from = imports.get(name);
              if (!from) throw new Error(`${f.fileName}: cannot find the source of export ${name}`);
              foreign.push({ names: [el.name.text], from });
            }
          }
        }
        continue;
      }
      if (!hasExportModifier(s)) continue;
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) push(symbolFrom(f, d.name.text, [d]));
        }
        continue;
      }
      const name = (s as { name?: ts.Identifier }).name?.text;
      if (!name || emitted.has(name)) continue;
      emitted.add(name);
      push(symbolFrom(f, name, local.get(name) ?? [s]));
    }
  }

  walk(sf, new Set([entry]));

  // One line per foreign package, in order of first appearance.
  const merged = new Map<string, string[]>();
  for (const f of foreign) {
    const names = merged.get(f.from) ?? [];
    for (const n of f.names) if (!names.includes(n)) names.push(n);
    merged.set(f.from, names);
  }

  // File-level TSDoc: a doc comment before the first statement that is not
  // itself an exported declaration's doc.
  const firstStatement = sf.statements[0];
  let fileDoc = "";
  if (firstStatement && !hasExportModifier(firstStatement)) {
    const raw = leadingJsDoc(sf, firstStatement);
    if (raw) fileDoc = jsDocText(raw);
  }
  return {
    fileDoc,
    symbols,
    foreign: [...merged].map(([from, names]) => ({ from, names })),
  };
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

function renderTsdocPage(root: string, src: ReferenceSource, release: string): ReferencePage {
  const mod = extractModule(root, src.entry);
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

const cliCommandsSchema = z
  .array(z.object({ name: z.string().min(1), args: z.string(), summary: z.string().min(1) }))
  .min(1);

/**
 * The `CLI_COMMANDS` catalogue from `entry` under `root` — loaded from the
 * checked-out release, not from this script's own tree, so the page shows
 * the commands of the release it names.
 */
async function loadCliCommands(root: string, entry: string) {
  const mod = (await import(pathToFileURL(join(root, entry)).href)) as { CLI_COMMANDS?: unknown };
  const parsed = cliCommandsSchema.safeParse(mod.CLI_COMMANDS);
  if (!parsed.success) {
    throw new Error(
      `${entry} exports no valid CLI_COMMANDS catalogue (releases before the docs mirror, #828, have none)`,
    );
  }
  return parsed.data;
}

async function renderCliPage(
  root: string,
  src: ReferenceSource,
  release: string,
): Promise<ReferencePage> {
  const commands = await loadCliCommands(root, src.entry);
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
 * @param root - checkout of the release the pages describe (the source links
 *   point at `release`, so the content must come from that tree too).
 * @throws when the output would leak a secret-shaped string or a local path.
 */
export async function generateReference(
  root: string,
  release: string,
  sources: readonly ReferenceSource[] = REFERENCE_SOURCES,
): Promise<ReferencePage[]> {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release)) {
    throw new Error(`--release must be a release tag like v1.2.3, got "${release}"`);
  }
  const pages: ReferencePage[] = [];
  for (const s of sources) {
    pages.push(
      s.kind === "cli" ? await renderCliPage(root, s, release) : renderTsdocPage(root, s, release),
    );
  }
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

const cliArgs = z.object({
  release: z.string().min(1),
  out: z.string().min(1),
  sourceRoot: z.string().min(1).optional(),
});

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

if (import.meta.main) {
  const parsed = cliArgs.safeParse({
    release: argValue(process.argv, "release"),
    out: argValue(process.argv, "out"),
    sourceRoot: argValue(process.argv, "source-root"),
  });
  if (!parsed.success) {
    console.error(
      "Usage: bun scripts/docs-reference.ts --release <vX.Y.Z> --out <dir> [--source-root <checkout of the release>]",
    );
    process.exit(2);
  }
  const root = resolve(parsed.data.sourceRoot ?? join(import.meta.dir, ".."));
  const pages = await generateReference(root, parsed.data.release);
  writeReference(resolve(parsed.data.out), parsed.data.release, pages);
  console.log(`Wrote ${pages.length} reference page(s) to ${parsed.data.out}`);
}
