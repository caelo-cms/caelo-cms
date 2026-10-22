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
 * to load + a clear error surfaces in /settings/plugins).
 *
 * Forbidden patterns (rejected):
 *   - ImportDeclaration of any module outside the audited surface
 *     (@caelo-cms/plugin-sdk, @caelo-cms/plugin-component-kit).
 *   - CallExpression of fetch / XMLHttpRequest / WebSocket / globalThis.fetch.
 *   - Reference to Deno.* (any property access).
 *   - Dynamic import() calls.
 *   - Template/string literals containing SQL *statements* (SELECT…FROM,
 *     INSERT INTO, DROP TABLE, …) — plugins go through query.* helpers.
 *   - eval / Function / new Function, by any reference (`(0, eval)(…)`,
 *     `const e = eval`), and calling a `.constructor` (the
 *     function-constructor escape), including constant-folded computed
 *     spellings (`f["con" + "structor"](…)`).
 *   - globalThis / window / self used as a value (aliasing, passing it to
 *     a function) — only direct member access is analysable.
 *   - Top-level globalThis writes.
 *
 * This layer is static and therefore incomplete by nature: a computed
 * member whose key is only known at runtime (`obj[k]`) cannot be judged
 * here. It is defense in depth. The guarantee is the runtime layer: the
 * Deno child runs with every permission denied and with code generation
 * from strings disabled, and the sandbox prelude removes `Deno` before
 * plugin code runs (plugin-host `sandbox-runtime.ts` / `sandbox-entry.ts`).
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
  | "forbidden-require"
  | "forbidden-import-meta"
  | "forbidden-sql-template"
  | "forbidden-eval"
  | "forbidden-globalthis-write"
  | "forbidden-globalthis-alias"
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

