// SPDX-License-Identifier: MPL-2.0

/**
 * The field system shared by list types (entry fields) and page types
 * (page properties) — epic #1107, `docs/lists.md` §2.
 *
 * A list imposes no shape of its own: no entry must have a label or a
 * link. The list type declares fields once, and every stored value is
 * checked against that declaration at write time. One set of field types
 * keeps list entries, page properties and future definitions speaking the
 * same language, so the editor generates every form from the same code
 * and the template engine renders every value the same way.
 *
 * `ext` carries attributes a plugin declared for fields (translation is
 * the canonical case). Core stores and validates them against the
 * plugin's schema but never interprets them — core has no locale concept
 * (epic #380).
 */

import { z } from "zod";

/** Every field type a definition may declare. */
export const LIST_FIELD_TYPES = [
  "text",
  "richtext",
  "link",
  "media",
  "select",
  "boolean",
  "number",
  "date",
  "icon",
  "module",
  "term",
] as const;
export type ListFieldType = (typeof LIST_FIELD_TYPES)[number];

/**
 * Names the template engine binds itself inside a list entry, so a field
 * or children list may not take them. Prefixes `is_`, `has_`, `count_`
 * are reserved as a family (`is_<node>`, `has_<children>`,
 * `count_<children>`).
 */
export const LIST_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "id",
  "node",
  "index",
  "depth",
  "first",
  "last",
  "items",
  "page",
  "site_text",
  "recurse",
]);
/** Name prefixes reserved as a family (see {@link LIST_RESERVED_NAMES}). */
export const LIST_RESERVED_PREFIXES = ["is_", "has_", "count_"] as const;

/**
 * The reserved names as one clause for an error (#1277: the tool
 * description no longer lists them, so the refusal does).
 */
export const LIST_RESERVED_NAMES_CLAUSE = `reserved: ${[...LIST_RESERVED_NAMES].join(", ")}, ${LIST_RESERVED_PREFIXES.map((p) => `${p}*`).join(", ")}`;

/** True when `name` is taken by the engine (see {@link LIST_RESERVED_NAMES}). */
export function isReservedListName(name: string): boolean {
  return LIST_RESERVED_NAMES.has(name) || LIST_RESERVED_PREFIXES.some((p) => name.startsWith(p));
}

export const listNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "must be snake_case (lowercase letters, digits, underscores)");

const fieldLabel = z.string().min(1).max(128);

/** Plugin-declared attributes keyed by plugin slug; validated by the host. */
export const fieldExtSchema = z.record(z.string().regex(/^[a-z0-9-]+$/), z.unknown());

const base = {
  name: listNameSchema,
  label: fieldLabel,
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  ext: fieldExtSchema.optional(),
};

const textField = z
  .object({
    ...base,
    type: z.literal("text"),
    maxLength: z.number().int().min(1).max(2000).optional(),
  })
  .strict();
const richtextField = z
  .object({
    ...base,
    type: z.literal("richtext"),
    maxLength: z.number().int().min(1).max(20000).optional(),
  })
  .strict();
const linkField = z.object({ ...base, type: z.literal("link") }).strict();
const mediaField = z.object({ ...base, type: z.literal("media") }).strict();
const selectField = z
  .object({
    ...base,
    type: z.literal("select"),
    options: z.array(listNameSchema).min(1).max(64),
  })
  .strict();
