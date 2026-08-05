// SPDX-License-Identifier: MPL-2.0

/**
 * issue #425 — the operator's language/section scope for a crawl, at the
 * Query API boundary. Lives in its own module (not ops/imports.ts) so
 * the propose tool, the ops, and the read surfaces share ONE schema.
 *
 * The scope shape mirrors @caelo-cms/site-importer's `CrawlScope`; the
 * z.ZodType annotation makes drift a compile error (same precedent as
 * the design-token schemas in ops/imports.ts).
 */

import { type CrawlScope, isPathInScope, stripTrailingSlashes } from "@caelo-cms/site-importer";
import { z } from "zod";

/**
 * {pathPrefix?, locale?} — at least one rule must be present (an empty
 * scope object scopes nothing and is a caller bug, rejected loudly).
 */
export const importCrawlScopeSchema: z.ZodType<CrawlScope> = z
  .object({
    pathPrefix: z
      .string()
      .min(1)
      .max(300)
      .regex(/^\//, "scope.pathPrefix must start with '/' (a URL path prefix like /de/)")
      .optional(),
    locale: z
      .string()
      .regex(
        /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/,
        "scope.locale is a language code like de or pt-br",
      )
      .optional(),
  })
  .strict()
  .refine((v) => v.pathPrefix !== undefined || v.locale !== undefined, {
    message:
      "scope must set pathPrefix and/or locale — an empty scope object scopes nothing; omit `scope` for an unscoped crawl",
  });

/**
 * Zod superRefine shared by `imports.propose_run`, `imports.create_run`
 * and the propose tool: a path-prefix scope only makes sense when the
 * crawl ROOT lives inside it (the root anchors discovery + the homepage
 * design). The error is AI-actionable — it says what to pass instead.
 */
export function refineCrawlScopeAgainstSourceUrl(
  v: { sourceUrl: string; scope?: CrawlScope | undefined },
  ctx: z.RefinementCtx,
): void {
  const prefix = v.scope?.pathPrefix;
  if (prefix === undefined) return;
  let path: string;
  let origin: string;
  try {
    const u = new URL(v.sourceUrl);
    path = u.pathname;
    origin = u.origin;
  } catch {
    return; // sourceUrl's own .url() check already reports this
  }
  if (!isPathInScope(path, prefix)) {
    // Linear strip, not `/\/+$/` (js/polynomial-redos on slash runs).
    const p = stripTrailingSlashes(prefix);
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scope", "pathPrefix"],
      message:
        `sourceUrl path (${path}) lies outside scope.pathPrefix (${prefix}) — ` +
        `crawl the scope root directly (sourceUrl: ${origin}${p}/) or widen/remove the scope`,
    });
  }
}

/**
 * Normalise the stored `import_runs.crawl_scope` jsonb for read
 * surfaces (may arrive decoded or as a JSON string depending on the SQL
 * client path — the `estimate` precedent). Defensive shape-filter, not
 * validation: writes went through `importCrawlScopeSchema`, and a read
 * surface must never brick on schema evolution.
 */
export function normalizeStoredCrawlScope(raw: unknown): CrawlScope | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as { pathPrefix?: unknown; locale?: unknown };
  const scope: { pathPrefix?: string; locale?: string } = {};
  if (typeof o.pathPrefix === "string") scope.pathPrefix = o.pathPrefix;
  if (typeof o.locale === "string") scope.locale = o.locale;
  return scope.pathPrefix !== undefined || scope.locale !== undefined ? scope : null;
}
