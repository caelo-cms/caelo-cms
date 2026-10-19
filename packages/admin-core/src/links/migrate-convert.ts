// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — the pure half of the link migration: convert
 * one stored entity's link-carrying parts with the shared canonicaliser
 * (`@caelo-cms/shared` link-canonicalise.ts, REPORT mode) and say what
 * changed. No second canonicaliser lives here: every rule — which keys
 * and field kinds carry links, which paths are pages, media or files —
 * is the write path's rule, so the migration stores exactly what a fresh
 * write of the same content would store.
 */

import {
  type CanonicaliseField,
  canonicaliseContentValues,
  canonicaliseFieldDefaults,
  canonicaliseHtmlLinks,
  canonicaliseJsonLinks,
  collectLinkRefsDeep,
  isLinkKeyName,
  type LinkCanonicaliseIssue,
  type LinkTargetLookup,
  linkCanonicaliseRun,
} from "@caelo-cms/shared";
import { mayContainInternalLink } from "./canonicalise.js";

/** Where a link lives, for counts and the report. */
export type LinkSurface =
  | "module_html"
  | "module_field_defaults"
  | "content_values"
  | "structured_sets"
  | `plugin:${string}`;

/** The outcome of converting one part of one entity. */
export interface PartOutcome<T> {
  readonly next: T;
  readonly changed: boolean;
  /** Links turned into references. */
  readonly converted: number;
  /** Links left literal: no page / asset matches them (never guessed). */
  readonly issues: readonly LinkCanonicaliseIssue[];
}

/** How the run is configured: the site lookup plus the import filter. */
export interface ConvertContext {
  readonly lookup: LinkTargetLookup;
  /** See `LinkCanonicaliseRun.only`. */
  readonly only?: ReadonlySet<string>;
}

/** Well-formed references in a value — prose mentioning "caelo:" does not count. */
function countRefs(v: unknown): number {
  return collectLinkRefsDeep(v).length;
}

function convert<T>(
  value: T,
  cx: ConvertContext,
  apply: (run: ReturnType<typeof linkCanonicaliseRun>) => T,
): PartOutcome<T> {
  if (!mayContainInternalLink(value))
    return { next: value, changed: false, converted: 0, issues: [] };
  const run = linkCanonicaliseRun(cx.lookup, {
    mode: "report",
    ...(cx.only ? { only: cx.only } : {}),
  });
  const next = apply(run);
  const changed = stableJson(next) !== stableJson(value);
  return {
    next: changed ? next : value,
    changed,
    converted: changed ? Math.max(0, countRefs(next) - countRefs(value)) : 0,
    issues: run.issues,
  };
}

/** A module's HTML. */
export function convertModuleHtml(html: string, cx: ConvertContext): PartOutcome<string> {
  return convert(html, cx, (run) => canonicaliseHtmlLinks(html, run, "html"));
}

function isField(f: unknown): f is CanonicaliseField {
  return (
    typeof f === "object" &&
    f !== null &&
    typeof (f as { name?: unknown }).name === "string" &&
    typeof (f as { kind?: unknown }).kind === "string"
  );
}

/** A module's field list: only `default` values are touched. */
export function convertFieldDefaults(
  fields: readonly unknown[],
  cx: ConvertContext,
): PartOutcome<unknown[]> {
  return convert([...fields], cx, (run) =>
    fields.map((f) => (isField(f) ? canonicaliseFieldDefaults([f], run)[0] : f)),
  );
}

/** The declared fields of a module's stored field list. */
export function declaredFields(fields: unknown): CanonicaliseField[] {
  return Array.isArray(fields) ? fields.filter(isField) : [];
}

/** Content values against the module's fields (as the write path reads them). */
export function convertContentValues(
  fields: readonly CanonicaliseField[],
  values: Readonly<Record<string, unknown>>,
  cx: ConvertContext,
): PartOutcome<Record<string, unknown>> {
  return convert({ ...values }, cx, (run) => canonicaliseContentValues(fields, values, run));
}

/** Structured-set items: every `href` at any depth. */
export function convertSetItems(
  items: readonly unknown[],
  cx: ConvertContext,
): PartOutcome<unknown[]> {
  return convert([...items], cx, (run) => canonicaliseJsonLinks(items, run, "items") as unknown[]);
}

/**
 * A plugin column. With `fields` the value is a content-values object;
 * without, any JSON (key-name rule + HTML), the column name itself
 * deciding whether a bare string is a URL.
 */
export function convertPluginValue(
  column: string,
  value: unknown,
  fields: readonly CanonicaliseField[] | undefined,
  cx: ConvertContext,
): PartOutcome<unknown> {
  if (fields && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const values = value as Record<string, unknown>;
    return convert<unknown>(value, cx, (run) => canonicaliseContentValues(fields, values, run));
  }
  return convert(value, cx, (run) =>
    canonicaliseJsonLinks(value, run, column, isLinkKeyName(column)),
  );
}

/** JSON with object keys sorted, so jsonb round trips compare equal. */
export function stableJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
