// SPDX-License-Identifier: MPL-2.0

/**
 * What the generated field inputs need besides the field and its value
 * (epic #1107): pickers' data and the editor's permissions. Built once
 * per page by the route and passed down unchanged.
 */

import type { ListItemInput } from "@caelo-cms/shared";

/** A vocabulary list with its entries, for term pickers. */
export interface VocabularyChoice {
  id: string;
  slug: string;
  name: string;
  items: ListItemInput[];
}

/** Pickers' data + mode for every field input of one form. */
export interface FieldEditorContext {
  pages: readonly { id: string; path: string; title: string }[];
  modules: readonly {
    id: string;
    slug: string;
    displayName: string;
    type: string;
    description: string;
  }[];
  vocabularies: readonly VocabularyChoice[];
  readOnly: boolean;
  /**
   * Create a content instance of `moduleId` for an embedded-module field
   * and return its id (null when the server refused; it showed why).
   * Absent where embedding is not offered.
   */
  createInstance?: (moduleId: string) => Promise<string | null>;
}

/** One selectable vocabulary entry: its term reference, name and depth. */
export interface TermChoice {
  ref: string;
  name: string;
  depth: number;
}

/** Flatten a vocabulary into term choices, depth-first, children indented. */
export function termChoices(vocabulary: VocabularyChoice): TermChoice[] {
  const out: TermChoice[] = [];
  const walk = (items: readonly ListItemInput[], depth: number): void => {
    for (const it of items) {
      if (it.id) {
        const name = typeof it.values.name === "string" ? it.values.name : it.id;
        out.push({ ref: `caelo:term/${vocabulary.id}/${it.id}`, name, depth });
      }
      walk(it.children ?? [], depth + 1);
    }
  };
  walk(vocabulary.items, 1);
  return out;
}
