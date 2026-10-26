// SPDX-License-Identifier: MPL-2.0

/**
 * Page types (epic #1107, `docs/lists.md` §5). A page type says what a
 * page IS — News, Product, Doc — while the template stays its layout.
 * It declares the page's properties (same field system as list entries),
 * the templates a page of this type may use, and the vocabularies whose
 * terms apply. Page queries filter on it; the AI reads "this module sits
 * on three News pages" from it (CLAUDE.md §1A). Replaces `templates.kind`.
 */

import { z } from "zod";
import { checkFieldDef, fieldDefSchema, type ListIssue } from "./fields.js";

export const pageTypeDefSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
    name: z.string().min(1).max(200),
    purpose: z.string().min(1).max(1000),
    /** Template ids a page of this type may bind to. */
    templates: z.array(z.string().uuid()).min(1).max(64),
    defaultTemplate: z.string().uuid(),
    properties: z.array(fieldDefSchema).max(32).default([]),
    vocabularies: z
      .array(
        z
          .object({
            /** Vocabulary list id. */
            list: z.string().uuid(),
            cardinality: z.enum(["one", "many"]),
            required: z.boolean().optional(),
          })
          .strict(),
      )
      .max(16)
      .default([]),
  })
  .strict();
export type PageTypeDef = z.infer<typeof pageTypeDefSchema>;

/** Static checks beyond the Zod shape. */
export function checkPageTypeDef(def: PageTypeDef): ListIssue[] {
  const issues: ListIssue[] = [];
  if (!def.templates.includes(def.defaultTemplate)) {
    issues.push({
      path: "defaultTemplate",
      message: "defaultTemplate must be one of templates.",
    });
  }
  const seen = new Set<string>();
  def.properties.forEach((f, i) => {
    const at = `properties[${i}]`;
    if (seen.has(f.name)) issues.push({ path: at, message: `duplicate property "${f.name}".` });
    seen.add(f.name);
    if (f.type === "module") {
      issues.push({
        path: at,
        message: "page properties cannot embed modules — place the module on the page instead.",
      });
    }
    issues.push(...checkFieldDef(f, at));
  });
  const lists = new Set<string>();
  def.vocabularies.forEach((v, i) => {
    if (lists.has(v.list)) {
      issues.push({ path: `vocabularies[${i}]`, message: "vocabulary listed twice." });
    }
    lists.add(v.list);
  });
  return issues;
}
