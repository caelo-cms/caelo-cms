// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — `list_content_instances` (2026-07: makeListReadTool — TOON
 * output, uniform filter/limit/offset/full). placementCount = blast
 * radius; check it BEFORE set_content_instance_values.
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
    slug: string | null;
    displayName: string | null;
    placementCount: number;
    nestedParentCount: number;
  }
>({
  name: "list_content_instances",
  description:
    "List content_instances — the values filling module placeholders (TOON rows: id, module, slug, displayName, placements, parents). " +
    "`placementCount` is the blast radius: >1 means SHARED, editing propagates to every bound page. Check BEFORE set_content_instance_values. " +
    "`parents` counts instances that show this one inside a module / module-list field; an ORPHAN (safe to delete) has placements=0 AND parents=0. Both counts are as this chat's draft sees them. " +
    "Narrow by `moduleId` / `slug` / `pageId` (instances used on one page), plus the standard list params: `filter`, `limit`/`offset`, `full: true`.",
  opName: "content_instances.list",
  input: listContentInstancesInput,
  label: "content_instances",
  rows: (value) =>
    (
      value as {
        instances: {
          id: string;
          moduleSlug: string;
          slug: string | null;
          displayName: string | null;
          placementCount: number;
          nestedParentCount: number;
        }[];
      }
    ).instances,
  columns: [
    { key: "id", value: (i) => i.id },
    { key: "module", value: (i) => i.moduleSlug },
    { key: "slug", value: (i) => i.slug ?? "" },
    { key: "displayName", value: (i) => i.displayName ?? "" },
    { key: "placements", value: (i) => i.placementCount },
    { key: "parents", value: (i) => i.nestedParentCount },
  ],
  emptyMessage: "No content_instances match. Call create_content_instance to mint one.",
});
