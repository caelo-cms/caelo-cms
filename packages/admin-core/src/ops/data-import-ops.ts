// SPDX-License-Identifier: MPL-2.0

/** The operations of data imports and their uploads, for `registerAdminOps` (docs/data-imports.md). */

import {
  dataImportItemRefsOp,
  getDataImportOp,
  listDataImportsOp,
  lookupDataImportOp,
  markDataImportUndoneOp,
  openDataImportOp,
  recordDataImportOp,
} from "./data_imports.js";
import {
  createDataUploadSlotOp,
  forgetDataUploadsOp,
  getDataUploadOp,
  recordDataUploadOp,
} from "./data_uploads.js";

export const DATA_IMPORT_OPS = [
  lookupDataImportOp,
  openDataImportOp,
  recordDataImportOp,
  listDataImportsOp,
  getDataImportOp,
  dataImportItemRefsOp,
  markDataImportUndoneOp,
  createDataUploadSlotOp,
  recordDataUploadOp,
  getDataUploadOp,
  forgetDataUploadsOp,
] as const;