export function validateManifest(
  rawManifest: unknown,
  opts: { allowExternalCapabilities?: boolean } = {},
): {
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
  if (m.tier === 1 || opts.allowExternalCapabilities) {
    const caps = new Set(m.requestedCapabilities ?? []);
    if (caps.has("image_generation") && !caps.has("private_files")) {
      failures.push({
        kind: "manifest-cap-missing",
        hint: "image_generation requires private_files for private results and references; request and approve both capabilities.",
      });
    }
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
  if (m.tier === 2 && !opts.allowExternalCapabilities) {
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

/** Same-package relative import: starts with `./`, never traverses up
 *  (`..` is rejected anywhere in the path), ends in `.js`. Only the
 *  release-signed dist path opts into this — a multi-file dist is
 *  legitimate for audited plugins, and the loader validates EVERY .js
 *  in the dist so the sibling file gets the same scrutiny. */
const SAME_PACKAGE_IMPORT_RE = /^\.\/(?!.*\.\.)[\w./-]+\.js$/;

/**
 * Walk the AST and collect failures. Called for both Tier 1 (defense
 * in depth at startup) and Tier 2 (gating activation).
 */
export function validateSource(opts: {
  filename: string;
  source: string;
  /** Release-signed dist only — permits `./sibling.js` imports within
   *  the plugin package. Runtime-authored source stays single-file:
   *  the Deno sandbox has nothing else on disk to resolve against. */
  allowRelativeImports?: boolean;
}): ValidationFailure[] {
  const { filename, source } = opts;
  const failures: ValidationFailure[] = [];

  let ast: unknown;
  try {
    const parsed = parseSync(filename, source, { sourceType: "module" });
    if (parsed.errors.length > 0) {
      return [
        {
          kind: "parse-error",
          hint: "Plugin source contains syntax errors; correct them before submission.",
        },
      ];
    }
    ast = parsed.program;
  } catch (e) {
    failures.push({
      kind: "parse-error",
      hint: `oxc-parser could not parse the source: ${(e as Error).message}`,
    });
    return failures;
  }

  let maxDepthExceeded = false;
  walk(
    ast,
    (node, parents) => {
      if (!node || typeof node !== "object") return;
      const type = (node as { type?: string }).type;
      if (!type) return;

      // ImportDeclaration — only @caelo-cms/plugin-sdk allowed.
      if (
        type === "ImportDeclaration" ||
        ((type === "ExportNamedDeclaration" || type === "ExportAllDeclaration") &&
          (node as { source?: unknown }).source)
      ) {
        const sourceVal = (node as { source?: { value?: unknown } }).source?.value;
        const relativeOk =
          opts.allowRelativeImports === true &&
          typeof sourceVal === "string" &&
          SAME_PACKAGE_IMPORT_RE.test(sourceVal);
        if (!relativeOk && (typeof sourceVal !== "string" || !ALLOWED_IMPORTS.has(sourceVal))) {
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

      // import.meta — exposes the module's host URL/path and, under the
      // host bundler, resolution helpers that reach the host filesystem.
      if (type === "MetaProperty") {
        failures.push({
          kind: "forbidden-import-meta",
          nodeType: type,
          location: locOf(node),
          hint: "import.meta is not allowed in plugin code.",
        });
        return;
      }

      // WithStatement — dynamic scope manipulation defeats static identifier analysis.
      if (type === "WithStatement") {
        failures.push({
          kind: "forbidden-eval",
          nodeType: type,
          location: locOf(node),
          hint: "with statements are not allowed in plugin code.",
        });
        return;
      }

      // ObjectPattern — destructuring `.constructor` (`const { constructor: F } = fn`)
      // or forbidden globals (`const { eval: e } = ...`) bypasses MemberExpression checks.
      if (type === "ObjectPattern") {
        const properties = (node as { properties?: unknown[] }).properties ?? [];
        for (const prop of properties) {
          if (!prop || typeof prop !== "object") continue;
          const propType = (prop as { type?: string }).type;
          if (propType === "RestElement") continue;
          const keyName = memberPropertyName({
            property: (prop as { key?: unknown }).key,
            computed: (prop as { computed?: boolean }).computed,
          });
          if (keyName === "constructor" || keyName === "eval" || keyName === "Function") {
            failures.push({
              kind: "forbidden-eval",
              nodeType: type,
              snippet: `{ ${keyName} }`,
              location: locOf(prop),
              hint: `Destructuring "${keyName}" is not allowed in plugin code.`,
            });
            return;
          }
          if (keyName === "Deno") {
            failures.push({
              kind: "forbidden-deno-access",
              nodeType: type,
              snippet: "{ Deno }",
              location: locOf(prop),
              hint: "Deno.* is not accessible to plugins. Use ctx.query / ctx.api / ctx.theme.",
            });
            return;
          }
          if (keyName === "require") {
            failures.push({
              kind: "forbidden-require",
              nodeType: type,
              snippet: "{ require }",
              location: locOf(prop),
              hint: 'require() is not allowed. Use static `import` from "@caelo-cms/plugin-sdk".',
            });
            return;
          }
          if (keyName === "fetch" || keyName === "XMLHttpRequest" || keyName === "WebSocket") {
            failures.push({
              kind: "forbidden-call",
              nodeType: type,
              snippet: `{ ${keyName} }`,
              location: locOf(prop),
              hint: `${keyName}() is not allowed. Use ctx.api / ctx.query for I/O.`,
            });
            return;
          }
          if (keyName !== null && GLOBAL_OBJECT_NAMES.has(keyName)) {
            failures.push({
              kind: "forbidden-globalthis-alias",
              nodeType: type,
              snippet: `{ ${keyName} }`,
              location: locOf(prop),
              hint: `${keyName} may only be used for direct member access (${keyName}.X); do not alias it or pass it around.`,
            });
            return;
          }
        }
      }

      // MemberExpression — check .constructor, computed globalThis[...], and globalThis/window/self forbidden properties.
      if (type === "MemberExpression") {
        const member = node as { object?: unknown; property?: unknown; computed?: boolean };
        const objName = identifierName(unwrapExpr(member.object));
        const propName = memberPropertyName(member);

        // Reading `.constructor` is ordinary (`value.constructor === Object`).
        // Calling it — or reaching `.constructor.constructor` — is the
        // function-constructor escape to eval.
        if (
          propName === "constructor" &&
          (isCalleePosition(node, parents) || isConstructorMember(unwrapExpr(member.object)))
        ) {
          failures.push({
            kind: "forbidden-eval",
            nodeType: type,
            snippet: ".constructor(...)",
            location: locOf(node),
            hint: "Calling a .constructor is not allowed in plugin code (it reaches the Function constructor). Call the class or factory you need directly.",
          });
          return;
        }

        if (objName === "globalThis" || objName === "window" || objName === "self") {
          if (member.computed && propName === null) {
            failures.push({
              kind: "forbidden-call",
              nodeType: type,
              snippet: `${objName}[...]`,
              location: locOf(node),
              hint: `Dynamic computed property access on ${objName} is not allowed.`,
            });
            return;
          }
          if (propName !== null && GLOBAL_OBJECT_NAMES.has(propName)) {
            failures.push({
              kind: "forbidden-globalthis-alias",
              nodeType: type,
              snippet: `${objName}.${propName}`,
              location: locOf(node),
              hint: `${objName}.${propName} is the global object again; reference globals directly.`,
            });
            return;
          }
          if (propName === "eval" || propName === "Function") {
            failures.push({
              kind: "forbidden-eval",
              nodeType: type,
              snippet: `${objName}.${propName}`,
              location: locOf(node),
              hint: `${objName}.${propName} is not allowed.`,
            });
            return;
          }
          if (propName === "Deno") {
            failures.push({
              kind: "forbidden-deno-access",
              nodeType: type,
              snippet: `${objName}.Deno`,
              location: locOf(node),
              hint: "Deno.* is not accessible to plugins. Use ctx.query / ctx.api / ctx.theme.",
            });
            return;
          }
          if (propName === "require") {
            failures.push({
              kind: "forbidden-require",
              nodeType: type,
              snippet: `${objName}.require`,
              location: locOf(node),
              hint: 'require() is not allowed. Use static `import` from "@caelo-cms/plugin-sdk".',
            });
            return;
          }
          if (propName === "fetch" || propName === "XMLHttpRequest" || propName === "WebSocket") {
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

      // CallExpression — fetch, XMLHttpRequest, eval, Function, dynamic import (legacy AST shape).
      if (type === "CallExpression") {
        const callee = unwrapExpr((node as { callee?: unknown }).callee);
        const calleeName = identifierName(callee);
        // require() — the bundle is built in the HOST process, before the
        // Deno sandbox exists, so a require of a host path would inline
        // that file's contents (secrets, service-account keys) into the
        // plugin bundle. `module.require` / `globalThis.require` alike.
        const requireProp =
          callee && (callee as { type?: string }).type === "MemberExpression"
            ? memberPropertyName(callee as { property?: unknown; computed?: boolean })
            : null;
        if (calleeName === "require" || requireProp === "require") {
          failures.push({
            kind: "forbidden-require",
            nodeType: type,
            snippet: "require",
            location: locOf(node),
            hint: 'require() is not allowed. Use static `import` from "@caelo-cms/plugin-sdk".',
          });
          return;
        }
        if (
          calleeName === "fetch" ||
          calleeName === "XMLHttpRequest" ||
          calleeName === "WebSocket"
        ) {
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
      }

      // NewExpression for Function — `new Function('...')` or `new globalThis.Function('...')`.
      if (type === "NewExpression") {
        const callee = unwrapExpr((node as { callee?: unknown }).callee);
        const calleeName = identifierName(callee);
        const memberProp =
          callee && (callee as { type?: string }).type === "MemberExpression"
            ? memberPropertyName(callee as { property?: unknown; computed?: boolean })
            : null;
        if (calleeName === "Function" || memberProp === "Function") {
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

      // eval / Function referenced as a value: `(0, eval)(…)`,
      // `const e = eval`, `[Function][0]`. Only a call reaches code
      // generation, but any reference can become one, so all fail —
      // except `x instanceof Function`, which cannot call it.
      if (type === "Identifier" && isReferencePosition(node, parents)) {
        const name = (node as { name?: string }).name;
        const parent = parents[parents.length - 1] as
          | { type?: string; operator?: string; right?: unknown; object?: unknown }
          | undefined;
        const isInstanceofRight =
          parent?.type === "BinaryExpression" &&
          parent.operator === "instanceof" &&
          parent.right === node;
        if (name === "eval" || (name === "Function" && !isInstanceofRight)) {
          failures.push({
            kind: "forbidden-eval",
            nodeType: type,
            snippet: name,
            location: locOf(node),
            hint: `${name} is not allowed in plugin code, called or referenced.`,
          });
          return;
        }
        // The global object as a value defeats every member rule above
        // (`const g = globalThis; g.eval(…)`, `Reflect.get(globalThis, k)`).
        // Direct member access (`globalThis.Math`) and `typeof` stay fine.
        if (name !== undefined && GLOBAL_OBJECT_NAMES.has(name)) {
          const memberObject = parent?.type === "MemberExpression" && parent.object === node;
          const typeofOperand = parent?.type === "UnaryExpression" && parent.operator === "typeof";
          if (!memberObject && !typeofOperand && !isBindingPosition(node, parents)) {
            failures.push({
              kind: "forbidden-globalthis-alias",
              nodeType: type,
              snippet: name,
              location: locOf(node),
              hint: `${name} may only be used for direct member access (${name}.X); do not alias it or pass it around.`,
            });
            return;
          }
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
        const left = unwrapExpr((node as { left?: unknown }).left);
        if (left && (left as { type?: string }).type === "MemberExpression") {
          const objName = identifierName(unwrapExpr((left as { object?: unknown }).object));
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
    },
    () => {
      if (!maxDepthExceeded) {
        maxDepthExceeded = true;
        failures.push({
          kind: "parse-error",
          hint: `Plugin AST nesting depth exceeded maximum limit (${MAX_DEPTH}). Simplify deeply nested expressions.`,
        });
      }
    },
  );

  return failures;
}

// ---------------------------------------------------------------------------
// Combined entry point — manifest + source.
// ---------------------------------------------------------------------------

export function validatePlugin(opts: {
  manifest: unknown;
  source: string;
  filename?: string;
  /** Host installation review only; this never grants runtime permissions. */
  allowExternalCapabilities?: boolean;
}): ValidationResult {
  const { failures: manifestFailures, manifest } = validateManifest(opts.manifest, {
    allowExternalCapabilities: opts.allowExternalCapabilities,
  });
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

function walk(node: unknown, visit: Visitor, onMaxDepthExceeded?: () => void): void {
  if (!node || typeof node !== "object") return;
  const visited = new WeakSet<object>();
  walkInner(node, visit, [], visited, 0, onMaxDepthExceeded);
}

function walkInner(
  node: unknown,
  visit: Visitor,
  parents: unknown[],
  visited: WeakSet<object>,
  depth: number,
  onMaxDepthExceeded?: () => void,
): void {
  if (!node || typeof node !== "object") return;
  if (depth > MAX_DEPTH) {
    onMaxDepthExceeded?.();
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walkInner(child, visit, parents, visited, depth, onMaxDepthExceeded);
    return;
  }
  if (visited.has(node as object)) return;
  visited.add(node as object);
  visit(node, parents);
  const nextParents = [...parents, node];
  for (const key of CHILD_KEYS) {
    const child = (node as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      walkInner(child, visit, nextParents, visited, depth + 1, onMaxDepthExceeded);
    }
  }
}

function unwrapExpr(n: unknown): unknown {
  let cur = n;
  while (cur && typeof cur === "object") {
    const t = (cur as { type?: string }).type;
    if (t !== undefined && TRANSPARENT_WRAPPERS.has(t)) {
      cur = (cur as { expression?: unknown }).expression;
    } else if (t === "SequenceExpression") {
      // `(0, eval)` evaluates to its last element.
      const exprs = (cur as { expressions?: unknown[] }).expressions ?? [];
      cur = exprs[exprs.length - 1];
    } else {
      break;
    }
  }
  return cur;
}

function memberPropertyName(member: { property?: unknown; computed?: boolean }): string | null {
  const prop = unwrapExpr(member.property);
  if (!prop || typeof prop !== "object") return null;
  if (!member.computed) {
    return identifierName(prop);
  }
  return foldString(prop, 0);
}

/**
 * Constant-fold a computed key built only from literals: string/number
 * literals, templates whose parts fold, and `+` concatenations. So
 * `f["con" + "structor"]` and `` g[`ev${"al"}`] `` are judged like
 * `f.constructor` / `g.eval`. Anything else (an identifier, a call) is
 * not foldable and yields null.
 */
function foldString(n: unknown, depth: number): string | null {
  const node = unwrapExpr(n);
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) return null;
  const t = (node as { type?: string }).type;
  if (t === "Literal" || t === "StringLiteral" || t === "NumericLiteral") {
    const v = (node as { value?: unknown }).value;
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    return null;
  }
  if (t === "TemplateLiteral") {
    const exprs = (node as { expressions?: unknown[] }).expressions ?? [];
    const quasis =
      (node as { quasis?: Array<{ value?: { cooked?: string | null } }> }).quasis ?? [];
    let out = "";
    for (let i = 0; i < quasis.length; i++) {
      const cooked = quasis[i]?.value?.cooked;
      if (typeof cooked !== "string") return null;
      out += cooked;
      if (i < exprs.length) {
        const part = foldString(exprs[i], depth + 1);
        if (part === null) return null;
        out += part;
      }
    }
    return out;
  }
  if (t === "BinaryExpression" && (node as { operator?: string }).operator === "+") {
    const left = foldString((node as { left?: unknown }).left, depth + 1);
    if (left === null) return null;
    const right = foldString((node as { right?: unknown }).right, depth + 1);
    return right === null ? null : left + right;
  }
  return null;
}

/** Names that evaluate to the global object in the Deno child. */
const GLOBAL_OBJECT_NAMES: ReadonlySet<string> = new Set(["globalThis", "window", "self"]);

/** Wrapper nodes that pass their inner expression's value through unchanged. */
const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
]);

/**
 * Whether `node`'s value is what gets called: the callee of a call or
 * `new`, or the tag of a tagged template — looking through parentheses,
 * optional chains, TS casts and the last element of a sequence.
 */
function isCalleePosition(node: unknown, parents: unknown[]): boolean {
  let child = node;
  for (let i = parents.length - 1; i >= 0; i--) {
    const parent = parents[i] as {
      type?: string;
      callee?: unknown;
      tag?: unknown;
      expressions?: unknown[];
    };
    const t = parent.type ?? "";
    if (TRANSPARENT_WRAPPERS.has(t)) {
      child = parent;
      continue;
    }
    if (t === "SequenceExpression") {
      const exprs = parent.expressions ?? [];
      if (exprs[exprs.length - 1] !== child) return false;
      child = parent;
      continue;
    }
    if (t === "CallExpression" || t === "NewExpression") return parent.callee === child;
    if (t === "TaggedTemplateExpression") return parent.tag === child;
    return false;
  }
  return false;
}

/** `x.constructor` (or a folded computed spelling of it). */
function isConstructorMember(n: unknown): boolean {
  if (!n || typeof n !== "object" || (n as { type?: string }).type !== "MemberExpression") {
    return false;
  }
  return memberPropertyName(n as { property?: unknown; computed?: boolean }) === "constructor";
}

/**
 * Whether an Identifier node reads a variable, as opposed to naming a
 * property, a key, a label, or a TypeScript type position.
 */
function isReferencePosition(node: unknown, parents: unknown[]): boolean {
  const parent = parents[parents.length - 1] as
    | { type?: string; property?: unknown; key?: unknown; label?: unknown; computed?: boolean }
    | undefined;
  if (!parent) return true;
  const t = parent.type ?? "";
  if (t.startsWith("TS")) return false;
  if (t === "MemberExpression" && parent.property === node && !parent.computed) return false;
  if (
    (t === "Property" ||
      t === "MethodDefinition" ||
      t === "PropertyDefinition" ||
      t === "AccessorProperty") &&
    parent.key === node &&
    !parent.computed
  ) {
    return false;
  }
  if (
    (t === "LabeledStatement" || t === "BreakStatement" || t === "ContinueStatement") &&
    parent.label === node
  ) {
    return false;
  }
  return true;
}

/**
 * Whether an Identifier node declares a binding rather than reading one:
 * a variable declarator's id, a function/catch parameter, or a default-
 * value pattern's target. A local `const self = this` is not the global.
 */
function isBindingPosition(node: unknown, parents: unknown[]): boolean {
  const parent = parents[parents.length - 1] as
    | { type?: string; id?: unknown; params?: unknown[]; param?: unknown; left?: unknown }
    | undefined;
  if (!parent) return false;
  const t = parent.type ?? "";
  if (t === "VariableDeclarator" && parent.id === node) return true;
  if (t === "AssignmentPattern" && parent.left === node) return true;
  if (t === "CatchClause" && parent.param === node) return true;
  if (Array.isArray(parent.params) && parent.params.includes(node)) return true;
  if (
    (t === "FunctionDeclaration" || t === "FunctionExpression" || t === "ClassDeclaration") &&
    parent.id === node
  ) {
    return true;
  }
  return false;
}

function identifierName(n: unknown): string | null {
  const unwrapped = unwrapExpr(n);
  if (!unwrapped || typeof unwrapped !== "object") return null;
  const t = (unwrapped as { type?: string }).type;
  if (t === "Identifier") return (unwrapped as { name?: string }).name ?? null;
  return null;
}

function locOf(n: unknown): { line: number; column: number } | undefined {
  const loc = (n as { loc?: { start?: { line?: number; column?: number } } }).loc;
  if (!loc?.start) return undefined;
  return { line: loc.start.line ?? 0, column: loc.start.column ?? 0 };
}
