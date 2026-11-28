// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: the field model every import kind shares, the core kinds
 * (redirects) and the kinds plugins declare (comments, rating totals). A
 * kind lists its fields; every row, from a file or from a tool call, is
 * checked against them here before any kind-specific code sees it.
 * Docs: docs/data-imports.md.
 *
 * Rows come from another system, so a value may arrive as a string even
 * when it is a number: each field type says how a string reads. Nothing is
 * guessed. A value that does not read cleanly is a problem of its row and
 * never turns into a default (CLAUDE.md §2, no fallbacks); an empty value
 * is absent.
 */

import { z } from "zod";

/** How a field's value reads. */
export const IMPORT_FIELD_TYPES = [
  "string",
  "text",
  "int",
  "number",
  "bool",
  "datetime",
  "enum",
  "pageRef",
  "path",
  "url",
] as const;
export type ImportFieldType = (typeof IMPORT_FIELD_TYPES)[number];

/**
 * Fields every kind has. `sourceKey` is the row's stable id in the system
 * it comes from (`wp:comment:1234`); `parentKey` names another row's
 * `sourceKey` on kinds whose rows have parents.
 */
export const IMPORT_RESERVED_FIELDS = ["sourceKey", "parentKey"] as const;

/** Longest `sourceKey` / `parentKey`. */
export const MAX_SOURCE_KEY_LENGTH = 200;

/** Longest `pageRef`, `path` or `url` value. */
const MAX_REF_LENGTH = 2000;

const FIELD_NAME = /^[a-z][a-zA-Z0-9]{0,47}$/;

/** One field of an import kind. */
export const importFieldDeclaration = z
  .object({
    type: z.enum(IMPORT_FIELD_TYPES),
    /** What the value is, in the source system's terms when that helps ("Plain text, paragraphs separated by a blank line."). */
    description: z.string().min(1).max(300).optional(),
    /** A row may leave it empty. */
    optional: z.boolean().optional(),
    /** Longest value of a `string` or `text` field (required for those). */
    maxLength: z.number().int().min(1).max(100_000).optional(),
    /** Bounds of an `int` or `number` field. */
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    /** The allowed values of an `enum` field. */
    values: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    const lengthTyped = f.type === "string" || f.type === "text";
    if (lengthTyped !== (f.maxLength !== undefined))
      ctx.addIssue({
        code: "custom",
        path: ["maxLength"],
        message: "`maxLength` is set exactly on `string` and `text` fields",
      });
    const numeric = f.type === "int" || f.type === "number";
    if (!numeric && (f.min !== undefined || f.max !== undefined))
      ctx.addIssue({
        code: "custom",
        path: ["min"],
        message: "`min` and `max` apply only to `int` and `number` fields",
      });
    if (f.min !== undefined && f.max !== undefined && f.min > f.max)
      ctx.addIssue({ code: "custom", path: ["min"], message: "`min` is above `max`" });
    if ((f.type === "enum") !== (f.values !== undefined))
      ctx.addIssue({
        code: "custom",
        path: ["values"],
        message: "`values` is set exactly on `enum` fields",
      });
    if (f.values && new Set(f.values).size !== f.values.length)
      ctx.addIssue({ code: "custom", path: ["values"], message: "a value is listed twice" });
  });
export type ImportFieldDeclaration = z.infer<typeof importFieldDeclaration>;

/** The fields of a kind, by name (camelCase, never a reserved name). */
export const importFieldMap = z
  .record(z.string(), importFieldDeclaration)
  .superRefine((fields, ctx) => {
    const names = Object.keys(fields);
    if (names.length === 0)
      ctx.addIssue({ code: "custom", message: "a kind has at least one field" });
    if (names.length > 40)
      ctx.addIssue({ code: "custom", message: "a kind has at most 40 fields" });
    // A row belongs to at most one page: the one its pageRef names.
    if (Object.values(fields).filter((f) => f.type === "pageRef").length > 1)
      ctx.addIssue({ code: "custom", message: "a kind has at most one `pageRef` field" });
    for (const name of names) {
      if (!FIELD_NAME.test(name))
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `field name "${name}" must be camelCase letters and digits (e.g. authorName)`,
        });
      if ((IMPORT_RESERVED_FIELDS as readonly string[]).includes(name))
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `"${name}" is provided by the import itself; do not declare it`,
        });
    }
  });
