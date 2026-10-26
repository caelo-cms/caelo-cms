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
  "recurse",
]);
const RESERVED_PREFIXES = ["is_", "has_", "count_"] as const;

/** True when `name` is taken by the engine (see {@link LIST_RESERVED_NAMES}). */
export function isReservedListName(name: string): boolean {
  return LIST_RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p));
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
  const bad = (expected: string): ListIssue[] => [
    { path, message: `"${field.name}" must be ${expected}, got ${describe(value)}.` },
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
      return r.success ? [] : bad('{ href, target? } (href like "/about" or "https://…")');
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
    case "module":
      return embeddedModuleValueSchema.safeParse(value).success
        ? []
        : bad("{ moduleId, contentInstanceId }");
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
      message: `field name "${field.name}" is reserved by the template engine — pick another name.`,
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

function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  const s = typeof value === "string" ? JSON.stringify(value.slice(0, 40)) : typeof value;
  return s;
}
