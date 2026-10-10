// SPDX-License-Identifier: MPL-2.0

/**
 * One turn at a time per chat session — across every admin instance.
 *
 * A chat's history is an ordered conversation: every assistant `tool_use`
 * must be followed by its `tool_result` before the next user message. Two
 * turns running at once on the same session interleave their rows — e.g. a
 * quality fix-round nudge persisted while the running turn's `stage_changes`
 * was still executing landed BETWEEN that tool call and its result. The
 * provider rejects such a history ("tool_use ids were found without
 * tool_result blocks"), and because the rows are persisted, EVERY later turn
 * of that chat fails the same way (PR #624 real-AI run: the homepage chat
 * stopped answering after its second fix round).
 *
 * So a turn waits for the session's previous turn to finish before it
 * persists anything. Waiting (not refusing) keeps auto-sent messages — fix
 * rounds, import nudges — from being lost: they simply run next, on a
 * consistent history. Two layers:
 *
 *  1. An in-process FIFO queue per chat. Turns of one chat on the same
 *     instance run in arrival order, and only the queue's head talks to
 *     the database.
 *  2. A lease row per chat in `chat_turn_leases` (issue #628, migration
 *     0247) — the cross-instance guard. With several Cloud Run instances
 *     and no session affinity, a second turn can land on another instance
 *     where the in-process queue knows nothing of the first. The head of
 *     the local queue claims the lease, renews it on a heartbeat, and
 *     deletes it when the turn ends. A turn that cannot claim it polls
 *     until the lease is released or lapses, and gives up after a bounded
 *     wait with an error that says what to do.
 *
 * Abort and crash: the release runs in the caller's `finally`, so an
 * aborted turn frees the chat at once. A crashed (or frozen) instance stops
 * renewing; its lease lapses after the TTL and the next turn takes it over.
 * Should a live holder ever lose its lease that way (its heartbeat stalled
 * past the TTL), `hold.lost` aborts so the turn stops writing instead of
 * interleaving with the turn that took over.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

/** Default lease lifetime; renewed every quarter of it. */
export const DEFAULT_CHAT_TURN_LEASE_TTL_MS = 60_000;
/**
 * Default bound on how long a turn waits for the chat's running turn. Long
 * on purpose: a site-building turn runs for many minutes, and an auto-sent
 * fix round should queue behind it, not fail.
 */
export const DEFAULT_CHAT_TURN_WAIT_MS = 15 * 60_000;

/** The persistence the serializer needs — the Query API ops, or a test double. */
export interface ChatTurnLeaseStore {
  acquire(args: {
    chatSessionId: string;
    holderId: string;
    ttlMs: number;
  }): Promise<
    | { ok: true; acquired: true; tookOverExpiredHolderId: string | null }
    | { ok: true; acquired: false; heldSince: string | null }
    | { ok: false; message: string }
  >;
  renew(args: {
    chatSessionId: string;
    holderId: string;
    ttlMs: number;
  }): Promise<{ ok: true; held: boolean } | { ok: false; message: string }>;
  release(args: {
    chatSessionId: string;
    holderId: string;
  }): Promise<{ ok: true } | { ok: false; message: string }>;
}

/** The lease store backed by the `chat.*_turn_lease` Query API ops. */
export function queryApiChatTurnLeaseStore(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
): ChatTurnLeaseStore {
  const describe = (e: unknown): string =>
    typeof e === "object" && e !== null && "message" in e
      ? String((e as { message: unknown }).message)
      : JSON.stringify(e);
  return {
    async acquire(args) {
      const r = await execute(registry, adapter, ctx, "chat.acquire_turn_lease", args);
      if (!r.ok) return { ok: false, message: describe(r.error) };
      const v = r.value as {
        acquired: boolean;
        tookOverExpiredHolderId: string | null;
        heldBy: { acquiredAt: string } | null;
      };
      return v.acquired
        ? { ok: true, acquired: true, tookOverExpiredHolderId: v.tookOverExpiredHolderId }
        : { ok: true, acquired: false, heldSince: v.heldBy?.acquiredAt ?? null };
    },
    async renew(args) {
      const r = await execute(registry, adapter, ctx, "chat.renew_turn_lease", args);
      if (!r.ok) return { ok: false, message: describe(r.error) };
      return { ok: true, held: (r.value as { held: boolean }).held };
    },
    async release(args) {
      const r = await execute(registry, adapter, ctx, "chat.release_turn_lease", args);
      return r.ok ? { ok: true } : { ok: false, message: describe(r.error) };
    },
  };
}

