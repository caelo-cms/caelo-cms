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
 *   - ImportDeclaration of any module outside the audited surface
 *     (@caelo-cms/plugin-sdk, @caelo-cms/plugin-component-kit).
 *   - CallExpression of fetch / XMLHttpRequest / WebSocket / globalThis.fetch.
 *   - Reference to Deno.* (any property access).
 *   - Dynamic import() calls.
 *   - Template/string literals containing SQL *statements* (SELECT…FROM,
 *     INSERT INTO, DROP TABLE, …) — plugins go through query.* helpers.
 *   - eval / Function / new Function.
 *   - Top-level globalThis writes.
 *
 * Plus the manifest invariants (CMS_REQUIREMENTS §14):
 *   - Tier 2 manifests MUST NOT declare `requestedCapabilities`,
 *     `workers`, or `tools`.
 *   - Tier 2 manifests MUST declare `tier: 2`.
 *
 * Returns structured failures the AI can read + auto-fix from.
 */

import { type PluginManifest, pluginManifest as pluginManifestSchema } from "@caelo-cms/plugin-sdk";
// The bare `"oxc-parser"` import path here is load-bearing for the admin
// SSR build — `apps/admin/vite.config.ts` registers a `resolveId` hook
// (`forceOxcParserNativeEntry`) that intercepts this exact id, redirects
// to the native dispatcher (`src-js/index.js`), and lets Vite inline it.
// Importing a subpath (e.g. `oxc-parser/src-js/index.js`) directly would
// bypass the hook and resurrect the `"browser": "src-js/wasm.js"` crash
// from #52, or the externalization regression from #53. See those issues
// + the comment block above forceOxcParserNativeEntry for the full chain.
import { parseSync } from "oxc-parser";

// ---------------------------------------------------------------------------
// Failure shapes — surfaced to AI for auto-fix.
// ---------------------------------------------------------------------------

export type ValidationFailureKind =
  | "manifest-shape"
  | "manifest-tier-mismatch"
  | "manifest-tier2-cap-leak"
  | "manifest-cap-missing"
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

  // #389 — `ref:` FK columns are an adminSchema-only vocabulary:
  // cms_public tables cannot FK across databases into cms_admin.
  for (const [table, cols] of Object.entries(m.schema)) {
    for (const [col, spec] of Object.entries(cols)) {
      if (typeof spec === "string" && spec.startsWith("ref:")) {
        failures.push({
          kind: "schema-shape",
          hint: `schema.${table}.${col}: \`ref:\` columns are only valid in \`adminSchema\` (cms_public cannot FK into cms_admin). Store the id as a plain \`uuid\` column instead.`,
        });
      }
    }
  }

  // #388 — every capability is enforced, starting at the manifest:
  // declaring tools[] / workers[] without holding the matching
  // capability is a validation failure, not a silently-honoured extra.
  if (m.tier === 1) {
    const caps = new Set(m.requestedCapabilities ?? []);
    if (m.adminSchema && Object.keys(m.adminSchema).length > 0 && !caps.has("cms_admin_schema")) {
      failures.push({
        kind: "manifest-cap-missing",
        hint: "manifest declares `adminSchema` but does not request the `cms_admin_schema` capability. Add it to `requestedCapabilities` (or drop the adminSchema).",
      });
    }
    if (m.contributes && m.contributes.length > 0 && !caps.has("head_contributions")) {
      failures.push({
        kind: "manifest-cap-missing",
        hint: "manifest declares `contributes` (head/sitemap) but does not request the `head_contributions` capability. Add it to `requestedCapabilities` (or drop the contributions).",
      });
    }
    if (m.tools && m.tools.length > 0 && !caps.has("chat_runner_tools")) {
      failures.push({
        kind: "manifest-cap-missing",
        hint: "manifest declares `tools` but does not request the `chat_runner_tools` capability. Add it to `requestedCapabilities` (or drop the tools).",
      });
    }
    if (m.workers && m.workers.length > 0 && !caps.has("background_workers")) {
      failures.push({
        kind: "manifest-cap-missing",
        hint: "manifest declares `workers` but does not request the `background_workers` capability. Add it to `requestedCapabilities` (or drop the workers).",
      });
    }
  }

  // Tier 2 (runtime-authored) cannot reach over the grantability
  // ceiling: no capabilities, no workers, no chat tools, no cms_admin
  // schema.
  if (m.tier === 2) {
    if (m.contributes && m.contributes.length > 0) {
      failures.push({
        kind: "manifest-tier2-cap-leak",
        hint: "Runtime-authored plugins cannot declare `contributes` — head/sitemap contributions are release-signed only (#391).",
      });
    }
    if (m.urlContributions && m.urlContributions.length > 0) {
      failures.push({
        kind: "manifest-tier2-cap-leak",
        hint: "Runtime-authored plugins cannot declare `urlContributions` — URL-slot claims are release-signed only (#390).",
      });
    }
    if (m.adminSchema && Object.keys(m.adminSchema).length > 0) {
      failures.push({
        kind: "manifest-tier2-cap-leak",
        hint: "Runtime-authored plugins cannot declare `adminSchema` — a plugin-owned cms_admin schema is release-signed only (#389).",
      });
    }
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

  // Static-render flag must reflect intent — caught at registration when
  // the source is parsed, not here. Tracked via the source walker below.

  return { manifest: failures.length === 0 ? m : null, failures };
}