export type ImportFieldMap = z.infer<typeof importFieldMap>;

/** A checked value: strings for text-like and reference types, numbers, booleans. */
export type ImportValue = string | number | boolean;

/** A row that passed its field checks. Absent optional fields are `null`. */
export interface CheckedImportRow {
  readonly sourceKey: string;
  readonly parentKey: string | null;
  readonly values: Readonly<Record<string, ImportValue | null>>;
}

/** What is wrong with one field of one row. */
export interface ImportFieldProblem {
  readonly reason: "missing-value" | "invalid-value";
  readonly field: string;
  readonly detail: string;
}

export type CheckImportRowResult =
  | { readonly ok: true; readonly row: CheckedImportRow }
  | {
      readonly ok: false;
      readonly sourceKey: string | null;
      readonly problems: ImportFieldProblem[];
    };

/** An empty value: absent, null, or a string of only whitespace. */
function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

// ISO 8601 with a date, a time and an explicit zone. A local time without
// a zone would read as the importing server's zone, which is a guess.
const DATETIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/** Reads a key (`sourceKey` / `parentKey`): a string or an integer. */
function readKey(raw: unknown): string | { error: string } {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  if (typeof raw !== "string") return { error: "must be a string or an integer" };
  if (raw.length > MAX_SOURCE_KEY_LENGTH)
    return { error: `is longer than ${MAX_SOURCE_KEY_LENGTH} characters` };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { error: "contains a control character" };
  return raw;
}

/** Reads one value by its declaration; a string message on failure. */
function readValue(decl: ImportFieldDeclaration, raw: unknown): ImportValue | { error: string } {
  switch (decl.type) {
    case "string":
    case "text": {
      if (typeof raw !== "string" && typeof raw !== "number") return { error: "must be text" };
      const s = String(raw).replace(/\r\n?/g, "\n");
      if (decl.type === "string" && s.includes("\n"))
        return { error: "must be one line (a `text` field takes line breaks)" };
      if (s.length > (decl.maxLength ?? 0))
        return { error: `is ${s.length} characters, at most ${decl.maxLength} allowed` };
      return s;
    }
    case "int": {
      const n =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && /^-?\d+$/.test(raw.trim())
            ? Number(raw.trim())
            : Number.NaN;
      if (!Number.isSafeInteger(n)) return { error: "must be a whole number" };
      return inBounds(decl, n);
    }
    case "number": {
      const n =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw.trim())
            ? Number(raw.trim())
            : Number.NaN;
      if (!Number.isFinite(n))
        return { error: "must be a number with a dot as decimal separator (e.g. 4.5)" };
      return inBounds(decl, n);
    }
    case "bool": {
      if (typeof raw === "boolean") return raw;
      const s =
        typeof raw === "string" || typeof raw === "number" ? String(raw).trim().toLowerCase() : "";
      if (s === "true" || s === "1") return true;
      if (s === "false" || s === "0") return false;
      return { error: "must be true, false, 1 or 0" };
    }
    case "datetime": {
      if (typeof raw !== "string" || !DATETIME.test(raw.trim()))
        return {
          error:
            "must be a date and time with a time zone, e.g. 2019-05-04T10:15:00Z or 2019-05-04 12:15:00+02:00",
        };
      const text = raw.trim();
      const [y, m, d] = text.slice(0, 10).split("-").map(Number) as [number, number, number];
      // Date.parse rolls 2019-02-31 over to March 3rd; a date that does not
      // exist is a problem of the row, not a nearby day.
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const t = Date.parse(text.replace(" ", "T"));
      if (m < 1 || m > 12 || d < 1 || d > daysInMonth || Number.isNaN(t))
        return { error: "is not a real date" };
      return new Date(t).toISOString();
    }
    case "enum": {
      const s = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
      if (!decl.values?.includes(s)) return { error: `must be one of ${decl.values?.join(", ")}` };
      return s;
    }
    case "pageRef": {
      if (typeof raw !== "string") return { error: "must be a page id, a path or a URL" };
      const s = raw.trim();
      if (s.length > MAX_REF_LENGTH)
        return { error: `is longer than ${MAX_REF_LENGTH} characters` };
      return s;
    }
    case "path": {
      if (typeof raw !== "string") return { error: "must be a path" };
      const s = raw.trim();
      if (!s.startsWith("/") || s.startsWith("//") || /\s/.test(s))
        return { error: "must be a path on the site starting with one '/', without spaces" };
      if (s.length > MAX_REF_LENGTH)
        return { error: `is longer than ${MAX_REF_LENGTH} characters` };
      return s;
    }
    case "url": {
      if (typeof raw !== "string") return { error: "must be a URL" };
      const s = raw.trim();
      let u: URL;
      try {
        u = new URL(s);
      } catch {
        return { error: "must be an absolute http(s) URL" };
      }
      if (u.protocol !== "https:" && u.protocol !== "http:")
        return { error: "must be an absolute http(s) URL" };
      if (s.length > MAX_REF_LENGTH)
        return { error: `is longer than ${MAX_REF_LENGTH} characters` };
      return s;
    }
  }
}

