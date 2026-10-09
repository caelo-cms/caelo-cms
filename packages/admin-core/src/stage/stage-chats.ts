// SPDX-License-Identifier: MPL-2.0

/**
 * The Stage flow, for one chat or a selection of chats (issue #620 Part C —
 * the Open changes overview's "Stage all" / "Stage selected"; /edit's Stage
 * button is the one-chat case).
 *
 *   1. quality_audits.classify_stage per unit — BEFORE any merge: once the
 *      live rows hold the branch state, "did this module's code change"
 *      can no longer be told (#553). It returns the exact snapshot headers
 *      it classified.
 *   2. chat.merge_draft_to_main / chat.merge_to_main (deferConsume) per
 *      unit — merges EXACTLY the classified headers, so a change committed
 *      in between never reaches the build unaudited. When a classified
 *      header was undone or staged meanwhile the merge refuses ("Conflict:
 *      …") and that unit is classified and merged again.
 *   3. deploy.trigger(staging) ONCE — a full-site rebuild of the merged
 *      main state (one build for the whole selection, not one per chat).
 *   4. chat.finalize_draft_stage / chat.finalize_stage per unit — only
 *      after the build succeeded: marks exactly the merged headers staged
 *      and releases locks. A failed build consumes nothing, so every chat
 *      stays pending and Stage stays retryable (run #8 R6).
 *   5. quality_audits.enqueue — one audit for the build, with the chats'
 *      classifications combined.
 *
 * A merge that fails midway leaves the chats merged before it in main but
 * unconsumed; a retry re-merges them (merge is idempotent) and then the
 * rest. Nothing reaches production here — Publish live is a separate,
 * human step behind the #553 quality gate.
 */

import type { DatabaseAdapter, OperationRegistry, QueryError } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import type { AffectedChat } from "../draft.js";
import { STAGE_CHANGED_PREFIX } from "../ops/chat/publish.js";
import { kickQualityAuditWorker } from "../quality/audit-worker.js";

/** Registry + adapter the flow executes ops through. */
export interface StageFlowDeps {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
}

/** How often a unit is classified again when its changes moved on mid-Stage. */
const MAX_STAGE_ATTEMPTS = 3;

/** `quality_audits.classify_stage` output, carried to the enqueue. */
export interface ChatStageClassification {
  readonly classification: {
    readonly auditNeeded: boolean;
    readonly reasons: readonly { rule: string; entityId: string | null; label: string }[];
    readonly skipped: readonly string[];
  };
  readonly touchedPageIds: readonly string[];
}

/** What one Stage did, per chat and for the shared build. */
export interface StagedChats {
  readonly runId: string;
  readonly targetName: string;
  readonly buildId: string;
  readonly pageCount: number;
  readonly fileCount: number;
  /** Provider-supplied preview URL (Firebase); absent elsewhere. */
  readonly previewUrl?: string;
  readonly mergedEntityCount: number;
  readonly brokenInternalLinks: readonly string[];
  /**
   * One entry per merge: the shared draft's selected chats together, each
   * isolated chat on its own.
   */
  readonly chats: readonly {
    readonly chatSessionIds: readonly string[];
    readonly entityCount: number;
  }[];
  /** Other chats whose draft changes rode along because they share an entity (issue #620). */
  readonly alsoIncludes: readonly AffectedChat[];
}

/** One merge of a Stage: the shared draft's chats, or one isolated chat. */
interface Unit {
  readonly draft: boolean;
  readonly chatSessionIds: readonly string[];
}

/** A Stage failure, with the step that failed and an operator-facing message. */
export interface StageFailure {
  readonly step: "select" | "classify" | "merge" | "deploy" | "finalize";
  readonly chatSessionId: string | null;
  readonly message: string;
  readonly error: QueryError;
}

/**
 * Combine per-chat classifications into the one the build's audit uses:
 * audited when any chat needs it, reasons and skips concatenated, touched
 * pages unioned (first-seen order, so each chat's own pages lead).
 */
export function combineStageClassifications(
  parts: readonly ChatStageClassification[],
): ChatStageClassification {
  const pages: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    for (const id of p.touchedPageIds) {
      if (!seen.has(id)) {
        seen.add(id);
        pages.push(id);
      }
    }
  }
  return {
    classification: {
      auditNeeded: parts.some((p) => p.classification.auditNeeded),
      reasons: parts.flatMap((p) => p.classification.reasons),
      skipped: [...new Set(parts.flatMap((p) => p.classification.skipped))],
    },
    touchedPageIds: pages,
  };
}

/**
 * Record the quality audit decision for a succeeded deploy run and wake the
 * worker. Deploy runs on non-staging targets are ignored (only staging is
 * audited). Never throws: a failed enqueue never undoes the staging deploy
 * (the build is real and previewable), but it is logged loudly and the run
 * then visibly has no audit record in the quality read surfaces.
 *
 * @param args.chatSessionId - the chat the audit's findings go to, with the
 *   pre-merge classification; both null for staging deploys outside a chat.
 */
