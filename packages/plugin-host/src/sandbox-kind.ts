// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — what a sandboxed call is for (docs/dev/external-plugin-brokers.md
 * §4.4, decision Q10): it picks the call's slot pool, time budget and SDK
 * call limit (`SANDBOX_BUDGETS`, sandbox-runtime.ts). A module of its own,
 * with no imports, because dispatch.ts is part of the gateway's
 * dispatch-only host, which must not bring the plugin validator along
 * (`scripts/service-image.test.ts`).
 */

/** The kinds of sandboxed call, each with its own budget. */
export type SandboxKind =
  | "interactive"
  | "preview"
  | "build"
  | "worker"
  | "journal"
  | "rebuild"
  | "batch";

/**
 * Host-only marker on a plugin context: the kind a caller chose for this
 * call (`RunPluginOperationOpts.sandboxKind`), when the invocation's origin
 * alone does not say it (a journal batch runs as `system` or `chat`). A
 * symbol, so no wire field carries it: the child receives only the fields
 * the runtime picks out of the context.
 */
export const SANDBOX_KIND: unique symbol = Symbol("caelo.sandboxKind");

/**
 * Host-only marker on a plugin context: the largest answer the caller
 * accepts from this call, serialized (`RunPluginOperationOpts.maxAnswerBytes`).
 * A render point sets its own cap (render-points.ts); a sandboxed answer
 * bigger than one wire line comes back in parts up to this total.
 */
export const SANDBOX_ANSWER_BYTES: unique symbol = Symbol("caelo.sandboxAnswerBytes");

/** A context that may carry the caller's {@link SANDBOX_KIND} and {@link SANDBOX_ANSWER_BYTES}. */
export interface SandboxKindCarrier {
  readonly [SANDBOX_KIND]?: SandboxKind;
  readonly [SANDBOX_ANSWER_BYTES]?: number;
}
