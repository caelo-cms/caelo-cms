// SPDX-License-Identifier: MPL-2.0

/**
 * The consent category model.
 *
 * Four categories, because that is what the GDPR-shaped question
 * actually has: what the site cannot work without, what makes it nicer,
 * what measures it, and what follows the visitor. Operators recognise
 * these four from every other site they have used, and regulators treat
 * them as the standard division. Anything finer is a per-tag detail,
 * which is why tags carry a category rather than the other way round.
 *
 * `necessary` is the only one that may run before a choice is made, so
 * it is the one that must not become the path of least resistance —
 * registering a tag there needs a written justification (see the tag
 * surface in `index.ts`).
 */

export interface ConsentCategory {
  readonly key: string;
  readonly displayName: string;
  readonly description: string;
  /** Always on, cannot be declined; the visitor is told, not asked. */
  readonly required: boolean;
  readonly position: number;
}

/**
 * Seeded on activation. Descriptions are operator-facing copy, not
 * legal text — the AI rewrites them per site, which is the point of
 * shipping them as data rather than baking them into the banner.
 */
export const DEFAULT_CATEGORIES: ReadonlyArray<ConsentCategory> = [
  {
    key: "necessary",
    displayName: "Necessary",
    description: "Required for the site to work — session handling, security, and your choices here.",
    required: true,
    position: 0,
  },
  {
    key: "functional",
    displayName: "Functional",
    description: "Remembers preferences such as language or region so you do not set them again.",
    required: false,
    position: 1,
  },
  {
    key: "analytics",
    displayName: "Analytics",
    description: "Helps us understand which pages are useful, in aggregate.",
    required: false,
    position: 2,
  },
  {
    key: "marketing",
    displayName: "Marketing",
    description: "Used to show relevant advertising and to embed content from other services.",
    required: false,
    position: 3,
  },
];

export const CATEGORY_KEYS: ReadonlyArray<string> = DEFAULT_CATEGORIES.map((c) => c.key);

/** Row shape in the plugin's own `categories` table. */
export interface CategoryRow {
  id: string;
  key: string;
  display_name: string;
  description: string;
  required: boolean;
  position: number;
}
