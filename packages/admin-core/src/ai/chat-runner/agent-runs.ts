// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #664 — Stop has to reach the turn wherever it runs.
 *
 * Stop used to be the browser aborting its fetch, relayed to the runner as
 * `request.signal`. Behind Cloud Run that signal never fired: on 2026-10-12
 * a stopped turn ran on for 8 more provider steps (incl. `build_page` and
 * `stage_changes`), and the auto-sent messages queued behind it started
 * three more turns. A client disconnect also only ever reaches the one
 * instance holding that request.
 *
 * So every turn and subagent registers a row in `chat_agent_runs` (0255)
 * and runs under an {@link AgentRunHandle} whose `signal` aborts when the
 * operator presses Stop:
 *
 *  - on THIS instance at once — the Stop endpoint calls
 *    {@link abortLocalAgentRuns} with the run ids the cancel op flagged;
 *  - on ANY instance within one poll — the handle renews its row every
 *    second and the renewal reports `cancel_requested_at`.
 *
 * The signal feeds the turn serializer's wait (a queued turn is dropped
 * before it persists anything), the provider stream, every tool dispatch
 * and the subagents the turn spawned.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

/** What a turn / subagent registers as. */
export interface AgentRunRegistration {
  readonly chatSessionId: string;
  readonly kind: "turn" | "subagent";
  readonly source: "live_edit" | "mcp_chat" | "subagent";
  readonly label: string;
  readonly parentRunId?: string;
  /** The chat's Stop count when the request arrived (refused if a Stop came since). */
  readonly stopEpochAtArrival?: number;
  /** The operator's own message (or Approve/Reject click) in this chat. */
  readonly operatorInitiated: boolean;
}

/** Persistence the handle needs — the `chat.*_agent_run` ops, or a test double. */
export interface AgentRunStore {
  register(reg: AgentRunRegistration): Promise<
    | { ok: true; registered: true; runId: string }
    | {
        ok: true;
        registered: false;
        reason: "stopped" | "external_agent" | "parent_cancelled";
        message: string;
      }
    | { ok: false; message: string }
  >;
  heartbeat(args: {
    runId: string;
    state?: "running";
  }): Promise<{ ok: true; cancelRequested: boolean } | { ok: false; message: string }>;
  finish(runId: string): Promise<void>;
}

const describe = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : JSON.stringify(e);

/** The store backed by the `chat.*_agent_run` Query API ops. */
export function queryApiAgentRunStore(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
): AgentRunStore {
  return {
    async register(reg) {
      const r = await execute(registry, adapter, ctx, "chat.register_agent_run", {
        chatSessionId: reg.chatSessionId,
        kind: reg.kind,
        source: reg.source,
        label: reg.label,
        ...(reg.parentRunId ? { parentRunId: reg.parentRunId } : {}),
        ...(reg.stopEpochAtArrival !== undefined
          ? { stopEpochAtArrival: reg.stopEpochAtArrival }
          : {}),
        operatorInitiated: reg.operatorInitiated,
      });
      if (!r.ok) return { ok: false, message: describe(r.error) };
      const v = r.value as
        | { registered: true; runId: string }
        | {
            registered: false;
            reason: "stopped" | "external_agent" | "parent_cancelled";
            message: string;
          };
      return v.registered
        ? { ok: true, registered: true, runId: v.runId }
        : { ok: true, registered: false, reason: v.reason, message: v.message };
    },
    async heartbeat(args) {
      const r = await execute(registry, adapter, ctx, "chat.heartbeat_agent_run", {
        runId: args.runId,
        ...(args.state ? { state: args.state } : {}),
      });
      if (!r.ok) return { ok: false, message: describe(r.error) };
      return {
        ok: true,
        cancelRequested: (r.value as { cancelRequested: boolean }).cancelRequested,
      };
    },
    async finish(runId) {
      const r = await execute(registry, adapter, ctx, "chat.finish_agent_run", { runId });
      if (!r.ok) {
        // The row expires after its TTL; the list then drops it.
        console.error("[chat-runner] agent run finish failed");
      }
    },
  };
}

