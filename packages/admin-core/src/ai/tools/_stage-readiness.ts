// SPDX-License-Identifier: MPL-2.0

/**
 * The stage-readiness suffix the page tools append to a successful result
 * (deploy/stage-readiness.ts): when a Stage would be refused right now —
 * nothing published, nothing at '/', a page without a meta description —
 * the AI reads it in the result of the write that created the state, not
 * in a failed `stage_changes` at the end of the turn.
 *
 * Silent when a Stage would build, and when the read itself fails: the
 * note is advice on top of a write that already succeeded, and the build
 * keeps its own checks.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeStageReadiness, type StageReadiness } from "../../deploy/stage-readiness.js";
import type { ToolContext } from "./dispatch.js";

/**
 * Read `deploy.stage_readiness` in the tool's context and render it as a
 * result suffix: ` ⚠️ A Stage would be refused right now: …` or "".
 */
export async function stageReadinessSuffix(
  ctx: ExecutionContext,
  toolCtx: Pick<ToolContext, "registry" | "adapter">,
): Promise<string> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "deploy.stage_readiness", {});
  if (!r.ok) {
    console.error(
      "[stage-readiness] read failed — the tool result carries no readiness note",
      r.error,
    );
    return "";
  }
  const note = describeStageReadiness(r.value as StageReadiness);
  return note === null ? "" : ` ⚠️ ${note}`;
}
