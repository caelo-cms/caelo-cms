// SPDX-License-Identifier: MPL-2.0

/**
 * What an audited write means for the next automatic rebuild (epic
 * #1107). A page write names its page; a list or list-type write names
 * the list / type, and the static generator adds every page whose render
 * dependencies (`render-deps.json`) read it — the header menu changed,
 * so every page showing it rebuilds, and nothing else. A list-domain
 * write that names no entity, or a page-type write (properties render on
 * every page of the type and in every query that shows them), cannot be
 * narrowed and asks for a full rebuild.
 */

/** One audited write, classified for the rebuild. */
export type AuditRenderChange =
  | { readonly kind: "page"; readonly id: string }
  | { readonly kind: "list"; readonly id: string }
  | { readonly kind: "listType"; readonly id: string }
  | { readonly kind: "full" }
  /** Not a list-domain write: the caller's existing page resolution applies. */
  | { readonly kind: "other" };

/** Classify an `audit_events` row by operation and entity id. */
export function classifyAuditRow(operation: string, entityId: string | null): AuditRenderChange {
  if (operation.startsWith("pages.")) {
    return entityId ? { kind: "page", id: entityId } : { kind: "other" };
  }
  if (operation.startsWith("lists.")) {
    return entityId ? { kind: "list", id: entityId } : { kind: "full" };
  }
  if (operation.startsWith("list_types.")) {
    return entityId ? { kind: "listType", id: entityId } : { kind: "full" };
  }
  if (operation.startsWith("page_types.")) return { kind: "full" };
  return { kind: "other" };
}

/** The list half of a pending rebuild. */
export interface PendingListChange {
  readonly listIds: Set<string>;
  readonly listTypeIds: Set<string>;
  /** A change no id narrows: rebuild every page. */
  full: boolean;
}
