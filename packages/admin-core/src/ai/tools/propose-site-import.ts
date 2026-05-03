// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — `propose_site_import`. AI proposes a crawl; row queues at
 * `import_runs.status='proposed'`. Owner approves at
 * /security/import/pending; only then does the worker pick it up. AI
 * cannot start an unauthenticated headless crawl on its own.
 */

import { execute } from "@caelo/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const proposeSiteImportInput = z
  .object({
    sourceUrl: z.string().url(),
    depth: z.number().int().min(1).max(5).default(2),
    maxPages: z.number().int().min(1).max(500).default(50),
  })
  .strict();

export type ProposeSiteImportInput = z.infer<typeof proposeSiteImportInput>;

export const proposeSiteImportTool: ToolDefinitionWithHandler<ProposeSiteImportInput> = {
  name: "propose_site_import",
  description:
    "TWO-STEP: propose a crawl of an existing site to import pages into Caelo. " +
    "This QUEUES the proposal at /security/import/pending — Owner must Approve before " +
    "the headless crawler runs. DO NOT claim the crawl ran. Use this when the user " +
    "asks to bring an existing site into Caelo. `depth` defaults to 2 (BFS hops); " +
    "`maxPages` defaults to 50.",
  schema: proposeSiteImportInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sourceUrl"],
    properties: {
      sourceUrl: { type: "string", format: "uri" },
      depth: { type: "integer", minimum: 1, maximum: 5 },
      maxPages: { type: "integer", minimum: 1, maximum: 500 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "imports.propose_run", input);
    if (!r.ok) {
      return { ok: false, content: `propose_site_import failed: ${describeError(r.error)}` };
    }
    const v = r.value as { runId: string };
    return {
      ok: true,
      content: `Queued import proposal ${v.runId} for ${input.sourceUrl} (depth=${input.depth ?? 2}, max=${input.maxPages ?? 50}). Tell the user to review at /security/import/pending.`,
    };
  },
};
