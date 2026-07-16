// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.19 — `propose_deploy_promote` + `propose_deploy_rollback` AI tools.
 * Wrap `deploy.propose_promote` / `deploy.propose_rollback` (CLAUDE.md §11.A
 * propose/execute pattern).
 *
 * Production promote (staging → production) is the most-asked-for AI action
 * that affects visitor traffic. Direct AI execute would violate §11.A; instead
 * the AI queues a proposal with a computed preview (build id, page count, file
 * count) and the operator approves on the chat's proposal card.
 *
 * Built with `makeProposeTool`: the factory renders the canonical
 * `Queued proposal <uuid>: <summary>.` shape that the chat's ProposeCard parser
 * (`apps/admin/src/lib/components/chat/proposal-parser.ts`) matches, and owns
 * the two-step contract wording — so neither can drift out of a hand-copy here.
 */

import { z } from "zod";
import { makeProposeTool } from "./_make-propose-tool.js";

const inputSchema = z
  .object({
    fromTarget: z.string().min(1).max(80),
    toTarget: z.string().min(1).max(80),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const proposeDeployPromoteTool = makeProposeTool<Input>({
  toolName: "propose_deploy_promote",
  opName: "deploy.propose_promote",
  pendingQueuePath: "/security/deployments/pending",
  when:
    "Propose promoting one deploy target's latest succeeded build into another target (typically staging → production). " +
    "The preview carries sourceBuildId, pageCount, fileCount — restate them to the operator. " +
    "Use when the operator says 'ship to production', 'go live', 'promote staging'. " +
    "The fromTarget needs at least one succeeded build (run `deploy.trigger` for staging first if not).",
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
  summarize: (input, preview) => {
    const p = preview as { sourceBuildId?: string; pageCount?: number; fileCount?: number };
    return (
      `promote ${input.fromTarget} → ${input.toTarget} ` +
      `(build=${p.sourceBuildId}, pages=${p.pageCount}, files=${p.fileCount})`
    );
  },
});

const rollbackInputSchema = z
  .object({
    target: z.string().min(1).max(80),
  })
  .strict();

type RollbackInput = z.infer<typeof rollbackInputSchema>;

export const proposeDeployRollbackTool = makeProposeTool<RollbackInput>({
  toolName: "propose_deploy_rollback",
  opName: "deploy.propose_rollback",
  pendingQueuePath: "/security/deployments/pending",
  when:
    "Propose rolling back one deploy target to its previous succeeded build. " +
    "Use when the operator says 'roll back', 'revert prod', 'undo last deploy'.",
  schema: rollbackInputSchema,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["target"],
    properties: {
      target: { type: "string", minLength: 1, maxLength: 80 },
    },
  },
  summarize: (input, preview) => {
    const p = preview as { currentBuildId?: string; restoreBuildId?: string };
    return `rollback ${input.target} (${p.currentBuildId} → ${p.restoreBuildId})`;
  },
});