export async function enqueueStagingAudit(
  deps: StageFlowDeps,
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
  const { adapter, registry } = deps;
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

/**
 * The link-integrity warnings of the final merged state. Each merge scans
 * main right after its own replay, so a link an earlier chat broke can be
 * fixed by a later chat's merge — only the LAST merge that changed anything
 * saw the state that is staged (a merge with nothing to replay leaves main
 * as it was and reports no scan).
 */
export function finalLinkWarnings(
  merges: readonly {
    readonly entityCount: number;
    readonly brokenInternalLinks: readonly string[];
  }[],
): string[] {
  const last = [...merges].reverse().find((m) => m.entityCount > 0);
  return last ? [...last.brokenInternalLinks] : [];
}

/**
 * Stage the given chats together: verify, classify, merge each, build
 * staging once, finalize each, queue one audit. Every chat must be an open
 * chat of the caller; the selection is checked before anything merges.
 *
 * @returns the shared build plus per-chat merge counts, or the first failure.
 */
export async function stageChatSessions(
  deps: StageFlowDeps,
  ctx: ExecutionContext,
  chatSessionIds: readonly string[],
  options: {
    /**
     * The AI initiated this Stage (stage_changes runs it with the
     * operator's context): the merges open the production hold.
     */
    readonly aiInitiated?: boolean;
  } = {},
): Promise<{ ok: true; value: StagedChats } | { ok: false; error: StageFailure }> {
  const { adapter, registry } = deps;
  const ids = [...new Set(chatSessionIds)];
  if (ids.length === 0) {
    throw new Error("stageChatSessions: no chat selected — the caller must pass at least one");
  }

  // Verify the whole selection BEFORE any merge: a refusal halfway would
  // leave the chats merged before it in main but unconsumed.
  const draftIds: string[] = [];
  const isolatedIds: string[] = [];
  for (const chatSessionId of ids) {
    const r = await execute(registry, adapter, ctx, "chat.get_session", { chatSessionId });
    const session = r.ok
      ? (
          r.value as {
            session: { publishedAt: string | null; archivedAt: string | null; branchKind: string };
          }
        ).session
      : null;
    if (!r.ok || !session || session.publishedAt !== null || session.archivedAt !== null) {
      return {
        ok: false,
        error: {
          step: "select",
          chatSessionId,
          message: `Chat ${chatSessionId} is not one of your open chats — only your own open chats can be staged; nothing was staged.`,
          error: r.ok
            ? { kind: "HandlerError", operation: "chat.get_session", message: "chat is closed" }
            : r.error,
        },
      };
    }
    (session.branchKind === "draft" ? draftIds : isolatedIds).push(chatSessionId);
  }
  // Issue #620 — the shared draft's chats are one unit (one selective
  // merge of exactly their changes); every isolated chat is its own unit.
  const units: Unit[] = [
    ...(draftIds.length > 0 ? [{ draft: true as const, chatSessionIds: draftIds }] : []),
    ...isolatedIds.map((id) => ({ draft: false as const, chatSessionIds: [id] })),
  ];

  type Classified = ChatStageClassification & { readonly headerIds: readonly string[] };
  const classify = async (
    unit: Unit,
  ): Promise<{ ok: true; value: Classified } | { ok: false; error: StageFailure }> => {
    const r = await execute(
      registry,
      adapter,
      ctx,
      "quality_audits.classify_stage",
      unit.draft
        ? { chatSessionIds: unit.chatSessionIds }
        : { chatSessionId: unit.chatSessionIds[0] },
    );
    if (!r.ok) {
      return {
        ok: false,
        error: {
          step: "classify",
          chatSessionId: unit.chatSessionIds[0] ?? null,
          message: `Could not check which quality audits this Stage needs — nothing was staged, try again: ${describeError(r.error)}`,
          error: r.error,
        },
      };
    }
    return { ok: true, value: r.value as Classified };
  };

  const classified: { unit: Unit; chatSessionId: string; value: Classified }[] = [];
  for (const unit of units) {
    const c = await classify(unit);
    if (!c.ok) return c;
    classified.push({ unit, chatSessionId: unit.chatSessionIds[0] ?? "", value: c.value });
  }

  const merged: {
    unit: Unit;
    entityCount: number;
    mergedAt: string;
    mergedHeaderIds: string[];
    brokenInternalLinks: string[];
    alsoIncludes: AffectedChat[];
  }[] = [];
  for (const entry of classified) {
    const { unit } = entry;
    let attempt = 1;
    for (;;) {
      const aiFlag = options.aiInitiated ? { aiInitiated: true } : {};
      const r = unit.draft
        ? await execute(registry, adapter, ctx, "chat.merge_draft_to_main", {
            chatSessionIds: unit.chatSessionIds,
            deferConsume: true,
            headerIds: entry.value.headerIds,
            ...aiFlag,
          })
        : await execute(registry, adapter, ctx, "chat.merge_to_main", {
            chatSessionId: unit.chatSessionIds[0],
            deferConsume: true,
            headerIds: entry.value.headerIds,
            ...aiFlag,
          });
      if (
        !r.ok &&
        r.error.kind === "HandlerError" &&
        r.error.message.startsWith(STAGE_CHANGED_PREFIX) &&
        attempt < MAX_STAGE_ATTEMPTS
      ) {
        // The unit's pending changes moved on between classification and
        // merge: classify the current set and merge exactly that.
        attempt += 1;
        const again = await classify(unit);
        if (!again.ok) return again;
        entry.value = again.value;
        continue;
      }
      if (!r.ok) {
        // issue #262 — stderr breadcrumb: the UI shows describeError()'s
        // stripped text; the full structured error only survives here.
        console.error("[stage] merge failed", {
          chatSessionIds: unit.chatSessionIds,
          error: r.error,
        });
        return {
          ok: false,
          error: {
            step: "merge",
            chatSessionId: unit.chatSessionIds[0] ?? null,
            message: `Merge to main failed: ${describeError(r.error)}`,
            error: r.error,
          },
        };
      }
      const v = r.value as {
        entityCount: number;
        mergedAt: string;
        mergedHeaderIds: string[];
        brokenInternalLinks: string[];
        alsoIncludes?: AffectedChat[];
      };
      merged.push({ unit, ...v, alsoIncludes: v.alsoIncludes ?? [] });
      break;
    }
  }

  const deployed = await execute(registry, adapter, ctx, "deploy.trigger", {
    targetName: "staging",
  });
  if (!deployed.ok) {
    // issue #262 — run #7's "silent no-op": keep this breadcrumb so a Stage
    // failure is ALWAYS visible in stderr. finalize is deliberately NOT
    // called — every chat stays pending and Stage stays retryable.
    console.error("[stage] deploy.trigger failed", { chatSessionIds: ids, error: deployed.error });
    return {
      ok: false,
      error: {
        step: "deploy",
        chatSessionId: null,
        message: `Staging build failed: ${describeError(deployed.error)}`,
        error: deployed.error,
      },
    };
  }

  for (const m of merged) {
    const r = m.unit.draft
      ? await execute(registry, adapter, ctx, "chat.finalize_draft_stage", {
          chatSessionIds: m.unit.chatSessionIds,
          stagedAt: m.mergedAt,
          headerIds: m.mergedHeaderIds,
        })
      : await execute(registry, adapter, ctx, "chat.finalize_stage", {
          chatSessionId: m.unit.chatSessionIds[0],
          stagedAt: m.mergedAt,
          headerIds: m.mergedHeaderIds,
        });
    if (!r.ok) {
      // The build shipped but the consumption markers didn't land; the
      // pending counters still show the changes. Retrying is safe (merge
      // is idempotent), so say that instead of claiming success.
      console.error("[stage] finalize failed", {
        chatSessionIds: m.unit.chatSessionIds,
        error: r.error,
      });
      return {
        ok: false,
        error: {
          step: "finalize",
          chatSessionId: m.unit.chatSessionIds[0] ?? null,
          message: `Staging deployed but the stage could not be finalized — stage again: ${describeError(r.error)}`,
          error: r.error,
        },
      };
    }
  }

  const summary = deployed.value as {
    runId: string;
    targetName: string;
    buildId: string;
    pageCount: number;
    fileCount: number;
    previewUrl?: string;
  };
  // The audit's findings go to one chat: the first selected chat whose
  // changes need an audit (else the first chat) — its fix-round counter
  // (#553 2-round cap) is the one this build advances.
  const feedbackChat =
    classified.find((c) => c.value.classification.auditNeeded)?.chatSessionId ??
    classified[0]?.chatSessionId ??
    null;
  await enqueueStagingAudit(deps, ctx, {
    deployRunId: summary.runId,
    targetName: summary.targetName,
    chatSessionId: feedbackChat,
    branch: combineStageClassifications(classified.map((c) => c.value)),
  });

  return {
    ok: true,
    value: {
      runId: summary.runId,
      targetName: summary.targetName,
      buildId: summary.buildId,
      pageCount: summary.pageCount,
      fileCount: summary.fileCount,
      ...(summary.previewUrl ? { previewUrl: summary.previewUrl } : {}),
      mergedEntityCount: merged.reduce((n, m) => n + m.entityCount, 0),
      brokenInternalLinks: finalLinkWarnings(merged),
      chats: merged.map((m) => ({
        chatSessionIds: m.unit.chatSessionIds,
        entityCount: m.entityCount,
      })),
      alsoIncludes: merged.flatMap((m) => m.alsoIncludes),
    },
  };
}
