// SPDX-License-Identifier: MPL-2.0

/**
 * Form generation for list entry fields and page properties (epic #1107,
 * `docs/lists.md` §2). One field definition yields one input; the Svelte
 * side only picks the component for {@link FieldInputSpec.widget}. Keeping
 * the mapping, the empty/initial values and the coercion of raw input here
 * makes them unit-testable and identical for list entries and page
 * properties.
 */

import { type FieldDef, type ListTypeDef, validateFieldValue } from "@caelo-cms/shared";

/** Which input component renders a field. One per field type. */
export type FieldWidget =
  | "text"
  | "richtext"
  | "link"
  | "media"
  | "select"
  | "boolean"
  | "number"
  | "date"
  | "icon"
  | "module"
  | "term";

/** Everything an input needs to render one field. */
export interface FieldInputSpec {
  widget: FieldWidget;
  name: string;
  label: string;
  required: boolean;
  /** Text inputs. */
  maxLength?: number;
  /** Number inputs. */
  min?: number;
  max?: number;
  /** Select inputs. */
  options?: readonly string[];
  /** Module inputs: accepted module types (empty = any). */
  accepts?: readonly string[];
  /** Term inputs: vocabulary list slug, and whether several terms may be picked. */
  vocabulary?: string;
  multiple?: boolean;
}

const TEXT_MAX = 500;
const RICHTEXT_MAX = 5000;

/** The input spec of a field definition. */
export function fieldInputSpec(field: FieldDef): FieldInputSpec {
  const base = { name: field.name, label: field.label, required: field.required === true };
  switch (field.type) {
    case "text":
      return { ...base, widget: "text", maxLength: field.maxLength ?? TEXT_MAX };
    case "richtext":
      return { ...base, widget: "richtext", maxLength: field.maxLength ?? RICHTEXT_MAX };
    case "select":
      return { ...base, widget: "select", options: field.options };
    case "number":
      return {
        ...base,
        widget: "number",
        ...(field.min !== undefined ? { min: field.min } : {}),
        ...(field.max !== undefined ? { max: field.max } : {}),
      };
    case "module":
      return { ...base, widget: "module", accepts: field.accepts ?? [] };
    case "term":
      return { ...base, widget: "term", vocabulary: field.list, multiple: field.multiple === true };
    default:
      return { ...base, widget: field.type };
  }
}

/** The values a new entry starts with: every field's `default`, nothing else. */
export function initialValues(fields: readonly FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f.default !== undefined) out[f.name] = structuredClone(f.default);
  return out;
}

/** True when `value` counts as "not set" for the field (it is then omitted on save). */
export function isEmptyValue(field: FieldDef, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  switch (field.type) {
    case "text":
    case "richtext":
    case "media":
    case "select":
    case "date":
    case "icon":
      return typeof value === "string" && value.trim() === "";
    case "link":
      return (
        typeof value !== "object" ||
        typeof (value as { href?: unknown }).href !== "string" ||
        (value as { href: string }).href.trim() === ""
      );
    case "term":
      return Array.isArray(value) && value.length === 0;
    default:
      return false;
  }
}

/**
 * The value to store from what an input produced: strings trimmed where
 * whitespace means nothing (dates, icons, link targets), numbers parsed,
 * and an empty input becomes `undefined` (the field is not set).
 */
export function coerceFieldValue(field: FieldDef, raw: unknown): unknown {
  if (field.type === "number") {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
    if (typeof raw !== "string" || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (field.type === "boolean") return raw === true || raw === "true" || raw === "on";
  if (field.type === "date" || field.type === "icon") {
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
  }
  if (field.type === "link" && raw && typeof raw === "object") {
    const l = raw as { href?: unknown; target?: unknown };
    const href = typeof l.href === "string" ? l.href.trim() : "";
    if (href === "") return undefined;
    return l.target === "_blank" ? { href, target: "_blank" } : { href };
  }
  return isEmptyValue(field, raw) ? undefined : raw;
}

/**
 * Values ready to save: every declared field coerced, unset ones dropped.
 * Keys the definition does not declare are dropped too — the op would
 * refuse them, and the form has no input that could show them.
 */
export function cleanValues(
  fields: readonly FieldDef[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = coerceFieldValue(f, values[f.name]);
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

/** Inline problems of one value, as the server would report them (messages only). */
export function fieldProblems(field: FieldDef, value: unknown): string[] {
  const v = coerceFieldValue(field, value);
  // Humanised references (a page path, `/_caelo/media/…`) are stored as
  // references on save, so the shape check is the server's for those.
  if (field.type === "media" && typeof v === "string" && v.startsWith("/_caelo/media/")) return [];
  if (field.required && (v === undefined || isEmptyValue(field, v))) return ["Required."];
  return validateFieldValue(field, v, field.name).map((i) => i.message);
}

/**
 * The text a tree row shows for an entry: the first non-empty text-like
 * value (label, name, title …), else a link's target, else the node label.
 */
export function entrySummary(
  def: ListTypeDef,
  node: string,
  values: Record<string, unknown>,
): string {
  const fields = def.nodes[node]?.fields ?? [];
  for (const f of fields) {
    const v = values[f.name];
    if ((f.type === "text" || f.type === "select" || f.type === "icon") && typeof v === "string") {
      if (v.trim() !== "") return v.trim();
    }
  }
  for (const f of fields) {
    const v = values[f.name] as { href?: unknown } | undefined;
    if (f.type === "link" && v && typeof v.href === "string" && v.href !== "") return v.href;
  }
  return def.nodes[node]?.label ?? node;
}