/** A held chat turn. */
export interface ChatTurnHold {
  /** Aborts if the lease was lost mid-turn (taken over after it lapsed). */
  readonly lost: AbortSignal;
  /** End the turn: stop the heartbeat, delete the lease, let the next turn in. Idempotent. */
  release(): Promise<void>;
}

/** Outcome of {@link ChatTurnSerializer.acquire}. */
export type ChatTurnAcquireResult =
  | { kind: "held"; hold: ChatTurnHold }
  /** The caller's abort signal fired while it waited. Nothing is held. */
  | { kind: "aborted" }
  /** Waited the full bound and the chat's running turn still held it. */
  | { kind: "busy"; message: string }
  /** The lease could not be read or written. */
  | { kind: "failed"; message: string };

/** Tunables — defaults suit production; tests shorten them. */
export interface ChatTurnSerializerOptions {
  readonly leaseTtlMs?: number;
  readonly heartbeatMs?: number;
  readonly waitTimeoutMs?: number;
  /** First poll delay while another turn holds the lease; doubles up to `pollMaxMs`. */
  readonly pollMinMs?: number;
  readonly pollMaxMs?: number;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  // Digits only: parseInt would read "1e3" as 1 and "1.5" as 1.
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer of milliseconds, got "${raw}"`);
  }
  return parsed;
}

/** Sleep that ends early (returning false) when `signal` aborts. */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Serializes the turns of each chat. One instance per admin process (see
 * {@link defaultChatTurnSerializer}); tests build several to stand in for
 * several admin instances sharing one database.
 */
export class ChatTurnSerializer {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly leaseTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly waitTimeoutMs: number;
  private readonly pollMinMs: number;
  private readonly pollMaxMs: number;

  constructor(options: ChatTurnSerializerOptions = {}) {
    this.leaseTtlMs =
      options.leaseTtlMs ??
      positiveIntFromEnv("CAELO_CHAT_TURN_LEASE_TTL_MS", DEFAULT_CHAT_TURN_LEASE_TTL_MS);
    this.heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(this.leaseTtlMs / 4));
    this.waitTimeoutMs =
      options.waitTimeoutMs ??
      positiveIntFromEnv("CAELO_CHAT_TURN_WAIT_MS", DEFAULT_CHAT_TURN_WAIT_MS);
    this.pollMinMs = options.pollMinMs ?? 100;
    this.pollMaxMs = options.pollMaxMs ?? 1_000;
  }

  /**
   * Wait until no earlier turn of `chatSessionId` is running — on this
   * instance or any other — then hold the chat. On `held`, the caller must
   * `await hold.release()` exactly when the turn ended (in a `finally`).
   */
  async acquire(args: {
    chatSessionId: string;
    store: ChatTurnLeaseStore;
    abortSignal?: AbortSignal;
  }): Promise<ChatTurnAcquireResult> {
    const { chatSessionId, store, abortSignal } = args;
    const deadline = Date.now() + this.waitTimeoutMs;
    const busy = (heldSince: string | null): ChatTurnAcquireResult => {
      const since = heldSince ? ` (running since ${heldSince})` : "";
      return {
        kind: "busy",
        message:
          `This chat is still answering an earlier message${since}, and it did not finish ` +
          `within ${Math.round(this.waitTimeoutMs / 1000)} seconds. Your message was NOT sent, ` +
          "so the conversation stays in order. Wait for the current answer to finish (or stop " +
          "it), then send the message again.",
      };
    };

    // 1. In-process FIFO. `tail` resolves once every earlier local turn AND
    // this one let go. The map entry is dropped only when `tail` itself
    // resolved: a waiter that gives up early (abort, wait bound) resolves
    // `mine`, but a turn arriving after it must still queue behind the
    // earlier turns that are running.
    const previous = this.tails.get(chatSessionId) ?? Promise.resolve();
    let releaseLocal!: () => void;
    const mine = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(chatSessionId, tail);
    void tail.then(() => {
      if (this.tails.get(chatSessionId) === tail) this.tails.delete(chatSessionId);
    });
    let localReleased = false;
    const letGoLocally = (): void => {
      if (localReleased) return;
      localReleased = true;
      releaseLocal();
    };

    let stopWaiting!: (outcome: "aborted" | "timeout") => void;
    const gaveUp = new Promise<"aborted" | "timeout">((resolve) => {
      stopWaiting = resolve;
    });
    const onAbort = (): void => stopWaiting("aborted");
    if (abortSignal?.aborted) stopWaiting("aborted");
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    const waitTimer = setTimeout(() => stopWaiting("timeout"), this.waitTimeoutMs);
    const localOutcome = await Promise.race([previous.then(() => "ready" as const), gaveUp]);
    clearTimeout(waitTimer);
    abortSignal?.removeEventListener("abort", onAbort);
    if (localOutcome !== "ready") {
      letGoLocally();
      return localOutcome === "aborted" ? { kind: "aborted" } : busy(null);
    }

    // 2. Cross-instance lease. Only the local queue's head gets here. Any
    // throw from the store frees the local queue — otherwise every later
    // turn of this chat on this instance would wait forever.
    const holderId = crypto.randomUUID();
    let lastRenewOkAt = 0;
    const releaseQuietly = async (): Promise<void> => {
      try {
        await store.release({ chatSessionId, holderId });
      } catch {
        // The lease lapses after its TTL; the next turn takes it over.
      }
    };
    try {
      let pollMs = this.pollMinMs;
      for (;;) {
        if (abortSignal?.aborted) {
          letGoLocally();
          return { kind: "aborted" };
        }
        // Measured BEFORE the claim: the lease's expiry is at least this + TTL.
        const claimStartedAt = Date.now();
        const claim = await store.acquire({ chatSessionId, holderId, ttlMs: this.leaseTtlMs });
        if (!claim.ok) {
          letGoLocally();
          return {
            kind: "failed",
            message:
              `Could not reserve this chat for the new message (${claim.message}). ` +
              "Nothing was sent; send the message again.",
          };
        }
        if (claim.acquired) {
          if (claim.tookOverExpiredHolderId !== null) {
            // A previous turn's instance stopped renewing (crash, freeze).
            console.error("[chat-runner] turn lease taken over after it lapsed", {
              chatSessionId,
            });
          }
          if (abortSignal?.aborted) {
            // Aborted while the claim was in flight: hand the chat straight back.
            await releaseQuietly();
            letGoLocally();
            return { kind: "aborted" };
          }
          lastRenewOkAt = claimStartedAt;
          break;
        }
        if (Date.now() >= deadline) {
          letGoLocally();
          return busy(claim.heldSince);
        }
        const slept = await abortableSleep(
          Math.min(pollMs, Math.max(1, deadline - Date.now())),
          abortSignal,
        );
        if (!slept) {
          letGoLocally();
          return { kind: "aborted" };
        }
        pollMs = Math.min(pollMs * 2, this.pollMaxMs);
      }
    } catch {
      console.error("[chat-runner] turn lease claim threw", { chatSessionId });
      await releaseQuietly();
      letGoLocally();
      return {
        kind: "failed",
        message:
          "Could not reserve this chat for the new message (the database did not answer). " +
          "Nothing was sent; send the message again.",
      };
    }

    // 3. Heartbeat. A failed renew is retried on the next beat. But once no
    // renew has SUCCEEDED for all but two beats of the TTL, the lease could
    // lapse before a late beat lands and another instance could take the
    // chat: stop this turn first (`lost`), so the two never write at once.
    // Two beats of margin, not one, so a busy event loop delaying a timer
    // does not eat the whole margin.
    // A renew that finds the lease gone means that already happened.
    const lost = new AbortController();
    const loseLease = (reason: string): void => {
      if (lost.signal.aborted) return;
      console.error(`[chat-runner] turn lease ${reason}; stopping the turn`, { chatSessionId });
      lost.abort(new Error(`chat turn lease ${reason}`));
    };
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (lost.signal.aborted) return;
      if (Date.now() - lastRenewOkAt > this.leaseTtlMs - 2 * this.heartbeatMs) {
        loseLease("could not be renewed in time");
        return;
      }
      if (renewing) return;
      renewing = true;
      const renewStartedAt = Date.now();
      store
        .renew({ chatSessionId, holderId, ttlMs: this.leaseTtlMs })
        .then((r) => {
          if (!r.ok) {
            console.error("[chat-runner] turn lease renew failed", { chatSessionId });
          } else if (!r.held) {
            loseLease("lost mid-turn");
          } else {
            lastRenewOkAt = Math.max(lastRenewOkAt, renewStartedAt);
          }
        })
        .catch(() => {
          console.error("[chat-runner] turn lease renew threw", { chatSessionId });
        })
        .finally(() => {
          renewing = false;
        });
    }, this.heartbeatMs);

    let released = false;
    return {
      kind: "held",
      hold: {
        lost: lost.signal,
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          try {
            const r = await store.release({ chatSessionId, holderId });
            if (!r.ok) {
              // The lease lapses after its TTL; the next turn then takes it over.
              console.error("[chat-runner] turn lease release failed", { chatSessionId });
            }
          } catch {
            console.error("[chat-runner] turn lease release threw", { chatSessionId });
          } finally {
            letGoLocally();
          }
        },
      },
    };
  }
}

/** The serializer of this admin process. */
export const defaultChatTurnSerializer = new ChatTurnSerializer();
