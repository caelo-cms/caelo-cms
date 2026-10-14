// SPDX-License-Identifier: MPL-2.0

/**
 * Bulk `_many` variant for the SEO sidecar domain, built from the central
 * {@link defineBulkOp} factory (CLAUDE.md §11 bulk-first). Reuses the singular
 * `pages_seo.set` handler per item inside one shared transaction — see
 * `ops/_bulk.ts` for the atomicity guarantee.
 */

import { defineBulkOp } from "./_bulk.js";
import { pagesSeoAutofillOp, pagesSeoSetOp } from "./seo.js";

/**
 * Set per-page SEO fields on N pages in one transaction. Reuses
 * `pages_seo.set` per item, so it stays a manual/panel write that does NOT
 * bump the autofill/optimize fingerprints (CLAUDE.md §2 SEO fill-once rule).
 */
export const pagesSeoSetManyOp = defineBulkOp({
  name: "pages_seo.set_many",
  singular: pagesSeoSetOp,
});

/**
 * First-fill the meta description of N pages in one transaction. Reuses
 * `pages_seo.autofill` per item, so every item keeps the fill-once contract:
 * one already-autofilled page aborts the whole batch (AlreadyAutofilled).
 * This is the bulk step a refused Stage names (deploy/missing-seo.ts).
 */
export const pagesSeoAutofillManyOp = defineBulkOp({
  name: "pages_seo.autofill_many",
  singular: pagesSeoAutofillOp,
});
