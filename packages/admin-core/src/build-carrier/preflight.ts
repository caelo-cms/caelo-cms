// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — the refusals a carried build can tell at once, before its
 * order is written and its carrier started (a job's cold start takes
 * seconds): a chat that is not the caller's open chat, a target that does
 * not exist, production for anyone but a person, nothing staged to publish,
 * a quality check that keeps Publish live closed, a proposal no longer
 * pending, a publish-anyway the failed check does not allow.
 *
 * Each check is the op's own first refusal, in the op's words (or the same
 * read the op makes). The op still checks everything when it runs, so a
 * refusal missing here costs the wait, never the decision.
 */

import { execute, type QueryError } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { productionNeedsHuman } from "../ops/deploy-common.js";
import type { AdminJobDeps } from "../reporting-jobs/kind.js";
import { selectStageChats } from "../stage/stage-chats.js";
import type { BuildOrder, BuildOutcome } from "./order.js";

interface Target {
  readonly name: string;
  readonly env: string;
}

function refused(operation: string, message: string): BuildOutcome {
  return { ok: false, error: { kind: "HandlerError", operation, message } };
}

/** Run a read op as the caller; a failure is the outcome. */
async function read<T>(
  deps: AdminJobDeps,
  ctx: ExecutionContext,
  name: string,
  input: unknown,
): Promise<{ ok: true; value: T } | { ok: false; outcome: BuildOutcome }> {
  const r = await execute(deps.registry, deps.adapter, ctx, name, input);
  if (!r.ok) return { ok: false, outcome: { ok: false, error: r.error as QueryError } };
  return { ok: true, value: r.value as T };
}

async function targets(
  deps: AdminJobDeps,
  ctx: ExecutionContext,
): Promise<{ ok: true; value: readonly Target[] } | { ok: false; outcome: BuildOutcome }> {
  const r = await read<{ targets: Target[] }>(deps, ctx, "deploy.list_targets", {});
  return r.ok ? { ok: true, value: r.value.targets } : r;
}

const asString = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * The outcome `order` would end with at once, or null when it is worth
 * ordering (see the file comment).
 */
export async function preflightBuild(
  deps: AdminJobDeps,
  ctx: ExecutionContext,
  order: BuildOrder,
): Promise<BuildOutcome | null> {
  switch (order.kind) {
    case "stage": {
      const selected = await selectStageChats(deps, ctx, order.input.chatSessionIds);
      return selected.ok ? null : { ok: false, error: selected.error };
    }
    case "deploy.trigger": {
      // Without a name the op builds the default target; it resolves that.
      const name = asString(order.input.targetName);
      if (name === null) return null;
      const all = await targets(deps, ctx);
      if (!all.ok) return all.outcome;
      const target = all.value.find((t) => t.name === name);
      if (!target) return refused("deploy.trigger", `target not found: ${name}`);
      const human = productionNeedsHuman(ctx, target.env, "deploy.trigger");
      return human ? { ok: false, error: human } : null;
    }
    case "deploy.promote": {
      const from = asString(order.input.fromTarget);
      const to = asString(order.input.toTarget);
      if (from === null || to === null) return null;
      if (from === to) return refused("deploy.promote", "fromTarget and toTarget must differ");
      const all = await targets(deps, ctx);
      if (!all.ok) return all.outcome;
      const source = all.value.find((t) => t.name === from);
      const destination = all.value.find((t) => t.name === to);
      if (!source || !destination) {
        return refused("deploy.promote", "fromTarget or toTarget not found");
      }
      const human = productionNeedsHuman(ctx, destination.env, "deploy.promote");
      if (human) return { ok: false, error: human };
      if (source.env !== "staging") return null;
      // The same read as Publish live's gate (#553): nothing staged, or a
      // quality check that keeps it closed.
      const gate = await read<{
        deployRunId: string | null;
        gate: { open: boolean; message: string } | null;
      }>(deps, ctx, "quality_audits.gate_status", { fromTarget: from });
      if (!gate.ok) return gate.outcome;
      if (gate.value.deployRunId === null) {
        return refused(
          "deploy.promote",
          `no succeeded build to promote from '${from}' — run Stage first (deploy.trigger targetName=${from}); Publish live only copies an already-staged build`,
        );
      }
      const g = gate.value.gate;
      if (g && !g.open && order.input.publishAnyway === undefined) {
        return refused("deploy.promote", g.message);
      }
      return null;
    }
    case "deploy.execute_proposal": {
      const proposalId = asString(order.input.proposalId);
      if (proposalId === null) return null;
      const pending = await read<{ proposals: { id: string }[] }>(
        deps,
        ctx,
        "deploy.list_pending",
        { proposalId, limit: 1 },
      );
      if (!pending.ok) return pending.outcome;
      return pending.value.proposals.some((p) => p.id === proposalId)
        ? null
        : refused(
            "deploy.execute_proposal",
            "this proposal is no longer pending (it was applied, rejected or replaced meanwhile) — reload the queue to see what happened to it",
          );
    }
    case "quality_audits.publish_anyway": {
      // The decision's own first step, as the op runs it.
      const checked = await read<unknown>(
        deps,
        ctx,
        "quality_audits.check_publish_anyway",
        order.input,
      );
      return checked.ok ? null : checked.outcome;
    }
    case "quality_audits.execute_proposal":
      // Its page checks the proposal is pending before it asks.
      return null;
  }
}
