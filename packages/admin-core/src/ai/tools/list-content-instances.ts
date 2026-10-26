// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — `list_content_instances` (2026-07: makeListReadTool — TOON
 * output, uniform filter/limit/offset/full). placementCount = blast
 * radius; check it BEFORE set_content_instance_values.
 *
 * It is also the decision support the retired `## Content Library`
 * prompt block carried (CLAUDE.md §1A, §11: site state is fetched, never
 * put in the system prompt): each row's `purpose` and module kind let the
 * AI decide reuse vs fork vs mint without asking the operator.
 */

import { z } from "zod";
import { makeListReadTool } from "./_make-read-tool.js";

const listContentInstancesInput = z
  .object({
    moduleId: z.string().uuid().optional(),
    slug: z.string().min(1).max(64).optional(),
    pageId: z.string().uuid().optional(),
  })
  .strict();

export const listContentInstancesTool = makeListReadTool<
  z.infer<typeof listContentInstancesInput>,
  {
    id: string;
    moduleSlug: string;
    moduleKind?: string;
    slug: string | null;
    displayName: string | null;
    purpose: string | null;
    placementCount: number;
    nestedParentCount: number;
  }
>({
  name: "list_content_instances",
  description:
    "List content_instances — the values filling module placeholders (TOON rows: id, module, kind, slug, displayName, purpose, placements, parents), most-placed first. " +
    "`purpose` says why a shared row exists: read it BEFORE minting a shared instance (create_content_instance) and reuse a row whose purpose and module fit. " +
    "`placementCount` is the blast radius: >1 means SHARED, editing propagates to every bound page. Check BEFORE set_content_instance_values. " +
    "`parents` counts instances that show this one inside a module / module-list field; an ORPHAN (safe to delete) has placements=0 AND parents=0. Both counts are as this chat's draft sees them. " +
    "Narrow by `moduleId` / `slug` / `pageId` (instances used on one page), plus the standard list params: `filter`, `limit`/`offset`, `full: true`.",
  opName: "content_instances.list",
  input: listContentInstancesInput,
  label: "content_instances",
  // Most-placed first: the shared rows that matter for a reuse decision stay
  // on the first page instead of behind older single-placement rows (the op
  // orders by creation time). The id tiebreak keeps offsets stable.
  rows: (value) =>
    [
      ...(
        value as {
          instances: {
            id: string;
            moduleSlug: string;
            moduleKind?: string;
            slug: string | null;
            displayName: string | null;
            purpose: string | null;
            placementCount: number;
            nestedParentCount: number;
          }[];
        }
      ).instances,
    ].sort((a, b) => b.placementCount - a.placementCount || a.id.localeCompare(b.id)),
  columns: [
    { key: "id", value: (i) => i.id },
    { key: "module", value: (i) => i.moduleSlug },
    { key: "kind", value: (i) => i.moduleKind ?? "" },
    { key: "slug", value: (i) => i.slug ?? "" },
    { key: "displayName", value: (i) => i.displayName ?? "" },
    { key: "purpose", value: (i) => i.purpose ?? "" },
    { key: "placements", value: (i) => i.placementCount },
    { key: "parents", value: (i) => i.nestedParentCount },
  ],
  emptyMessage: "No content_instances match. Call create_content_instance to mint one.",
});
