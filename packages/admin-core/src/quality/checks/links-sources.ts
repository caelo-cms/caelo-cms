// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #849 — the link check's sources, read through the Query API as the
 * audit worker's system actor (no chat branch, so main: the state the
 * staged build was rendered from — the same reasoning as
 * structure-sources.ts, whose module and layout reads it shares).
 *
 * A failed read throws: the runner reports the check as failed and the
 * audit fails loudly instead of reading as "no findings".
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "../../ai/tools/_describe-error.js";
import type { LinkSources } from "./links.js";
import type { RedirectRow } from "./links-analysis.js";
import { structureSourcesFromOps } from "./structure-sources.js";

/** Rows per `redirects.list` page (the op's maximum). */
const REDIRECT_PAGE = 1000;

/** Sources backed by the Query API. */
export function linkSourcesFromOps(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
): LinkSources {
  const run = async (op: string, input: unknown): Promise<unknown> => {
    const r = await execute(registry, adapter, ctx, op, input);
    if (!r.ok) throw new Error(`${op} failed: ${describeError(r.error)}`);
    return r.value;
  };
  const structure = structureSourcesFromOps(registry, adapter, ctx);
  return {
    modules: structure.modules,
    layouts: structure.layouts,
    async redirects() {
      const rows: RedirectRow[] = [];
      for (;;) {
        const page = (await run("redirects.list", {
          limit: REDIRECT_PAGE,
          offset: rows.length,
        })) as { redirects: RedirectRow[]; totalCount: number };
        rows.push(
          ...page.redirects.map((r) => ({
            fromPath: r.fromPath,
            toPath: r.toPath,
            statusCode: r.statusCode,
          })),
        );
        if (page.redirects.length < REDIRECT_PAGE || rows.length >= page.totalCount) return rows;
      }
    },
    async siteUrls() {
      const seo = (await run("site_defaults.get_seo", {})) as { siteBaseUrl: string | null };
      const domains = (await run("domains.list", {})) as {
        domains: { hostname: string; kind: "admin" | "public" }[];
      };
      return [
        ...(seo.siteBaseUrl ? [seo.siteBaseUrl] : []),
        // The admin domain is not the site: a link there is not a page of it.
        ...domains.domains.filter((d) => d.kind === "public").map((d) => d.hostname),
      ];
    },
  };
}
