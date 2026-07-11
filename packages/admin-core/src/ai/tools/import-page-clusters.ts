// SPDX-License-Identifier: MPL-2.0

/**
 * issue #194 — page-type cluster tools for the migration flow. The
 * crawler grouped every crawled page by deterministic structural
 * signature; these tools let the AI SEE the grouping, NAME it, and
 * apply the operator's corrections — the confirmed clusters become
 * the per-type templates when the site is built (#195).
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listInput = z.object({ runId: z.string().uuid() }).strict();
type ListInput = z.infer<typeof listInput>;

interface ClusterOut {
  clusterKey: string;
  label: string | null;
  count: number;
  samples: {
    importPageId: string;
    sourceUrl: string;
    proposedTitle: string;
    proposedSlug: string;
  }[];
}

export const listImportPageClustersTool: ToolDefinitionWithHandler<ListInput> = {
  name: "list_import_page_clusters",
  description:
    "List the page-type clusters of a crawled import run (grouped by structural shape — 45 blog posts share one cluster). Use AFTER a crawl reaches ready_for_review and BEFORE building beyond the homepage: present the clusters to the operator in plain words and get their confirmation — each confirmed cluster becomes ONE template. 'home' is always its own cluster (the design contract). Then name/correct clusters with `assign_import_page_cluster`.",
  schema: listInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId"],
    properties: { runId: { type: "string", format: "uuid" } },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.list_page_clusters",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `list_import_page_clusters failed: ${describeError(r.error)}` };
    }
    const clusters = (r.value as { clusters: ClusterOut[] }).clusters;
    if (clusters.length === 0) {
      return {
        ok: true,
        content:
          "No pages in this run yet — is the crawl finished? Check the run status before clustering.",
      };
    }
    const lines = clusters.map((c) => {
      const samples = c.samples
        .map((s) => `${s.proposedTitle || s.proposedSlug} (${s.importPageId})`)
        .join("; ");
      return `- ${c.clusterKey}${c.label ? ` ("${c.label}")` : " (unlabelled)"} — ${c.count} page${c.count === 1 ? "" : "s"}. Samples: ${samples}`;
    });
    return {
      ok: true,
      content: [
        `${clusters.length} page-type clusters:`,
        ...lines,
        "",
        "Next: present these in plain words, label each with `assign_import_page_cluster({runId, clusterKey, label})`, apply operator corrections with the same tool (importPageIds moves pages), and get an explicit confirmation before composing.",
      ].join("\n"),
    };
  },
};

const assignInput = z
  .object({
    runId: z.string().uuid(),
    clusterKey: z.string().min(1).max(200),
    importPageIds: z.array(z.string().uuid()).max(2000).optional(),
    label: z.string().min(1).max(120).optional(),
  })
  .strict();
type AssignInput = z.infer<typeof assignInput>;

export const assignImportPageClusterTool: ToolDefinitionWithHandler<AssignInput> = {
  name: "assign_import_page_cluster",
  description:
    "Name a page-type cluster and/or move pages between clusters (bulk, one transaction). Pass `label` to give the cluster the human name the operator used ('Blogartikel', 'Product page'); pass `importPageIds` to move mis-grouped pages INTO `clusterKey`. Prefer ONE call with all corrections over many single-page calls. Use after `list_import_page_clusters`; the confirmed clusters drive template creation.",
  schema: assignInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId", "clusterKey"],
    properties: {
      runId: { type: "string", format: "uuid" },
      clusterKey: { type: "string", minLength: 1, maxLength: 200 },
      importPageIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        description: "Pages to MOVE into clusterKey (bulk re-assign).",
      },
      label: { type: "string", minLength: 1, maxLength: 120 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.assign_page_cluster",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `assign_import_page_cluster failed: ${describeError(r.error)}` };
    }
    const v = r.value as { reassigned: number; labelled: number };
    return {
      ok: true,
      content: `Cluster ${input.clusterKey}: ${v.reassigned} page(s) re-assigned, ${v.labelled} labelled${input.label ? ` as "${input.label}"` : ""}.`,
    };
  },
};
