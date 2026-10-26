// SPDX-License-Identifier: MPL-2.0

/**
 * The `pages.update` payload of the page settings' type section (epic
 * #1107). `pages.update` MERGES properties (`null` removes one) and
 * REPLACES terms, so the form sends every property the type declares
 * (cleaned), `null` for every stored property the page should no longer
 * carry (emptied, or not part of the new type), and only the terms of the
 * type's vocabularies.
 */

import type { PageTypeDef } from "@caelo-cms/shared";
import { cleanValues } from "./field-form.js";

/** What the form holds for the page. */
export interface PageSettingsDraft {
  properties: Readonly<Record<string, unknown>>;
  terms: readonly string[];
}

/** The properties + terms to send for `type`, given the page as stored. */
export function pageSettingsPayload(
  type: Pick<PageTypeDef, "properties" | "vocabularies">,
  draft: PageSettingsDraft,
  stored: { properties: Readonly<Record<string, unknown>> },
): { properties: Record<string, unknown>; terms: string[] } {
  const properties: Record<string, unknown> = cleanValues(type.properties, draft.properties);
  for (const k of Object.keys(stored.properties)) {
    if (!(k in properties)) properties[k] = null;
  }
  const lists = new Set(type.vocabularies.map((v) => v.list));
  const terms = draft.terms.filter((t) => {
    const listId = /^caelo:term\/([0-9a-f-]{36})\//.exec(t)?.[1];
    return listId !== undefined && lists.has(listId);
  });
  return { properties, terms: [...new Set(terms)] };
}
