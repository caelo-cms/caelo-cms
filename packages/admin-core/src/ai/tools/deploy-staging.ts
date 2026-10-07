// SPDX-License-Identifier: MPL-2.0

/**
 * `deploy_staging` — rebuild the STAGING site from what is published on
 * main (`deploy.trigger`). The AI-facing half of the operator's "Deploy"
 * button on the Ops board.
 *
 * Staging only, by construction: the tool resolves its target from the
 * staging-env rows of `deploy.list_targets` and never lets the model name
 * a production target, and `deploy.trigger` itself refuses an AI actor on
 * a production target (defense in depth — the Power-MCP surface and any
 * future caller hit the same wall). Production stays §11.A-gated through
 * `propose_deploy_promote`.
 *
 * The build reads committed main state, so a chat's unpublished preview
 * changes are NOT in it — the description says so, so the AI never claims
 * "your edits are on staging" after this call.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const deployStagingInput = z
  .object({
    targetName: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        "Name of the staging target to rebuild. Omit it when the site has one staging target (the usual case).",
      ),
  })
  .strict();

type DeployStagingInput = z.infer<typeof deployStagingInput>;

interface TargetRow {
  readonly name: string;
  readonly env: "dev" | "staging" | "production";
}

interface TriggerResult {
  readonly runId: string;
  readonly targetName: string;
  readonly pageCount: number;
  readonly fileCount: number;
  readonly durationMs: number;
  readonly previewUrl?: string;
}

export const deployStagingTool: ToolDefinitionWithHandler<DeployStagingInput> = {
  name: "deploy_staging",
  description:
    "Rebuild the STAGING site (noindex, never visitor-facing) from what is currently published, and return the build's run id, page/file counts and preview URL. " +
    "Use it when staging has to reflect the published site: before `propose_deploy_promote` when staging has no successful build yet (or an outdated one), after fixing a failed build (e.g. after `regenerate_media_variants`), or when the operator asks to refresh staging. " +
    "It builds PUBLISHED content only — this chat's unpublished preview changes are not in the build until the operator publishes them, so never tell the operator their pending edits are on staging. " +
    "Production is not reachable here: to go live, call `propose_deploy_promote` (staging → production) and let the operator approve. " +
    "A failed build returns the generator's error — fix the named cause and call again; do not retry unchanged.",
  schema: deployStagingInput,
  handler: async (ctx, input, toolCtx) => {
    const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "deploy.list_targets", {});
    if (!listed.ok) {
      return {
        ok: false,
        content: `deploy.list_targets failed: ${describeError(listed.error)}`,
      };
    }
    const targets = (listed.value as { targets: TargetRow[] }).targets;
    const staging = targets.filter((t) => t.env === "staging");
    const stagingNames = staging.map((t) => t.name).join(", ") || "(none)";
    let targetName: string;
    if (input.targetName !== undefined) {
      const named = targets.find((t) => t.name === input.targetName);
      if (named?.env !== "staging") {
        return {
          ok: false,
          content:
            `"${input.targetName}" is not a staging target — deploy_staging rebuilds staging only. ` +
            `Staging targets: ${stagingNames}. To go live, call propose_deploy_promote instead.`,
        };
      }
      targetName = named.name;
    } else if (staging.length === 1 && staging[0]) {
      targetName = staging[0].name;
    } else if (staging.length === 0) {
      return {
        ok: false,
        content:
          "This site has no staging deploy target configured, so there is nothing to rebuild. Tell the operator staging is not set up (Ops → Deployments); do not deploy anywhere else.",
      };
    } else {
      return {
        ok: false,
        content: `Several staging targets exist (${stagingNames}) — call deploy_staging again with targetName set to one of them.`,
      };
    }

    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "deploy.trigger", {
      targetName,
    });
    if (!r.ok) {
      return {
        ok: false,
        content: `Staging build for "${targetName}" failed: ${describeError(r.error)}`,
      };
    }
    const v = r.value as TriggerResult;
    const preview = v.previewUrl ? ` Preview: ${v.previewUrl}.` : "";
    return {
      ok: true,
      content:
        `Staging "${v.targetName}" rebuilt (run ${v.runId}): ${v.pageCount} page(s), ${v.fileCount} file(s) in ${Math.round(v.durationMs / 1000)}s.${preview} ` +
        "Only published content is included. To go live, call propose_deploy_promote.",
      value: v,
    };
  },
};