/**
 * The chat's Stop count right now — read when a request ARRIVES, before
 * anything slow, and handed to the turn's registration (see
 * `stopEpochAtArrival`).
 */
export async function readAgentStopEpoch(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  chatSessionId: string,
): Promise<number | undefined> {
  const r = await execute(registry, adapter, ctx, "chat.get_agent_stop_epoch", { chatSessionId });
  // Unknown chat: registration fails loudly with the same reason later.
  return r.ok ? (r.value as { epoch: number }).epoch : undefined;
}

/** Error the handle's signal aborts with — lets callers tell Stop from a disconnect. */
export class OperatorStoppedError extends Error {
  constructor() {
    super("stopped by the operator");
    this.name = "OperatorStoppedError";
  }
}

/** True when `signal` aborted because the operator pressed Stop. */
export function stoppedByOperator(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason instanceof OperatorStoppedError;
}

const localRuns = new Map<string, AbortController>();

/**
 * Abort the runs of this admin process among `runIds` right away (the Stop
 * endpoint's fast path; other instances notice on their next heartbeat).
 *
 * @returns how many of them ran here.
 */
export function abortLocalAgentRuns(runIds: readonly string[]): number {
  let n = 0;
  for (const id of runIds) {
    const c = localRuns.get(id);
    if (c && !c.signal.aborted) {
      c.abort(new OperatorStoppedError());
      n += 1;
    }
  }
  return n;
}

/** A registered run. */
export interface AgentRunHandle {
  readonly runId: string;
  /** Aborts (with {@link OperatorStoppedError}) when the operator pressed Stop. */
  readonly signal: AbortSignal;
  /** The turn got the chat: queued → running. */
  markRunning(): Promise<void>;
  /** The run ended: stop polling and drop the row. Idempotent. */
  finish(): Promise<void>;
}

/** Outcome of {@link startAgentRun}. */
export type StartAgentRunResult =
  | { kind: "started"; handle: AgentRunHandle }
  | {
      kind: "refused";
      reason: "stopped" | "external_agent" | "parent_cancelled";
      message: string;
    }
  | { kind: "failed"; message: string };

function cancelPollMs(): number {
  const raw = process.env.CAELO_AGENT_CANCEL_POLL_MS;
  if (raw === undefined) return 1_000;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `CAELO_AGENT_CANCEL_POLL_MS must be a positive integer of milliseconds, got "${raw}"`,
    );
  }
  return parsed;
}

/**
 * Register a turn / subagent and start watching for Stop. On `started` the
 * caller must `await handle.finish()` when the run ends (in a `finally`).
 */
export async function startAgentRun(args: {
  store: AgentRunStore;
  registration: AgentRunRegistration;
  pollMs?: number;
}): Promise<StartAgentRunResult> {
  const { store, registration } = args;
  const reg = await store.register(registration);
  if (!reg.ok) {
    return {
      kind: "failed",
      message: `Could not record the AI's work in this chat (${reg.message}). Nothing was sent; send the message again.`,
    };
  }
  if (!reg.registered) return { kind: "refused", reason: reg.reason, message: reg.message };

  const runId = reg.runId;
  const controller = new AbortController();
  localRuns.set(runId, controller);
  const stop = (): void => {
    if (!controller.signal.aborted) controller.abort(new OperatorStoppedError());
  };
  let polling = false;
  const poll = setInterval(() => {
    if (polling || controller.signal.aborted) return;
    polling = true;
    store
      .heartbeat({ runId })
      .then((r) => {
        if (r.ok && r.cancelRequested) stop();
        // A failed renewal is retried on the next tick; the row's TTL is
        // thirty polls long.
      })
      .catch(() => undefined)
      .finally(() => {
        polling = false;
      });
  }, args.pollMs ?? cancelPollMs());

  let finished = false;
  return {
    kind: "started",
    handle: {
      runId,
      signal: controller.signal,
      async markRunning() {
        const r = await store.heartbeat({ runId, state: "running" });
        if (r.ok && r.cancelRequested) stop();
      },
      async finish() {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        localRuns.delete(runId);
        await store.finish(runId).catch(() => undefined);
      },
    },
  };
}
