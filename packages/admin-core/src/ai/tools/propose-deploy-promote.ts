// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.19 — `propose_deploy_promote` AI tool. Wraps
 * `deploy.propose_promote` (CLAUDE.md §11.A propose/execute pattern).
 *
 * Production promote (staging → production) is the most-asked-for AI
 * action that affects visitor traffic. Direct AI execute would
 * violate §11.A; instead the AI queues a proposal with a computed
 * preview (build id, page count, file count) and tells the operator
 * to click Approve at /security/deployments/pending.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const inputSchema = z
  .object({
    fromTarget: z.string().min(1).max(80),
    toTarget: z.string().min(1).max(80),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const proposeDeployPromoteTool: ToolDefinitionWithHandler<Input> = {
  name: "propose_deploy_promote",
  description:
    "Propose promoting one deploy target's latest succeeded build into another target (typically staging → production). " +
    "TWO-STEP: this only QUEUES the proposal; an Owner must click Approve at /security/deployments/pending to apply. " +
    "DO NOT claim the deploy is live. The tool returns a proposalId + preview (sourceBuildId, pageCount, fileCount); " +
    "tell the operator to approve at the pending queue. Use when the operator says 'ship to production', 'go live', " +
    "'promote staging'. The fromTarget needs at least one succeeded build (run `deploy.trigger` for staging first if not).",
  schema: inputSchema,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["fromTarget", "toTarget"],
    properties: {
      fromTarget: { type: "string", minLength: 1, maxLength: 80 },
      toTarget: { type: "string", minLength: 1, maxLength: 80 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "deploy.propose_promote",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `deploy.propose_promote failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      proposalId: string;
      preview: { sourceBuildId: string; pageCount: number; fileCount: number };
    };
    return {
      ok: true,
      content:
        `Queued promote proposal ${v.proposalId}: ${input.fromTarget} → ${input.toTarget} ` +
        `(build=${v.preview.sourceBuildId}, pages=${v.preview.pageCount}, files=${v.preview.fileCount}). ` +
        `An Owner must click Approve at /security/deployments/pending to apply.`,
    };
  },
};

const rollbackInputSchema = z
  .object({
    target: z.string().min(1).max(80),
  })
  .strict();

type RollbackInput = z.infer<typeof rollbackInputSchema>;

export const proposeDeployRollbackTool: ToolDefinitionWithHandler<RollbackInput> = {
  name: "propose_deploy_rollback",
  description:
    "Propose rolling back one deploy target to its previous succeeded build. " +
    "TWO-STEP: this only QUEUES; an Owner must click Approve at /security/deployments/pending. " +
    "DO NOT claim the rollback happened. Use when the operator says 'roll back', 'revert prod', 'undo last deploy'.",
  schema: rollbackInputSchema,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["target"],
    properties: {
      target: { type: "string", minLength: 1, maxLength: 80 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "deploy.propose_rollback",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `deploy.propose_rollback failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      proposalId: string;
      preview: { currentBuildId: string; restoreBuildId: string };
    };
    return {
      ok: true,
      content:
        `Queued rollback proposal ${v.proposalId}: ${input.target} ` +
        `(${v.preview.currentBuildId} → ${v.preview.restoreBuildId}). ` +
        `An Owner must click Approve at /security/deployments/pending to apply.`,
    };
  },
};
