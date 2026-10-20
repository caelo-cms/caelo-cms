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
import type { LinkSources, ReportedDraftLink, ReportedDraftLinkOrigin } from "./links.js";
import type { RedirectRow } from "./links-analysis.js";
import type { ReferenceCheckIssue, ReferenceSources } from "./references.js";
import { structureSourcesFromOps } from "./structure-sources.js";

/** Rows per `redirects.list` page (the op's maximum). */
const REDIRECT_PAGE = 1000;
/** `links.check_references`' maximum `limit`. */
const REPORTED_DRAFT_LINKS = 500;

interface ReportedIssue {
  readonly place: { readonly kind: string } & Record<string, unknown>;
  readonly pageIds: string[];
  readonly targetPath: string | null;
}

/**
 * What renders a stored link (reference-fix.ts `ReferencePlace`), in the
 * terms the staged HTML carries. A set that is not a nav menu renders
 * nowhere: null.
 */
function originOf(place: ReportedIssue["place"]): ReportedDraftLinkOrigin | null {
  switch (place.kind) {
    case "content":
    case "module-html":
    case "module-default":
      return { kind: "module", moduleId: String(place.moduleId) };
    case "layout-html":
    case "template-html":
      return { kind: "chrome" };
    case "structured-set": {
      const [kind, slug] = String(place.set).split("/");
      return kind === "nav-menu" && slug
        ? { kind: "nav-menu", moduleSlug: `nav-menu-${slug}` }
        : null;
    }
    case "plugin":
      return { kind: "plugin", pluginSlug: String(place.pluginSlug) };
    default:
      throw new Error(`links.check_references returned an unknown place kind "${place.kind}"`);
  }
}

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
    async reportedDraftLinks() {
      // Every unpublished-target issue (warnings included: a draft page's
      // own link is skipped too, it is not in the build). Past the op's
      // limit the rest is simply not skipped — reported twice, never lost.
      const r = (await run("links.check_references", {
        for: "publish",
        includeWarnings: true,
        problems: ["unpublished-target"],
        limit: REPORTED_DRAFT_LINKS,
      })) as { issues: ReportedIssue[] };
      return r.issues.flatMap((i): ReportedDraftLink[] => {
        const origin = originOf(i.place);
        return i.targetPath !== null && origin !== null
          ? [{ targetPath: i.targetPath, pageIds: i.pageIds, origin }]
          : [];
      });
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

/**
 * #724 (rollout F) — the `references` check's source: `links.check_references`
 * as the worker's system actor (no chat branch, so main — what the staged
 * build was rendered from), with the Publish-live policy.
 */
export function referenceSourcesFromOps(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
): ReferenceSources {
  return {
    async issues(limit) {
      const r = await execute(registry, adapter, ctx, "links.check_references", {
        for: "publish",
        includeWarnings: true,
        limit,
      });
      if (!r.ok) throw new Error(`links.check_references failed: ${describeError(r.error)}`);
      return r.value as { issues: ReferenceCheckIssue[]; truncated: boolean };
    },
  };
}
