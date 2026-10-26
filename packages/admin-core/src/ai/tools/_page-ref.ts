// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #690 — resolve the page reference an AI tool was given.
 *
 * Page identity is the page id; the URL path is unique per branch; a
 * slug is only one path segment and may name several pages
 * (`/monitoring/alerts`, `/rankings/alerts`). So a reference is:
 *
 * - a UUID — taken as is;
 * - a path ("/monitoring/alerts") — matched against the caller's view of
 *   every page's composed path (a chat sees its own pending moves);
 * - a bare slug — accepted only while it names exactly ONE page. An
 *   ambiguous slug fails loudly with every candidate's path, never
 *   "first match wins".
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolContext } from "./dispatch.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PageRefResult =
  | { readonly ok: true; readonly pageId: string }
  | { readonly ok: false; readonly message: string };

/** Path key: no trailing slash except for the root. */
function pathKey(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/**
 * Resolve each reference (id, path or unambiguous slug) to a page id,
 * listing pages at most once.
 */
export async function resolvePageRefs(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  refs: readonly string[],
): Promise<PageRefResult[]> {
  if (refs.every((r) => UUID_RE.test(r))) return refs.map((pageId) => ({ ok: true, pageId }));
  const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.list", {});
  if (!listed.ok) {
    const message = `pages.list failed: ${describeError(listed.error)}`;
    return refs.map(() => ({ ok: false, message }));
  }
  const pages = (listed.value as { pages: { id: string; slug: string; currentPath: string }[] })
    .pages;
  return refs.map((ref): PageRefResult => {
    if (UUID_RE.test(ref)) return { ok: true, pageId: ref };
    if (ref.startsWith("/")) {
      const hit = pages.find((p) => pathKey(p.currentPath) === pathKey(ref));
      if (hit) return { ok: true, pageId: hit.id };
      // The homepage is served at "/", so "/<its slug>" (e.g. "/home") can
      // never be another page's path — it names the homepage the same way
      // its bare slug already does (PR #1121 e2e: add_module targetRef
      // "/home" was refused).
      const home = pages.find((p) => p.currentPath === "/");
      if (home && pathKey(ref) === `/${home.slug}`) return { ok: true, pageId: home.id };
      return {
        ok: false,
        message: `no page lives at ${ref} — call list_pages for the current paths, or pass the page id`,
      };
    }
    const bySlug = pages.filter((p) => p.slug === ref);
    if (bySlug.length === 1 && bySlug[0]) return { ok: true, pageId: bySlug[0].id };
    if (bySlug.length > 1) {
      return {
        ok: false,
        message: `"${ref}" is the slug of ${bySlug.length} pages (${bySlug.map((p) => p.currentPath).join(", ")}) — pass the page's id or its full path instead`,
      };
    }
    return {
      ok: false,
      message: `no page with slug "${ref}" — pass the page id or its URL path (list_pages)`,
    };
  });
}

/** Single-reference convenience over {@link resolvePageRefs}. */
export async function resolvePageRef(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  ref: string,
): Promise<PageRefResult> {
  const [r] = await resolvePageRefs(ctx, toolCtx, [ref]);
  return r ?? { ok: false, message: "no reference given" };
}