// ---------------------------------------------------------------------------
// Source validation — oxc-parser walk.
// ---------------------------------------------------------------------------

/**
 * SQL *statements* flagged inside template literals + string literals.
 * Matches statement shapes (keyword + its mandatory companion), not lone
 * keywords: a lone `INSERT`/`DELETE`/`SELECT` word appears in legitimate
 * plugin strings (operation names like "comment_archive.insert", tool
 * descriptions like "Delete a comment") and cannot execute as SQL anyway
 * — issue #387 root-caused the gateway marking every shipped plugin
 * `failed` partly on this false positive. A payload that WOULD execute
 * (SELECT…FROM, INSERT INTO, DROP TABLE, …) still trips the rule.
 */
const SQL_STATEMENT_RE =
  /\b(SELECT\s+[\s\S]{0,200}?\bFROM\b|INSERT\s+INTO\b|UPDATE\s+\S+\s+SET\b|DELETE\s+FROM\b|TRUNCATE\s+(TABLE\s+)?\S+|(DROP|CREATE|ALTER)\s+(TABLE|SCHEMA|POLICY|ROLE|INDEX|FUNCTION|TRIGGER|VIEW|DATABASE|EXTENSION)\b|GRANT\s+[\s\S]{0,80}?\bON\b)/i;

/** Allowed import sources. Plugins may ONLY import from this list.
 *  `plugin-component-kit` is the shared frontend kit (escapeHtml, honeypot,
 *  PoW, delta-fetch helpers) every shipped component uses — it is part of
 *  the audited plugin surface, same trust domain as the SDK. */
const ALLOWED_IMPORTS = new Set<string>([
  "@caelo-cms/plugin-sdk",
  "@caelo-cms/plugin-component-kit",
]);

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
        if (SQL_STATEMENT_RE.test(raw)) {
          failures.push({
            kind: "forbidden-sql-template",
            nodeType: type,
            snippet: raw.slice(0, 80),
            location: locOf(node),
            hint: "Template literals containing SQL statements are not allowed. Use ctx.query.insert/list/update/delete instead of raw SQL.",
          });
          return;
        }
      }
    }
    if (type === "Literal" || type === "StringLiteral") {
      const v = (node as { value?: unknown }).value;
      if (typeof v === "string" && SQL_STATEMENT_RE.test(v)) {
        failures.push({
          kind: "forbidden-sql-template",
          nodeType: type,
          snippet: v.slice(0, 80),
          location: locOf(node),
          hint: "String literals containing SQL statements are not allowed. Use ctx.query.* helpers.",
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
