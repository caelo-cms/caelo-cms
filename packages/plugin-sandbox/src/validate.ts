// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-sandbox/validate — Phase 11 plugin static analysis.
 *
 * Walks plugin source code and rejects forbidden patterns before the
 * runtime ever loads the plugin. Three independent safety layers per
 * CMS_REQUIREMENTS §14.5; this is layer 1.
 *
 * For Tier 2 the validator gates activation (rejection ⇒ status stays
 * `draft`). For Tier 1 the validator runs at host startup as
 * defense-in-depth (rejection ⇒ status='failed' + the plugin refuses
 * to load + a clear error surfaces in /security/plugins).
 *
 * Forbidden patterns (rejected):
 *   - ImportDeclaration of any module other than @caelo-cms/plugin-sdk.
 *   - CallExpression of fetch / XMLHttpRequest / WebSocket / globalThis.fetch.
 *   - Reference to Deno.* (any property access).
 *   - Dynamic import() calls.
 *   - Template literals containing SQL keywords (SELECT/INSERT/UPDATE/
 *     DELETE/DROP/CREATE) — plugins go through query.* helpers.
 *   - eval / Function / new Function.
 *   - Top-level globalThis writes.
 *
 * Plus the schema invariants (CMS_REQUIREMENTS §14.6):
 *   - Any table with `page_id` MUST also declare `locale`.
 *   - Tier 2 manifests MUST NOT declare `requestedCapabilities`,
 *     `workers`, or `tools`.
 *   - Tier 2 manifests MUST declare `tier: 2`.
 *
 * Returns structured failures the AI can read + auto-fix from.
 */

import { type PluginManifest, pluginManifest as pluginManifestSchema } from "@caelo-cms/plugin-sdk";
import { parseSync } from "oxc-parser";

// ---------------------------------------------------------------------------
// Failure shapes — surfaced to AI for auto-fix.
// ---------------------------------------------------------------------------

export type ValidationFailureKind =
  | "manifest-shape"
  | "manifest-tier-mismatch"
  | "manifest-tier2-cap-leak"
  | "schema-missing-locale"
  | "schema-shape"
  | "forbidden-import"
  | "forbidden-call"
  | "forbidden-deno-access"
  | "forbidden-dynamic-import"
  | "forbidden-sql-template"
  | "forbidden-eval"
  | "forbidden-globalthis-write"
  | "parse-error";

export interface ValidationFailure {
  readonly kind: ValidationFailureKind;
  readonly nodeType?: string;
  readonly snippet?: string;
  readonly location?: { line: number; column: number };
  /** AI-actionable hint — tells the AI what to do instead. */
  readonly hint: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly failures: ReadonlyArray<ValidationFailure>;
  readonly manifest: PluginManifest | null;
}

// ---------------------------------------------------------------------------
// Manifest validation — pure JSON shape + tier invariants.
// ---------------------------------------------------------------------------

