// SPDX-License-Identifier: MPL-2.0

/**
 * Bulk `_many` variants for the media domain, built from the central
 * {@link defineBulkOp} factory (CLAUDE.md §11 bulk-first). Each reuses the
 * matching singular op's handler inside one shared transaction — see
 * `ops/_bulk.ts` for the atomicity guarantee.
 *
 * (`media.delete_many` already exists as a bespoke op in `media.ts` because its
 * blast-radius semantics — per-asset `force` + a `blocked` report — differ from
 * the uniform all-or-nothing shape this factory produces.)
 */

import { defineBulkOp } from "./_bulk.js";
import { mediaSetSourceOp, mediaUpdateAltOp } from "./media.js";

/**
 * Replace the alt text on N assets in one transaction. Reuses
 * `media.update_alt` per item (a11y curation — CLAUDE.md §11 routine AI turf).
 */
export const mediaUpdateAltManyOp = defineBulkOp({
  name: "media.update_alt_many",
  singular: mediaUpdateAltOp,
});

/**
 * Record provenance + licence on N assets in one transaction. Reuses
 * `media.set_source` per item (COALESCE semantics — omitted fields unchanged).
 */
export const mediaSetSourceManyOp = defineBulkOp({
  name: "media.set_source_many",
  singular: mediaSetSourceOp,
});
