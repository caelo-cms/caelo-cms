// SPDX-License-Identifier: MPL-2.0

/**
 * PR #295 review — ownership gate for `subagent_runs.finish`.
 *
 * Finishing a run is not just a metadata stamp: it force-releases every
 * entity lease held by the run's subagent session (issue #264). Without
 * an ownership check, any AI actor that learns a rival orchestrator's
 * run id could finish that run and steal its leases mid-write. Human and
 * system actors keep the broader rights the neighbouring subagent ops
 * already grant them (Owner observability / cleanup surfaces); an AI
 * actor may only finish runs it is entitled to:
 *
 *   - the run's own subagent session (`ctx.chatTaskId` — the caller's
 *     OWN chat session id — matches `subagent_chat_session_id`), or
 *   - the parent orchestrator session that spawned it (`ctx.chatTaskId`
 *     matches `parent_chat_session_id` — the actual runtime path: the
 *     `spawn_subagent` tool finishes its children from the parent turn).
 *
 * Kept pure (no tx, no ctx object) so the allow/deny branches are
 * exhaustively unit-testable without a Postgres — see
 * `finish-authorization.test.ts`.
 */

import type { ActorKind } from "@caelo-cms/shared";

/** The ownership-relevant columns of a `subagent_runs` row. */
export interface FinishRunOwnership {
  id: string;
  subagentChatSessionId: string;
  parentChatSessionId: string | null;
}

/** Allow, or deny with an AI-actionable message (CLAUDE.md §11). */
export type FinishRunAuthzResult = { allowed: true } | { allowed: false; message: string };

/**
 * Decide whether the caller may finish the given subagent run.
 *
 * @param actorKind the caller's actor kind; `human` / `system` are always
 *   allowed, every other kind must prove session ownership
 * @param callerSessionId the caller's own chat session id
 *   (`ctx.chatTaskId`), or null when the call carries no chat identity —
 *   a non-human/system caller without one is denied (fail closed)
 * @param run the run row's ownership columns
 */
export function evaluateFinishRunAuthorization(
  actorKind: ActorKind,
  callerSessionId: string | null,
  run: FinishRunOwnership,
): FinishRunAuthzResult {
  if (actorKind === "human" || actorKind === "system") {
    return { allowed: true };
  }
  if (
    callerSessionId !== null &&
    (callerSessionId === run.subagentChatSessionId ||
      (run.parentChatSessionId !== null && callerSessionId === run.parentChatSessionId))
  ) {
    return { allowed: true };
  }
  return {
    allowed: false,
    message:
      `subagent run ${run.id} belongs to subagent session ${run.subagentChatSessionId}` +
      (run.parentChatSessionId
        ? ` (spawned by orchestrator session ${run.parentChatSessionId})`
        : " (no parent session)") +
      `; your session is ${callerSessionId ?? "<none>"}. An AI actor may only finish its own ` +
      `run or a run it spawned — finishing someone else's run would force-release their entity ` +
      `leases. Use subagent_runs.list({ parentChatSessionId: <your session id> }) to find the ` +
      `runs you own.`,
  };
}
