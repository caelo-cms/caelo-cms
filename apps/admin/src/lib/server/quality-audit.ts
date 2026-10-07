// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the Stage flow's hooks into the quality gate. Every action
 * that builds staging calls `enqueueStagingAudit` once the build succeeded;
 * the chat Stage additionally classifies its branch BEFORE the merge
 * (`classifyChatStage`), because afterwards "did this module's code change"
 * can no longer be told from the live tables.
 *
 * A failed enqueue never undoes the staging deploy — the build is real and
 * the operator can preview it — but it is logged loudly, and the run then
 * visibly has no audit record in the quality read surfaces.
 */

import { kickQualityAuditWorker } from "@caelo-cms/admin-core";
import { execute, type QueryError } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { getQueryContext } from "./query.js";

/** `quality_audits.classify_stage` output, carried to the enqueue. */
export interface ChatStageClassification {
  readonly classification: {
    readonly auditNeeded: boolean;
    readonly reasons: readonly { rule: string; entityId: string | null; label: string }[];
    readonly skipped: readonly string[];
  };
  readonly touchedPageIds: readonly string[];
}

/** Classify a chat's pending changes. Call BEFORE `chat.merge_to_main`. */
export async function classifyChatStage(
  ctx: ExecutionContext,
  chatSessionId: string,
): Promise<{ ok: true; value: ChatStageClassification } | { ok: false; error: QueryError }> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, "quality_audits.classify_stage", {
    chatSessionId,
  });
  return r.ok
    ? { ok: true, value: r.value as ChatStageClassification }
    : { ok: false, error: r.error };
}

/**
 * Record the quality audit decision for a succeeded deploy run and wake the
 * worker. Deploy runs on non-staging targets are ignored (only staging is
 * audited). Never throws.
 *
 * @param args.chatSessionId - the chat that staged, with its pre-merge
 *   classification; both null for staging deploys outside a chat.
 */
export async function enqueueStagingAudit(
  ctx: ExecutionContext,
  args: {
    readonly deployRunId: string;
    readonly targetName: string;
    readonly chatSessionId: string | null;
    readonly branch: ChatStageClassification | null;
    /** Pages staged on purpose outside a chat (audited after the homepage). */
    readonly pageIds?: readonly string[];
  },
): Promise<void> {
  const { adapter, registry } = getQueryContext();
  try {
    const targets = await execute(registry, adapter, ctx, "deploy.list_targets", {});
    if (!targets.ok) {
      console.error("[quality-audit] could not read deploy targets", targets.error);
      return;
    }
    const env = (targets.value as { targets: { name: string; env: string }[] }).targets.find(
      (t) => t.name === args.targetName,
    )?.env;
    if (env !== "staging") return;
    const r = await execute(registry, adapter, ctx, "quality_audits.enqueue", {
      deployRunId: args.deployRunId,
      chatSessionId: args.chatSessionId,
      branch: args.branch,
      pageIds: args.pageIds ?? [],
    });
    if (!r.ok) {
      console.error("[quality-audit] enqueue failed — this staging run has no audit", {
        deployRunId: args.deployRunId,
        error: r.error,
      });
      return;
    }
    kickQualityAuditWorker();
  } catch (e) {
    console.error("[quality-audit] enqueue threw — this staging run has no audit", {
      deployRunId: args.deployRunId,
      error: e,
    });
  }
}
