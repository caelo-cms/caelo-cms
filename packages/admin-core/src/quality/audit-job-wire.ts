// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — the quality audit's reports: what its job asks the admin
 * and what it gets back, in JSON. Shared by the job (quality/audit-job.ts)
 * and the admin (quality/audit-job-kind.ts).
 *
 *   start            the run to audit (the admin claims it), or `stop`
 *   source           one read a findings check needs (modules, layouts,
 *                    the page index, redirects, link issues, the site's
 *                    own URLs): the job holds no database credential
 *   plugin-findings  one call of an active plugin's audit operation (the
 *                    plugin host lives only in the admin)
 *   result           the audit's outcome, recorded by
 *                    `quality_audits.record_result`
 */

import { z } from "zod";
import type { ClaimedAuditRun } from "./audit-run.js";
import type { StructurePageIndex } from "./checks/structure-listing.js";

/** What `start` answers. */
export type AuditStart =
  | {
      readonly kind: "run";
      readonly run: ClaimedAuditRun;
      /** Slugs of the active plugins whose audit operation runs in this audit. */
      readonly pluginContributors: readonly string[];
    }
  | {
      readonly kind: "stop";
      /** Why there is nothing to audit (superseded, already settled, deleted). */
      readonly reason: string;
    };

/** The reads `source` serves, with their arguments. */
export const auditSourceRequestSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("modules") }).strict(),
  z.object({ name: z.literal("layouts") }).strict(),
  z.object({ name: z.literal("pageIndex") }).strict(),
  z.object({ name: z.literal("redirects") }).strict(),
  z.object({ name: z.literal("siteUrls") }).strict(),
  z.object({ name: z.literal("reportedDraftLinks") }).strict(),
  z
    .object({
      name: z.literal("neverLivePageIds"),
      pageIds: z.array(z.string().uuid()).max(100_000),
    })
    .strict(),
  z
    .object({ name: z.literal("referenceIssues"), limit: z.number().int().min(1).max(1000) })
    .strict(),
]);

export type AuditSourceRequest = z.infer<typeof auditSourceRequestSchema>;

type ValueOf<M> = M extends ReadonlyMap<string, infer V> ? V : never;

/** {@link StructurePageIndex} as JSON: its maps and set as entry lists. */
export interface PageIndexWire {
  readonly pageTypes: [string, ValueOf<StructurePageIndex["pageTypes"]>][];
  readonly pages: [string, ValueOf<StructurePageIndex["pages"]>][];
  readonly siteHosts: string[];
  readonly variantGroups: [string, string][];
  readonly pageLayouts: [string, string][];
}

/** The page index as JSON. Pure. */
export function pageIndexToWire(index: StructurePageIndex): PageIndexWire {
  return {
    pageTypes: [...index.pageTypes.entries()],
    pages: [...index.pages.entries()],
    siteHosts: [...index.siteHosts],
    variantGroups: [...index.variantGroups.entries()],
    pageLayouts: [...index.pageLayouts.entries()],
  };
}

/** The page index back from JSON. Pure. */
export function pageIndexFromWire(wire: PageIndexWire): StructurePageIndex {
  return {
    pageTypes: new Map(wire.pageTypes),
    pages: new Map(wire.pages),
    siteHosts: new Set(wire.siteHosts),
    variantGroups: new Map(wire.variantGroups),
    pageLayouts: new Map(wire.pageLayouts),
  };
}

/** What `plugin-findings` carries: one call of one plugin's audit operation. */
export const auditPluginCallSchema = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,119}$/),
    label: z.string().min(1).max(40),
    args: z
      .object({
        pages: z
          .array(z.object({ pageId: z.string().uuid(), path: z.string().max(2048) }).strict())
          .max(100_000),
        // The facts the job read from the staged HTML (plugin-sdk
        // PluginAuditPageFacts). The plugin validates what it reads; the
        // admin bounds how much reaches it.
        facts: z.array(z.record(z.string(), z.unknown())).max(200).optional(),
      })
      .strict(),
  })
  .strict();