function inBounds(decl: ImportFieldDeclaration, n: number): number | { error: string } {
  if (decl.min !== undefined && n < decl.min) return { error: `is below ${decl.min}` };
  if (decl.max !== undefined && n > decl.max) return { error: `is above ${decl.max}` };
  return n;
}

/**
 * The names in `keys` that are neither a field of the kind nor a reserved
 * field the kind takes. A call with such a name is refused as a whole: it
 * is how a column that Caelo does not store (an e-mail address, an IP)
 * would otherwise slip into an import unnoticed.
 */
export function unknownImportFields(
  fields: ImportFieldMap,
  parents: boolean,
  keys: Iterable<string>,
): string[] {
  const allowed = new Set([...Object.keys(fields), "sourceKey", ...(parents ? ["parentKey"] : [])]);
  return [...new Set(keys)].filter((k) => !allowed.has(k));
}

/**
 * Checks one row against a kind's fields. Unknown fields are the caller's
 * concern ({@link unknownImportFields}); this reads only declared ones.
 */
export function checkImportRow(
  fields: ImportFieldMap,
  parents: boolean,
  raw: Readonly<Record<string, unknown>>,
): CheckImportRowResult {
  const problems: ImportFieldProblem[] = [];
  let sourceKey: string | null = null;
  if (isEmpty(raw.sourceKey)) {
    problems.push({
      reason: "missing-value",
      field: "sourceKey",
      detail: "every row needs its id in the source system",
    });
  } else {
    const k = readKey(raw.sourceKey);
    if (typeof k === "string") sourceKey = k;
    else
      problems.push({
        reason: "invalid-value",
        field: "sourceKey",
        detail: `sourceKey ${k.error}`,
      });
  }
  let parentKey: string | null = null;
  if (parents && !isEmpty(raw.parentKey)) {
    const k = readKey(raw.parentKey);
    if (typeof k === "string") parentKey = k;
    else
      problems.push({
        reason: "invalid-value",
        field: "parentKey",
        detail: `parentKey ${k.error}`,
      });
  }
  if (sourceKey !== null && parentKey === sourceKey)
    problems.push({
      reason: "invalid-value",
      field: "parentKey",
      detail: "a row cannot be its own parent",
    });
  const values: Record<string, ImportValue | null> = {};
  for (const [name, decl] of Object.entries(fields)) {
    const v = raw[name];
    if (isEmpty(v)) {
      if (!decl.optional)
        problems.push({ reason: "missing-value", field: name, detail: `${name} is required` });
      values[name] = null;
      continue;
    }
    const read = readValue(decl, v);
    if (typeof read === "object") {
      problems.push({ reason: "invalid-value", field: name, detail: `${name} ${read.error}` });
      values[name] = null;
    } else {
      values[name] = read;
    }
  }
  if (problems.length > 0 || sourceKey === null) return { ok: false, sourceKey, problems };
  return { ok: true, row: { sourceKey, parentKey, values } };
}
