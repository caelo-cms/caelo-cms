// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — what a build order says (migration 0690 `build_orders`):
 * which build to run and as whom. Shared by the request that asks for a
 * build (carry.ts), the carrier's report that runs it (run-order.ts) and
 * the ops that store it (ops/build_orders.ts).
 *
 * The order is the admin's own record: the request that asked for the
 * build writes it, and the carrier's job names only its id (its token
 * admits it for that one order). The job never sees the order's content.
 */

import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import { stagedBySchema } from "../quality/chat-feedback.js";

/**
 * What a carrier can be asked to build: the Stage of some chats, or one of
 * the deploy ops a button runs. Every one of them builds only what a person
 * or an agent asked for in the request that wrote the order.
 */
export const BUILD_ORDER_KINDS = [
  "stage",
  "deploy.trigger",
  "deploy.promote",
  "deploy.execute_proposal",
  "quality_audits.publish_anyway",
  "quality_audits.execute_proposal",
] as const;

export type BuildOrderKind = (typeof BUILD_ORDER_KINDS)[number];

/** The ops a build order may run (every kind but the Stage flow). */
export type BuildOpName = Exclude<BuildOrderKind, "stage">;

/** A Stage's order: the chats to merge and build, and who staged them. */
export const stageOrderInputSchema = z
  .object({
    chatSessionIds: z.array(z.string().uuid()).min(1).max(100),
    stagedBy: stagedBySchema,
  })
  .strict();

/** What to build. An op's input is checked by the op itself when it runs. */
export type BuildOrder =
  | { readonly kind: "stage"; readonly input: z.infer<typeof stageOrderInputSchema> }
  | { readonly kind: BuildOpName; readonly input: Readonly<Record<string, unknown>> };

/**
 * The context a build runs under, as stored: the actor and the attribution
 * the ops record. Nothing else of the caller's context travels — a build is
 * never a plugin's (plugins never write live) and never renders for one.
 */
export const orderActorSchema = z
  .object({
    actorId: z.string().min(1).max(64),
    actorKind: z.enum(["human", "ai", "system"]),
    requestId: z.string().min(1).max(200),
    chatBranchId: z.string().min(1).max(64).optional(),
    chatTaskId: z.string().min(1).max(64).optional(),
    parentChatSessionId: z.string().min(1).max(64).optional(),
    parentAiCallId: z.string().min(1).max(64).optional(),
  })
  .strict();

export type OrderActor = z.infer<typeof orderActorSchema>;

/** The stored form of `ctx`; a plugin's context is refused. */
export function actorOf(ctx: ExecutionContext): OrderActor {
  if (ctx.actorKind === "plugin") {
    throw new Error("a plugin never builds (CLAUDE.md §2: plugins never write live)");
  }
  return orderActorSchema.parse({
    actorId: ctx.actorId,
    actorKind: ctx.actorKind,
    requestId: ctx.requestId,
    ...(ctx.chatBranchId ? { chatBranchId: ctx.chatBranchId } : {}),
    ...(ctx.chatTaskId ? { chatTaskId: ctx.chatTaskId } : {}),
    ...(ctx.parentChatSessionId ? { parentChatSessionId: ctx.parentChatSessionId } : {}),
    ...(ctx.parentAiCallId ? { parentAiCallId: ctx.parentAiCallId } : {}),
  });
}

/** The context a stored order's build runs under. */
export function contextOf(actor: OrderActor): ExecutionContext {
  return { ...actor };
}

/**
 * How a build ended, as its order keeps it. `value` / `error` are what the
 * Stage flow or the op answered (plain data: the request that waits reads
 * them back). `givenUp` marks an outcome the backstop wrote because the
 * carrier died: the build's own outcome, should it still come, replaces it.
 */
export type BuildOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown; readonly givenUp?: true };

export const buildOutcomeSchema: z.ZodType<BuildOutcome> = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z
    .object({ ok: z.literal(false), error: z.unknown(), givenUp: z.literal(true).optional() })
    .strict(),
]) as z.ZodType<BuildOutcome>;

/** What the carrier's job learns of its build: only how it ended, never its data. */
export interface BuildRunAnswer {
  readonly outcome: "succeeded" | "failed" | "missing";
}

/** What the person reads when a carried build ends without its result, by kind. */
export function nextStepAfterLostBuild(kind: BuildOrderKind): string {
  switch (kind) {
    case "stage":
      return "Nothing it built was published, and the chats keep their changes: Stage again.";
    case "deploy.trigger":
      return "Nothing it built was published: start the build again.";
    case "deploy.promote":
    case "deploy.execute_proposal":
    case "quality_audits.publish_anyway":
    case "quality_audits.execute_proposal":
      return "Check Settings → Deployments for what production serves, then Publish live again.";
  }
}
