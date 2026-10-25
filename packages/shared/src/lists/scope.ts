// SPDX-License-Identifier: MPL-2.0

/**
 * The values a template sees inside a list section (epic #1107,
 * `docs/lists.md` §8) — the seam between the resolver (`resolve.ts`),
 * which turns stored entries, page queries, system and plugin sources
 * into these scopes, and the template engine, which only looks keys up.
 * The engine knows nothing about list types, links or pages; the
 * resolver knows nothing about template syntax.
 *
 * Every lookup is lazy: a children list, a query or an embedded module
 * is only resolved when the template actually reaches it, so render
 * dependencies (`ListRenderDeps`) record what a page really rendered,
 * not what it could have.
 */

/** One value a template key resolves to. */
export type ScopeValue =
  /** Plain text (`{{f}}`); a section over it renders when it is non-empty. */
  | { readonly kind: "text"; readonly text: string }
  /** A flag (`{{#is_current}}`); `{{f}}` renders `true` / `false`. */
  | { readonly kind: "bool"; readonly value: boolean }
  /**
   * A compound value with dot access (`link`, `media`, `date`, `props`,
   * `page`). `text` is what the bare key renders (`{{link}}` = href);
   * null when the bare key has no meaning (`{{props}}`).
   */
  | {
      readonly kind: "record";
      readonly text: string | null;
      /** Section truthiness of the bare key (`{{#link}}` — set or not). */
      readonly present: boolean;
      get(key: string): ScopeValue | undefined;
    }
  /** Iterable entries (`children`, `items`, a term field, `page.terms.tags`). */
  | { readonly kind: "list"; readonly entries: readonly ScopeEntry[] }
  /** An embedded module (`{{>f}}`). */
  | {
      readonly kind: "module";
      readonly ref: { readonly moduleId: string; readonly contentInstanceId: string };
    }
  /**
   * A value that could not resolve (a list source of an inactive plugin,
   * a malformed query). The engine renders the tag raw and reports
   * `marker` — loud, never silently empty (CLAUDE.md §2).
   */
  | { readonly kind: "failed"; readonly marker: string };

/** One entry a list section iterates. */
export interface ScopeEntry {
  /** The entry id (stored uuid, page id for page-shaped entries, plugin id). */
  readonly id: string;
  /** Look up a key of this entry: fields, system keys, children, `items`. */
  get(key: string): ScopeValue | undefined;
  /**
   * Value of the `data-caelo-list-item` attribute stamped on the entry's
   * root element (`docs/lists.md` §13), or null for generated entries that
   * are no stored list entry (query results, plugin entries).
   */
  readonly itemAttr: string | null;
  /**
   * Loop name of this entry's stored children (`children.name` of its
   * node), which `{{>recurse}}` renders with the enclosing block; null
   * when the node takes no children.
   */
  readonly childrenKey: string | null;
  /** 1-based depth in its tree. */
  readonly depth: number;
}
