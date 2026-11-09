// SPDX-License-Identifier: MPL-2.0

/**
 * #1536 — a shipped plugin's unit tests fake its store through the SDK's
 * `indexCheckedQuery`.
 *
 * The host refuses a `list()` no index of the plugin's manifest can drive
 * (#1292). international-site 0.12.2 shipped such a read: its unit test
 * reached it, but through a bare `{ list: async () => rows }` that answers
 * every read, so CI passed and every Stage's audit on a production install
 * errored. A fake wrapped in `indexCheckedQuery(plugin, zone, …)` throws the
 * host's refusal instead, so a read the host would refuse fails the test
 * that reaches it.
 *
 * The scan parses each test (TypeScript AST) and fails on:
 * - an object literal that defines `list` — as a property, a method
 *   (`list(t) {…}`, `async list(t) {…}`) or shorthand — and is not the
 *   third argument of `indexCheckedQuery(…)`;
 * - an assignment to `<something>.list`, which would replace a checked
 *   `list` after the fact.
 * A fake that is not a store (another handle with a `list`), or a store
 * wrapped where it is handed out, is allowed with a reason below.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PLUGINS = resolve(REPO_ROOT, "packages/plugins");

/** `<file>: <first line of the literal or assignment>` → why it may stay unwrapped. */
const ALLOWED: Record<string, string> = {
  "packages/plugins/consent-manager/src/render-hooks.test.ts: { list: async () => [] }":
    "the visitor's consent purposes (ctx.consentPurposes), not a store",
  "packages/plugins/newsletter/src/send-runs.test.ts: {":
    "FakeStore.handle(): every handle it gives out is wrapped where the harness hands it to the plugin (query, adminQuery)",
  "packages/plugins/newsletter/src/send-runs.test.ts: {\n      ...admin,":
    "overrides list() of a handle wrapped in indexCheckedQuery and delegates to it",
};

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

const isListName = (name: ts.PropertyName | undefined): boolean =>
  name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "list";

/** Does this object literal define a `list` member? */
function definesList(node: ts.ObjectLiteralExpression): boolean {
  return node.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isShorthandPropertyAssignment(p)) &&
      isListName(p.name),
  );
}

/** Is this literal the store argument of `indexCheckedQuery(manifest, zone, store)`? */
function isCheckedStore(node: ts.ObjectLiteralExpression): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  // `({ … }) as X` and `({ … })` still hand the literal over.
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) {
    child = parent;
    parent = parent.parent;
  }
  return (
    parent !== undefined &&
    ts.isCallExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === "indexCheckedQuery" &&
    parent.arguments[2] === child
  );
}

/** Every store literal not handed to indexCheckedQuery, and every `x.list = …`, by its first line(s). */
function uncheckedStores(src: string): string[] {
  const file = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const head = (node: ts.Node) => {
    const text = node.getText(file);
    // The opening line; for a literal that only spreads first, the spread too.
    const lines = text.split("\n");
    return (
      lines[0]?.trim() === "{" && lines[1]?.trim().startsWith("...")
        ? `{\n${lines[1]}`
        : (lines[0] ?? "")
    ).trimEnd();
  };
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node) && definesList(node) && !isCheckedStore(node)) {
      out.push(head(node));
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "list"
    ) {
      out.push(head(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

describe("#1536 — shipped plugins' test stores apply the host's read rule", () => {
  it("finds every way to define list() outside indexCheckedQuery", () => {
    expect(uncheckedStores("const q = {\n  list: async () => rows,\n};")).toEqual(["{"]);
    expect(uncheckedStores("const s = {\n  async list(table) { return []; },\n};")).toEqual(["{"]);
    expect(
      uncheckedStores("const s = {\n  list(table) { return Promise.resolve(rows); },\n};"),
    ).toEqual(["{"]);
    expect(uncheckedStores("const list = async () => rows;\nconst s = { list };")).toEqual([
      "{ list }",
    ]);
    expect(uncheckedStores("q.list = async () => rows;")).toEqual(["q.list = async () => rows"]);
  });

  it("accepts a store handed to indexCheckedQuery, also through a cast", () => {
    expect(
      uncheckedStores(
        'const q = indexCheckedQuery(plugin, "adminSchema", {\n  list: async () => rows,\n});',
      ),
    ).toEqual([]);
    expect(
      uncheckedStores(
        'const q = indexCheckedQuery(plugin, "schema", { list: async () => rows } as unknown as Q);',
      ),
    ).toEqual([]);
    // A call to list() is a read, not a definition.
    expect(uncheckedStores('await q.list("t", {});\nconst r = { rows: list() };')).toEqual([]);
  });

  it("every store a shipped plugin's test fakes is index-checked", () => {
    const found: string[] = [];
    for (const path of testFiles(PLUGINS)) {
      const file = relative(REPO_ROOT, path);
      for (const line of uncheckedStores(readFileSync(path, "utf8"))) {
        found.push(`${file}: ${line}`);
      }
    }
    const unexplained = found.filter((f) => !(f in ALLOWED));
    expect(
      unexplained,
      "wrap the fake in indexCheckedQuery(plugin, zone, …) from @caelo-cms/plugin-sdk, or add it to ALLOWED with the reason it is not a store",
    ).toEqual([]);
    // A stale allow-list entry fails too: the exception it explained is gone.
    expect(Object.keys(ALLOWED).filter((k) => !found.includes(k))).toEqual([]);
  });
});
