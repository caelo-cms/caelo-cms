// SPDX-License-Identifier: MPL-2.0

/**
 * Source extraction for the developer reference (#828, rendered by
 * scripts/docs-reference.ts): the public surface of a package entry from
 * its TSDoc, and the `cms-provision` command catalogue.
 *
 * Everything is read with the TypeScript parser (syntax only, no type
 * checker, no module loading): the release tree is data, never code that
 * runs in the workflow. Exported declarations are followed through
 * relative and star re-exports into sibling files; symbols tagged
 * `@internal` are left out; function and method bodies are replaced by
 * `{ … }` and private class members are hidden, so the reference shows the
 * contract, not the implementation.
 */

import { posix } from "node:path";
import ts from "typescript";
import { z } from "zod";
import type { SourceTree } from "./docs-source-tree.ts";

function parseSource(tree: SourceTree, file: string): ts.SourceFile {
  const text = tree.read(file);
  if (text === null) throw new Error(`reference source not found: ${file} in ${tree.label}`);
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

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

  constructor(private readonly tree: SourceTree) {}

  read(file: string): ts.SourceFile {
    const hit = this.cache.get(file);
    if (hit) return hit;
    const sf = parseSource(this.tree, file);
    this.cache.set(file, sf);
    return sf;
  }

  /** `./x.js` from `packages/a/src/index.ts` → `packages/a/src/x.ts` (or `x/index.ts`). */
  resolveRelative(from: string, spec: string): string {
    const base = posix.join(posix.dirname(from), spec.replace(/\.js$/, ""));
    for (const candidate of [`${base}.ts`, posix.join(base, "index.ts")]) {
      if (this.tree.read(candidate) !== null) return candidate;
    }
    throw new Error(`cannot resolve ${spec} from ${from} in ${this.tree.label}`);
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
 * The public surface of `entry` (repo-relative, read from `tree`): its
 * file-level TSDoc, every exported declaration in export order, and
 * re-exports from other packages as a list of names.
 */
export function extractModule(tree: SourceTree, entry: string): ExtractedModule {
  const reader = new ModuleReader(tree);
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

/** One `cms-provision` sub-command as the CLI reference lists it. */
export interface CliCommandEntry {
  readonly name: string;
  readonly args: string;
  readonly summary: string;
}

const cliCommandsSchema = z
  .array(z.object({ name: z.string().min(1), args: z.string(), summary: z.string().min(1) }))
  .min(1);

/** A string-literal expression (`"a"`, `` `a` ``, `"a" + "b"`) as its value; anything else is refused. */
function literalString(e: ts.Expression, file: string): string {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isParenthesizedExpression(e)) return literalString(e.expression, file);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return literalString(e.left, file) + literalString(e.right, file);
  }
  throw new Error(`${file}: CLI_COMMANDS must hold string literals only`);
}

/**
 * The `CLI_COMMANDS` catalogue declared in `entry`, read from its array
 * literal of `{ name, args, summary }` objects.
 *
 * @throws when the file declares no such catalogue (releases before the
 *   docs mirror, #828) or it is not plain literals.
 */
export function extractCliCommands(tree: SourceTree, entry: string): CliCommandEntry[] {
  const sf = parseSource(tree, entry);
  let init: ts.Expression | undefined;
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === "CLI_COMMANDS") init = d.initializer;
    }
  }
  while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)))
    init = init.expression;
  if (!init || !ts.isArrayLiteralExpression(init)) {
    throw new Error(
      `${entry} declares no CLI_COMMANDS array (releases before the docs mirror, #828, have none)`,
    );
  }
  const raw = init.elements.map((el) => {
    if (!ts.isObjectLiteralExpression(el)) {
      throw new Error(`${entry}: CLI_COMMANDS entries must be object literals`);
    }
    const o: Record<string, string> = {};
    for (const p of el.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
        o[p.name.text] = literalString(p.initializer, entry);
      }
    }
    return o;
  });
  const parsed = cliCommandsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${entry}: invalid CLI_COMMANDS (${parsed.error.message})`);
  return parsed.data;
}
