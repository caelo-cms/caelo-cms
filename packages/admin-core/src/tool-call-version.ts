// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1253 — the version a tool call read: the database snapshot taken
 * when the call started.
 *
 * Optimistic versioning in the shared draft (#620) compares owners: a
 * write is a conflict when ANOTHER chat changed the entity after this chat
 * last saw it. Two calls of one external agent running at once — parallel
 * tool calls, sub-agents sharing one work session — are one owner, so the
 * later one silently overwrote the earlier. A Power-MCP call therefore
 * runs inside {@link withToolCallVersion}: every entity write it makes is
 * checked against the snapshot it started with (`checkAndAcquireEntityLock`,
 * locks.ts), so a write that lands on an entity some other call changed
 * after this one started is refused with a re-read hint — whoever made
 * that change.
 *
 * Carried in an AsyncLocalStorage, not on the ExecutionContext: a call
 * runs through many ops (and their nested helpers) that build contexts of
 * their own, and the check must hold for all of them without each op
 * threading it through.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** One tool call's identity and the snapshot (`pg_current_snapshot()` text) it started with. */
export interface ToolCallVersion {
  /** Unique per call; a write by the same call never conflicts with itself. */
  readonly callId: string;
  /** `pg_snapshot` text, e.g. `"812:815:812,813"`. */
  readonly snapshot: string;
}

const current = new AsyncLocalStorage<ToolCallVersion>();

/** Run `fn` as the tool call `version`: its entity writes are checked against it. */
export function withToolCallVersion<T>(version: ToolCallVersion, fn: () => Promise<T>): Promise<T> {
  return current.run(version, fn);
}

/** The tool call this async chain runs in, or undefined outside one. */
export function currentToolCallVersion(): ToolCallVersion | undefined {
  return current.getStore();
}