export function validateManifest(rawManifest: unknown): {
  manifest: PluginManifest | null;
  failures: ValidationFailure[];
} {
  const failures: ValidationFailure[] = [];
  const parsed = pluginManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    failures.push({
      kind: "manifest-shape",
      hint: `manifest does not match the required shape: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    });
    return { manifest: null, failures };
  }
  const m = parsed.data;

  // Tier 2 cannot request elevated capabilities.
  if (m.tier === 2) {
    if (m.requestedCapabilities && m.requestedCapabilities.length > 0) {
      failures.push({
        kind: "manifest-tier2-cap-leak",
        hint: "Tier 2 plugins cannot declare `requestedCapabilities`. Submit as Tier 1 (requires human PR + signed manifest) or drop the field.",
      });
    }
    if (m.workers && m.workers.length > 0) {
      failures.push({
        kind: "manifest-tier2-cap-leak",
        hint: "Tier 2 plugins cannot declare `workers` (background workers are Tier 1 only).",
      });
    }
    if (m.tools && m.tools.length > 0) {
      failures.push({
        kind: "manifest-tier2-cap-leak",
        hint: "Tier 2 plugins cannot declare `tools` (chat-runner tool registration is Tier 1 only).",
      });
    }
  }

  // Schema invariant: page_id ⇒ locale.
  for (const [tableName, columns] of Object.entries(m.schema)) {
    const colNames = Object.keys(columns);
    if (colNames.includes("page_id") && !colNames.includes("locale")) {
      failures.push({
        kind: "schema-missing-locale",
        hint: `Table "${tableName}" declares page_id but no locale column. Plugin schemas with per-page data must declare locale (CMS_REQUIREMENTS §14.6).`,
      });
    }
  }

  // Static-render flag must reflect intent — caught at registration when
  // the source is parsed, not here. Tracked via the source walker below.

  return { manifest: failures.length === 0 ? m : null, failures };
}

// ---------------------------------------------------------------------------
// Source validation — oxc-parser walk.
// ---------------------------------------------------------------------------

/** SQL keywords flagged inside template literals + string literals. */
const SQL_KEYWORD_RE = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b/i;

/** Allowed import sources. Plugins may ONLY import from this list. */
const ALLOWED_IMPORTS = new Set<string>(["@caelo-cms/plugin-sdk"]);

/**
 * Walk the AST and collect failures. Called for both Tier 1 (defense
 * in depth at startup) and Tier 2 (gating activation).
 */
export function validateSource(opts: { filename: string; source: string }): ValidationFailure[] {
  const { filename, source } = opts;
  const failures: ValidationFailure[] = [];

  let ast: unknown;
  try {
    const parsed = parseSync(filename, source, { sourceType: "module" });
    ast = parsed.program;
  } catch (e) {
    failures.push({
      kind: "parse-error",
      hint: `oxc-parser could not parse the source: ${(e as Error).message}`,
    });
    return failures;
  }

  walk(ast, (node, parents) => {
    if (!node || typeof node !== "object") return;
    const type = (node as { type?: string }).type;
    if (!type) return;

    // ImportDeclaration — only @caelo-cms/plugin-sdk allowed.
    if (type === "ImportDeclaration") {
      const sourceVal = (node as { source?: { value?: unknown } }).source?.value;
      if (typeof sourceVal !== "string" || !ALLOWED_IMPORTS.has(sourceVal)) {
        failures.push({
          kind: "forbidden-import",
          nodeType: type,
          snippet: typeof sourceVal === "string" ? sourceVal : "<unknown>",
          location: locOf(node),
          hint: `import "${sourceVal ?? "<unknown>"}" is not allowed. Plugins may import only from "@caelo-cms/plugin-sdk".`,
        });
      }
      return;
    }

    // ImportExpression — dynamic import() (oxc-parser uses ImportExpression for dynamic; some versions: CallExpression w/ Import).
    if (type === "ImportExpression") {
      failures.push({
        kind: "forbidden-dynamic-import",
        nodeType: type,
        location: locOf(node),
        hint: "Dynamic import() is not allowed. Use static `import` from @caelo-cms/plugin-sdk.",
      });
      return;
    }

    // CallExpression — fetch, XMLHttpRequest, eval, Function, dynamic import (legacy AST shape).
    if (type === "CallExpression") {
      const callee = (node as { callee?: unknown }).callee;
      const calleeName = identifierName(callee);
      if (calleeName === "fetch" || calleeName === "XMLHttpRequest" || calleeName === "WebSocket") {
        failures.push({
          kind: "forbidden-call",
          nodeType: type,
          snippet: calleeName,
          location: locOf(node),
          hint: `${calleeName}() is not allowed. Use ctx.api / ctx.query for I/O.`,
        });
        return;
      }
      if (calleeName === "eval") {
        failures.push({
          kind: "forbidden-eval",
          nodeType: type,
          snippet: "eval",
          location: locOf(node),
          hint: "eval() is not allowed.",
        });
        return;
      }
      if (calleeName === "Function") {
        failures.push({
          kind: "forbidden-eval",
          nodeType: type,
          snippet: "Function",
          location: locOf(node),
          hint: "Function() constructor is not allowed (treated as dynamic eval).",
        });
        return;
      }
      // globalThis.fetch / window.fetch / self.fetch
      if (callee && (callee as { type?: string }).type === "MemberExpression") {
        const objName = identifierName((callee as { object?: unknown }).object);
        const propName = identifierName((callee as { property?: unknown }).property);
        if (
          (objName === "globalThis" || objName === "window" || objName === "self") &&
          (propName === "fetch" || propName === "XMLHttpRequest" || propName === "WebSocket")
        ) {
          failures.push({
            kind: "forbidden-call",
            nodeType: type,
            snippet: `${objName}.${propName}`,
            location: locOf(node),
            hint: `${objName}.${propName}() is not allowed. Use ctx.api / ctx.query for I/O.`,
          });
          return;
        }
      }
    }

    // NewExpression for Function — `new Function('...')`.
    if (type === "NewExpression") {
      const calleeName = identifierName((node as { callee?: unknown }).callee);
      if (calleeName === "Function") {
        failures.push({
          kind: "forbidden-eval",
          nodeType: type,
          snippet: "new Function",
          location: locOf(node),
          hint: "new Function() is not allowed (treated as dynamic eval).",
        });
        return;
      }
    }

    // Identifier referencing Deno — any access.
    if (type === "Identifier" && (node as { name?: string }).name === "Deno") {
      // Skip the Identifier inside its own declaration shadow (rare).
      // Skip when the parent is a MemberExpression *property* (e.g. someObj.Deno) — only the object position is interesting.
      const parent = parents[parents.length - 1] as
        | { type?: string; property?: unknown }
        | undefined;
      if (
        parent?.type === "MemberExpression" &&
        (parent as { property?: unknown }).property === node
      ) {
        return;
      }
      failures.push({
        kind: "forbidden-deno-access",
        nodeType: type,
        snippet: "Deno",
        location: locOf(node),
        hint: "Deno.* is not accessible to plugins. Use ctx.query / ctx.api / ctx.theme.",
      });
      return;
    }

    // TemplateLiteral / Literal containing SQL keywords.
    if (type === "TemplateLiteral") {
      const quasis = (node as { quasis?: Array<{ value?: { raw?: string } }> }).quasis ?? [];
      for (const q of quasis) {
        const raw = q.value?.raw ?? "";
        if (SQL_KEYWORD_RE.test(raw)) {
          failures.push({
            kind: "forbidden-sql-template",
            nodeType: type,
            snippet: raw.slice(0, 80),
            location: locOf(node),
            hint: "Template literals containing SQL keywords are not allowed. Use ctx.query.insert/list/update/delete instead of raw SQL.",
          });
          return;
        }
      }
    }
    if (type === "Literal" || type === "StringLiteral") {
      const v = (node as { value?: unknown }).value;
      if (typeof v === "string" && SQL_KEYWORD_RE.test(v)) {
        failures.push({
          kind: "forbidden-sql-template",
          nodeType: type,
          snippet: v.slice(0, 80),
          location: locOf(node),
          hint: "String literals containing SQL keywords are not allowed. Use ctx.query.* helpers.",
        });
        return;
      }
    }

    // AssignmentExpression to globalThis.* at top level.
    if (type === "AssignmentExpression") {
      const left = (node as { left?: unknown }).left;
      if (left && (left as { type?: string }).type === "MemberExpression") {
        const objName = identifierName((left as { object?: unknown }).object);
        if (objName === "globalThis" || objName === "window" || objName === "self") {
          failures.push({
            kind: "forbidden-globalthis-write",
            nodeType: type,
            snippet: `${objName}.*`,
            location: locOf(node),
            hint: `Writes to ${objName} are not allowed. Plugins must not pollute the global scope.`,
          });
          return;
        }
      }
    }
  });

  return failures;
}

// ---------------------------------------------------------------------------
// Combined entry point — manifest + source.
// ---------------------------------------------------------------------------

export function validatePlugin(opts: {
  manifest: unknown;
  source: string;
  filename?: string;
}): ValidationResult {
  const { failures: manifestFailures, manifest } = validateManifest(opts.manifest);
  const sourceFailures = validateSource({
    filename: opts.filename ?? "plugin.ts",
    source: opts.source,
  });
  const all = [...manifestFailures, ...sourceFailures];
  return { ok: all.length === 0, failures: all, manifest };
}

// ---------------------------------------------------------------------------
// Walker helpers.
//
// Hardened against three failure modes:
//   1. Self-referential or cyclical nodes — tracked via a visited set.
//   2. Pathologically deep ASTs — depth cap aborts beyond MAX_DEPTH.
//   3. Wasted descent into metadata (loc/range/comments/etc.) — only
//      descend into the AST child-property allowlist.
//
// The allowlist lists every property name oxc-parser uses for child
// references in ESTree-shape ASTs. Anything else (loc, range, span,
// raw, type, comments, sourceType, kind discriminators, etc.) is
// skipped — no recursion, no work.
// ---------------------------------------------------------------------------

type Visitor = (node: unknown, parents: unknown[]) => void;

const MAX_DEPTH = 200;

const CHILD_KEYS: ReadonlySet<string> = new Set([
  // Statement/expression children.
  "body",
  "expression",
  "expressions",
  "declarations",
  "declaration",
  "init",
  "test",
  "update",
  "consequent",
  "alternate",
  "cases",
  "param",
  "params",
  "block",
  "handler",
  "finalizer",
  "discriminant",
  "object",
  "property",
  "objects",
  "label",
  // Calls + member expressions.
  "callee",
  "arguments",
  "argument",
  // Assign / binary / logical / unary.
  "left",
  "right",
  "operator",
  "prefix",
  // Object/array literals.
  "elements",
  "properties",
  "method",
  "shorthand",
  "computed",
  "key",
  "value",
  // Class members.
  "superClass",
  "definitions",
  "decorators",
  "static",
  "abstract",
  // Imports.
  "source",
  "specifiers",
  "imported",
  "local",
  "exported",
  "attributes",
  // Templates.
  "quasi",
  "quasis",
  "tag",
  // Misc identifiers.
  "id",
  "name",
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "extends",
  "implements",
]);

function walk(node: unknown, visit: Visitor): void {
  if (!node || typeof node !== "object") return;
  const visited = new WeakSet<object>();
  walkInner(node, visit, [], visited, 0);
}

function walkInner(
  node: unknown,
  visit: Visitor,
  parents: unknown[],
  visited: WeakSet<object>,
  depth: number,
): void {
  if (!node || typeof node !== "object") return;
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(node)) {
    for (const child of node) walkInner(child, visit, parents, visited, depth);
    return;
  }
  if (visited.has(node as object)) return;
  visited.add(node as object);
  visit(node, parents);
  const nextParents = [...parents, node];
  for (const key of CHILD_KEYS) {
    const child = (node as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      walkInner(child, visit, nextParents, visited, depth + 1);
    }
  }
}

function identifierName(n: unknown): string | null {
  if (!n || typeof n !== "object") return null;
  const t = (n as { type?: string }).type;
  if (t === "Identifier") return (n as { name?: string }).name ?? null;
  return null;
}

function locOf(n: unknown): { line: number; column: number } | undefined {
  const loc = (n as { loc?: { start?: { line?: number; column?: number } } }).loc;
  if (!loc?.start) return undefined;
  return { line: loc.start.line ?? 0, column: loc.start.column ?? 0 };
}
