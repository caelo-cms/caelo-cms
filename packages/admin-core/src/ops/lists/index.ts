// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — registration of the list / list type / page type ops
 * (docs/lists.md §12).
 */

import type { OperationRegistry } from "@caelo-cms/query-api";
import {
  deleteListTypesManyOp,
  getListTypeOp,
  listListTypesOp,
  upsertListTypesManyOp,
} from "./list-types.js";
import {
  deleteListsManyOp,
  getListOp,
  listListsOp,
  patchListItemsManyOp,
  upsertListsManyOp,
} from "./lists.js";
import {
  deletePageTypesManyOp,
  getPageTypeOp,
  listPageTypesOp,
  upsertPageTypesManyOp,
} from "./page-types.js";
import { promoteLocalListOp } from "./promote-local.js";

/** Register every list-model op on `registry`. */
export function registerListOps(registry: OperationRegistry): void {
  registry.register(listListTypesOp);
  registry.register(getListTypeOp);
  registry.register(upsertListTypesManyOp);
  registry.register(deleteListTypesManyOp);
  registry.register(listListsOp);
  registry.register(getListOp);
  registry.register(upsertListsManyOp);
  registry.register(patchListItemsManyOp);
  registry.register(deleteListsManyOp);
  registry.register(promoteLocalListOp);
  registry.register(listPageTypesOp);
  registry.register(getPageTypeOp);
  registry.register(upsertPageTypesManyOp);
  registry.register(deletePageTypesManyOp);
}

export {
  deleteListsManyOp,
  deleteListTypesManyOp,
  deletePageTypesManyOp,
  getListOp,
  getListTypeOp,
  getPageTypeOp,
  listListsOp,
  listListTypesOp,
  listPageTypesOp,
  patchListItemsManyOp,
  promoteLocalListOp,
  upsertListsManyOp,
  upsertListTypesManyOp,
  upsertPageTypesManyOp,
};
