// SPDX-License-Identifier: MPL-2.0

/**
 * Bulk `_many` variants for the `content_instances` domain, built from the
 * central {@link defineBulkOp} factory (CLAUDE.md §11 bulk-first). Each reuses
 * the singular op's handler verbatim inside one shared transaction, so a
 * failing item rolls the whole batch back — see `ops/_bulk.ts` for the
 * atomicity guarantee.
 */

import { defineBulkOp } from "../_bulk.js";
import { deleteContentInstanceOp, setContentInstanceValuesOp } from "./content-instances.js";

/**
 * Edit the values of N content_instances in one transaction. Reuses
 * `content_instances.set_values` per item (lock, branch overlay, nested-ref
 * validation, audit, snapshot all apply unchanged).
 */
export const setContentInstanceValuesManyOp = defineBulkOp({
  name: "content_instances.set_values_many",
  singular: setContentInstanceValuesOp,
});

/**
 * Soft-delete N content_instances in one transaction. Reuses
 * `content_instances.delete` per item — so the "N>0 placements" refusal still
 * fires per row, and any refusal aborts the whole batch.
 */
export const deleteContentInstancesManyOp = defineBulkOp({
  name: "content_instances.delete_many",
  singular: deleteContentInstanceOp,
});
