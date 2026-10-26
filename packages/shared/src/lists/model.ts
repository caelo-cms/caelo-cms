// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part G — the list definitions without the renderer: field
 * system, list and page type schemas, entries and value addresses. Only
 * Zod underneath, so the plugin SDK can re-export it into plugin code —
 * the Deno sandbox bundles the SDK with everything it imports, and the
 * package root pulls in the template engine and HTML parser.
 * Exposed as `@caelo-cms/shared/lists-model`.
 */

export * from "./address.js";
export * from "./fields.js";
export * from "./items.js";
export * from "./list-type.js";
export * from "./page-type.js";
