// SPDX-License-Identifier: MPL-2.0

/**
 * issue #425 — decode the `import_runs.crawl_scope` jsonb into the
 * crawler's scope. Pure so the malformed-input contract is unit-testable
 * without booting the orchestrator (the parseExplicitUrls precedent).
 */

import type { CrawlScope } from "@caelo-cms/site-importer";

/**
 * Thrown when `crawl_scope` is present but not a usable scope object.
 * The Owner approved a SCOPED crawl — silently degrading to an unscoped
 * one would crawl a different site slice than the one they clicked
 * Approve on, so a malformed value fails the run loudly (CLAUDE.md §2
 * no-fallbacks) instead.
 */
export class CrawlScopeMalformedError extends Error {
  constructor(reason: string, badValue: unknown) {
    let rendered: string;
    try {
      rendered = JSON.stringify(badValue) ?? String(badValue);
    } catch {
      rendered = String(badValue);
    }
    super(
      `import_runs.crawl_scope is malformed (${reason}): got ${rendered.slice(0, 200)}. ` +
        `A scoped crawl must run with the exact Owner-approved scope — refusing to fall back ` +
        `to an unscoped crawl. Fix or clear crawl_scope (SQL NULL = unscoped) and re-approve the run.`,
    );
    this.name = "CrawlScopeMalformedError";
  }
}

/**
 * Decode `crawl_scope` (jsonb — may arrive decoded or as a JSON string
 * depending on the client) into a {@link CrawlScope}.
 *
 * @returns `null` ONLY when the column is absent (SQL NULL / undefined /
 *   jsonb null), meaning an unscoped crawl. Any present-but-wrong shape —
 *   unparseable JSON, non-object, wrong field types, no recognised rule —
 *   throws {@link CrawlScopeMalformedError} so the run fails loudly.
 */
export function parseCrawlScope(raw: unknown): CrawlScope | null {
  if (raw === null || raw === undefined) return null;
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      throw new CrawlScopeMalformedError("unparseable JSON string", raw);
    }
    // A jsonb `null` serialised by the client — same as SQL NULL.
    if (v === null) return null;
  }
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new CrawlScopeMalformedError("expected a JSON object", v);
  }
  const o = v as { pathPrefix?: unknown; locale?: unknown };
  if (o.pathPrefix !== undefined && typeof o.pathPrefix !== "string") {
    throw new CrawlScopeMalformedError("pathPrefix is not a string", o.pathPrefix);
  }
  if (o.locale !== undefined && typeof o.locale !== "string") {
    throw new CrawlScopeMalformedError("locale is not a string", o.locale);
  }
  if (o.pathPrefix === undefined && o.locale === undefined) {
    throw new CrawlScopeMalformedError("neither pathPrefix nor locale is set", v);
  }
  const scope: { pathPrefix?: string; locale?: string } = {};
  if (typeof o.pathPrefix === "string") scope.pathPrefix = o.pathPrefix;
  if (typeof o.locale === "string") scope.locale = o.locale;
  return scope;
}
