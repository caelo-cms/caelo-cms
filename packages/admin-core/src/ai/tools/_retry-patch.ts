// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1275 — the patch `retry_tool_call` applies to a kept call's
 * arguments. Pure: no I/O, the kept arguments are never mutated.
 *
 * Paths are segment arrays in Zod `issue.path` form — the same form as
 * the `errors[].path` of the failure (#1277) — so the AI copies the path
 * an error names into the patch:
 *
 *   - `set`     `{path, value}`: write `value` at `path`. Missing object
 *               keys on the way are created; an array index must exist or
 *               be the array's length (append).
 *   - `remove`  `path`: delete the key, or splice the array entry out.
 *   - `replace` `{path, old, new}`: exact string replacement inside the
 *               string at `path`; `old` must occur exactly once, so a
 *               markup fix in a large `html` costs a few tokens.
 *
 * Operations apply in that order (every `set`, every `remove`, every
 * `replace`), each in array order. Every problem is reported at once,
 * at its path inside the patch (`["set", 1, "path"]`).
 */

import type { ErrorDetail, ErrorPathSegment } from "@caelo-cms/query-api";
import { formatErrorPath } from "@caelo-cms/query-api";

/** The patch half of the `retry_tool_call` input. */
export interface RetryPatch {
  readonly set?: readonly { readonly path: readonly ErrorPathSegment[]; readonly value: unknown }[];
  readonly remove?: readonly (readonly ErrorPathSegment[])[];
  readonly replace?: readonly {
    readonly path: readonly ErrorPathSegment[];
    readonly old: string;
    readonly new: string;
  }[];
}

/** Keys a patch may never write: they would reach the object prototype. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type Container = Record<string, unknown> | unknown[];

function isContainer(v: unknown): v is Container {
  return typeof v === "object" && v !== null;
}

/**
 * Walk to the parent of `path`'s last segment. `create` makes missing
 * object keys on the way (for `set`); otherwise a missing step is an error.
 */
function parentOf(
  root: Container,
  path: readonly ErrorPathSegment[],
  create: boolean,
): { ok: true; parent: Container; key: ErrorPathSegment } | { ok: false; message: string } {
  let cur: Container = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const seg = path[i] as ErrorPathSegment;
    const next: unknown = Array.isArray(cur)
      ? typeof seg === "number"
        ? cur[seg]
        : undefined
      : (cur as Record<string, unknown>)[String(seg)];
    if (isContainer(next)) {
      cur = next;
      continue;
    }
    const at = formatErrorPath(path.slice(0, i + 1));
    if (next !== undefined) return { ok: false, message: `\`${at}\` is not an object or array` };
    if (!create || Array.isArray(cur) || typeof seg === "number") {
      return { ok: false, message: `\`${at}\` does not exist in the kept call` };
    }
    const made: Record<string, unknown> = {};
    (cur as Record<string, unknown>)[seg] = made;
    cur = made;
  }
  return { ok: true, parent: cur, key: path[path.length - 1] as ErrorPathSegment };
}

/** A path's shape problem (empty, a forbidden key), or null. */
function pathProblem(path: readonly ErrorPathSegment[]): string | null {
  if (path.length === 0)
    return "a path names at least one segment (the whole call cannot be replaced)";
  const bad = path.find((s) => typeof s === "string" && FORBIDDEN_KEYS.has(s));
  return bad === undefined ? null : `\`${String(bad)}\` cannot be patched`;
}

function setAt(root: Container, path: readonly ErrorPathSegment[], value: unknown): string | null {
  const p = parentOf(root, path, true);
  if (!p.ok) return p.message;
  if (Array.isArray(p.parent)) {
    if (typeof p.key !== "number" || p.key < 0 || p.key > p.parent.length) {
      return `\`${formatErrorPath(path)}\`: an array index must be 0..${p.parent.length} (${p.parent.length} appends)`;
    }
    p.parent[p.key] = value;
    return null;
  }
  (p.parent as Record<string, unknown>)[String(p.key)] = value;
  return null;
}

function removeAt(root: Container, path: readonly ErrorPathSegment[]): string | null {
  const p = parentOf(root, path, false);
  if (!p.ok) return p.message;
  if (Array.isArray(p.parent)) {
    if (typeof p.key !== "number" || p.key < 0 || p.key >= p.parent.length) {
      return `\`${formatErrorPath(path)}\` does not exist in the kept call`;
    }
    p.parent.splice(p.key, 1);
    return null;
  }
  const obj = p.parent as Record<string, unknown>;
  if (!Object.hasOwn(obj, String(p.key))) {
    return `\`${formatErrorPath(path)}\` does not exist in the kept call`;
  }
  delete obj[String(p.key)];
  return null;
}

function replaceAt(
  root: Container,
  path: readonly ErrorPathSegment[],
  oldText: string,
  newText: string,
): string | null {
  const p = parentOf(root, path, false);
  if (!p.ok) return p.message;
  const holder = p.parent as Record<string | number, unknown>;
  const current = holder[p.key as string | number];
  if (typeof current !== "string") {
    return `\`${formatErrorPath(path)}\` is not a string (replace works inside one string value; use set)`;
  }
  if (oldText.length === 0) return "`old` is empty — name the exact text to replace";
  const first = current.indexOf(oldText);
  if (first === -1) {
    return `\`old\` does not occur in \`${formatErrorPath(path)}\` — copy it exactly from the kept call`;
  }
  if (current.indexOf(oldText, first + 1) !== -1) {
    return `\`old\` occurs more than once in \`${formatErrorPath(path)}\` — include more surrounding text so it matches exactly once`;
  }
  holder[p.key as string | number] =
    `${current.slice(0, first)}${newText}${current.slice(first + oldText.length)}`;
  return null;
}

/**
 * Apply `patch` to a copy of `args`.
 *
 * @returns the patched arguments, or every problem with its path inside
 *   the patch (nothing is applied then).
 */
export function applyRetryPatch(
  args: Record<string, unknown>,
  patch: RetryPatch,
): { ok: true; args: Record<string, unknown> } | { ok: false; errors: ErrorDetail[] } {
  const out = structuredClone(args);
  const errors: ErrorDetail[] = [];
  const run = (
    at: ErrorPathSegment[],
    path: readonly ErrorPathSegment[],
    apply: () => string | null,
  ) => {
    const message = pathProblem(path) ?? apply();
    if (message) errors.push({ path: at, message });
  };
  (patch.set ?? []).forEach((op, i) => {
    run(["set", i, "path"], op.path, () => setAt(out, op.path, structuredClone(op.value)));
  });
  (patch.remove ?? []).forEach((path, i) => {
    run(["remove", i], path, () => removeAt(out, path));
  });
  (patch.replace ?? []).forEach((op, i) => {
    run(["replace", i, "path"], op.path, () => replaceAt(out, op.path, op.old, op.new));
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, args: out };
}