const booleanField = z.object({ ...base, type: z.literal("boolean") }).strict();
const numberField = z
  .object({
    ...base,
    type: z.literal("number"),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();
const dateField = z.object({ ...base, type: z.literal("date") }).strict();
const iconField = z.object({ ...base, type: z.literal("icon") }).strict();
const moduleField = z
  .object({
    ...base,
    type: z.literal("module"),
    /** Stable module `type`s that may fill the slot; absent = any module. */
    accepts: z
      .array(z.string().regex(/^[a-z0-9-]+$/))
      .max(32)
      .optional(),
  })
  .strict();
const termField = z
  .object({
    ...base,
    type: z.literal("term"),
    /** Slug of the vocabulary list the terms come from. */
    list: z.string().regex(/^[a-z0-9-]+$/),
    multiple: z.boolean().optional(),
  })
  .strict();

/** One field declaration. See `docs/lists.md` §2 for the value shapes. */
export const fieldDefSchema = z.discriminatedUnion("type", [
  textField,
  richtextField,
  linkField,
  mediaField,
  selectField,
  booleanField,
  numberField,
  dateField,
  iconField,
  moduleField,
  termField,
]);
export type FieldDef = z.infer<typeof fieldDefSchema>;

/** Stored value of a `link` field. `href` may be an internal reference. */
export const linkValueSchema = z
  .object({
    href: z.string().min(1).max(2000),
    target: z.enum(["_self", "_blank"]).optional(),
  })
  .strict();
export type LinkValue = z.infer<typeof linkValueSchema>;

/** Stored value of a `module` field — the same ref shape as module fields. */
export const embeddedModuleValueSchema = z
  .object({ moduleId: z.string().uuid(), contentInstanceId: z.string().uuid() })
  .strict();

const MEDIA_REF_RE = /^caelo:media\/[0-9a-f-]{36}(?:\/[a-z0-9-]+)?$/;
/** `caelo:term/<listId>/<itemId>` */
export const TERM_REF_RE = /^caelo:term\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ICON_RE = /^[a-z0-9-]{1,64}$/;

const DEFAULT_TEXT_MAX = 500;
const DEFAULT_RICHTEXT_MAX = 5000;

/** One problem found while checking a definition or a value. */
export interface ListIssue {
  /** Where the problem is, e.g. `items[2].values.label` or `nodes.entry.fields[0]`. */
  readonly path: string;
  /** What is wrong and what to do about it, written for the AI caller. */
  readonly message: string;
}

/**
 * Validate one stored value against its field. Returns the issues found
 * (empty = valid). `undefined` is "not set" and only an issue when the
 * field is required.
 */
export function validateFieldValue(field: FieldDef, value: unknown, path: string): ListIssue[] {
  if (value === undefined || value === null) {
    return field.required
      ? [{ path, message: `"${field.name}" is required (${field.type}) — set a value.` }]
      : [];
  }
  // #1265 — for an object-shaped value, say WHAT is wrong in it (the Zod
  // issues) instead of "got object", which names nothing to fix.
  const bad = (
    expected: string,
    error?: z.ZodError,
    keyHints?: Readonly<Record<string, string>>,
  ): ListIssue[] => [
    {
      path,
      message:
        error !== undefined && isPlainObject(value)
          ? `"${field.name}" must be ${expected} — ${describeObjectIssues(error, value, keyHints)}.`
          : `"${field.name}" must be ${expected}, got ${describe(value)}.`,
    },
  ];
  switch (field.type) {
    case "text":
    case "richtext": {
      if (typeof value !== "string") return bad("a string");
      const max =
        field.maxLength ?? (field.type === "text" ? DEFAULT_TEXT_MAX : DEFAULT_RICHTEXT_MAX);
      if (value.length > max) return bad(`at most ${max} characters`);
      if (field.required && value.trim().length === 0) return bad("non-empty text");
      return [];
    }
    case "link": {
      const r = linkValueSchema.safeParse(value);
      return r.success
        ? []
        : bad('{ href, target? } (href like "/about" or "https://…")', r.error, LINK_KEY_HINTS);
    }
    case "media":
      return typeof value === "string" && MEDIA_REF_RE.test(value)
        ? []
        : bad("a media reference (caelo:media/<id>) — pick an asset from find_media");
    case "select":
      return typeof value === "string" && field.options.includes(value)
        ? []
        : bad(`one of ${field.options.map((o) => `"${o}"`).join(", ")}`);
    case "boolean":
      return typeof value === "boolean" ? [] : bad("true or false");
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return bad("a number");
      if (field.min !== undefined && value < field.min) return bad(`≥ ${field.min}`);
      if (field.max !== undefined && value > field.max) return bad(`≤ ${field.max}`);
      return [];
    }
    case "date":
      return typeof value === "string" &&
        ISO_DATE_RE.test(value) &&
        !Number.isNaN(Date.parse(value))
        ? []
        : bad("an ISO date YYYY-MM-DD");
    case "icon":
      return typeof value === "string" && ICON_RE.test(value) ? [] : bad("an icon name");
    case "module": {
      const r = embeddedModuleValueSchema.safeParse(value);
      return r.success ? [] : bad("{ moduleId, contentInstanceId }", r.error);
    }
    case "term": {
      if (
        !Array.isArray(value) ||
        value.some((v) => typeof v !== "string" || !TERM_REF_RE.test(v))
      ) {
        return bad("an array of term references (caelo:term/<listId>/<itemId>)");
      }
      if (!field.multiple && value.length > 1) return bad("at most one term (multiple is off)");
      if (field.required && value.length === 0) return bad("at least one term");
      return [];
    }
  }
}

/** Checks on one field declaration that Zod cannot express. */
export function checkFieldDef(field: FieldDef, path: string): ListIssue[] {
  const issues: ListIssue[] = [];
  if (isReservedListName(field.name)) {
    issues.push({
      path,
      message: `field name "${field.name}" is reserved by the template engine (${LIST_RESERVED_NAMES_CLAUSE}) — pick another name.`,
    });
  }
  if (field.default !== undefined) {
    for (const i of validateFieldValue(
      { ...field, required: false },
      field.default,
      `${path}.default`,
    )) {
      issues.push(i);
    }
  }
  if (
    field.type === "number" &&
    field.min !== undefined &&
    field.max !== undefined &&
    field.min > field.max
  ) {
    issues.push({ path, message: "min is greater than max." });
  }
  return issues;
}

/** Keys a link value is often written with instead of `href`. */
const LINK_KEY_HINTS: Readonly<Record<string, string>> = {
  url: "put the address in href",
  link: "put the address in href",
  path: "put the address in href",
  to: "put the address in href",
  label: "the link text is its own field, not part of the link value",
  text: "the link text is its own field, not part of the link value",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The Zod issues of an object value, in the caller's terms: `unknown key
 * "url" (put the address in href), href missing, target must be "_self" |
 * "_blank" (got "new")`.
 */
export function describeObjectIssues(
  error: z.ZodError,
  value: Record<string, unknown>,
  keyHints: Readonly<Record<string, string>> = {},
): string {
  const parts: string[] = [];
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".");
    const got = issue.path.length > 0 ? value[String(issue.path[0])] : value;
    switch (issue.code) {
      case "unrecognized_keys":
        for (const k of issue.keys) {
          const hint = keyHints[k];
          parts.push(`unknown key "${k}"${hint ? ` (${hint})` : ""}`);
        }
        break;
      case "invalid_type":
        parts.push(
          got === undefined
            ? `${key} missing`
            : `${key} must be a ${issue.expected}, got ${describe(got)}`,
        );
        break;
      case "invalid_value":
        parts.push(
          `${key} must be ${issue.values.map((v) => JSON.stringify(v)).join(" | ")} (got ${describe(got)})`,
        );
        break;
      case "too_small":
        parts.push(
          typeof got === "string" && got.length === 0
            ? `${key} is empty`
            : `${key} must have at least ${String(issue.minimum)} characters`,
        );
        break;
      case "too_big":
        parts.push(`${key} must have at most ${String(issue.maximum)} characters`);
        break;
      case "invalid_format":
        parts.push(`${key} must be a ${issue.format} (got ${describe(got)})`);
        break;
      default:
        parts.push(key.length > 0 ? `${key}: ${issue.message}` : issue.message);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "an object of another shape";
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  const s = typeof value === "string" ? JSON.stringify(value.slice(0, 40)) : typeof value;
  return s;
}
