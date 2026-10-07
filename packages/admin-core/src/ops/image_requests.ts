// SPDX-License-Identifier: MPL-2.0

/**
 * `image_requests.*` — the chat's side of the shared paid-image ledger
 * (#527). The functions are plugin-host's image-ledger.ts, the same ones
 * `plugin_images.*` uses, so chat and plugins reserve, settle and record
 * provenance identically. A chat request lives in the scope
 * `chat:<chat_session_id>`; its id is derived from the tool call, so a
 * replayed call finds its own request instead of paying again.
 *
 * Why system-only: these are the host's ledger writes around a paid
 * provider call; the AI reaches them only through `generate_image` /
 * `edit_image`, which run them with a system context after their own
 * checks (the same elevation `media.upload` gets there).
 */

import {
  finishImageRequest,
  markImageRequestUncertain,
  readImageRequest,
  reserveImageRequest,
} from "@caelo-cms/plugin-host";
import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { z } from "zod";

const uuid = z.string().uuid();
// Actor ids include the fixed system actor (…00ffff), which is GUID-shaped
// but not an RFC v4 UUID.
const actorGuid = z.guid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const sourceRef = z.object({ kind: z.string().min(1).max(40), id: uuid, sha256: sha }).strict();
const key = z.object({ chatSessionId: uuid, requestId: uuid }).strict();

const chatScope = (chatSessionId: string) => `chat:${chatSessionId}`;

const record = z.object({
  id: z.string(),
  status: z.enum(["running", "ready", "uncertain"]),
  inputSha256: z.string(),
  operation: z.enum(["generate", "edit"]),
  prompt: z.string().nullable(),
  references: z.array(z.unknown()),
  model: z.string(),
  provider: z.string().nullable(),
  outputMediaId: z.string().nullable(),
  result: z.unknown().nullable(),
  costMicrocents: z.number(),
  createdAt: z.string(),
});

export const imageRequestsReadOp = defineOperation({
  name: "image_requests.read",
  // Why system-only: idempotency ledger the image service writes around each provider call —
  // infrastructure under generate_image / edit_image, not a separate action.
  actorScope: ["system"],
  database: "cms_admin",
  input: key,
  output: z.object({ request: record.nullable() }),
  handler: async (_ctx, input, tx) => {
    const r = await readImageRequest(tx, chatScope(input.chatSessionId), input.requestId);
    return ok({ request: r });
  },
});

export const imageRequestsReserveOp = defineOperation({
  name: "image_requests.reserve",
  // Why system-only: idempotency ledger the image service writes around each provider call —
  // infrastructure under generate_image / edit_image, not a separate action.
  actorScope: ["system"],
  database: "cms_admin",
  input: key
    .extend({
      actorId: actorGuid,
      inputSha256: sha,
      operation: z.enum(["generate", "edit"]),
      prompt: z.string().min(1).max(16000),
      references: z.array(sourceRef).max(14),
      mask: sourceRef.optional(),
      requested: z.record(z.string(), z.unknown()),
      provider: z.enum(["openai", "google"]),
      model: z.string().min(1).max(200),
      maxCostMicrocents: z.number().int().min(1),
    })
    .strict(),
  output: z.object({ existing: record.nullable(), callId: z.string().nullable() }),
  handler: async (_ctx, input, tx) => {
    const op = "image_requests.reserve";
    const reserved = await reserveImageRequest(tx, {
      scope: chatScope(input.chatSessionId),
      requestId: input.requestId,
      inputSha256: input.inputSha256,
      operation: input.operation,
      prompt: input.prompt,
      references: input.references,
      mask: input.mask ?? null,
      requested: input.requested,
      provider: input.provider,
      model: input.model,
      maxCostMicrocents: input.maxCostMicrocents,
      actorId: input.actorId,
      chatSessionId: input.chatSessionId,
    });
    if ("refused" in reserved) {
      const why = reserved.refused;
      return err({
        kind: "HandlerError",
        operation: op,
        message:
          why.kind === "budget"
            ? `ImageBudgetExceeded (${why.scope}): the ${why.scope} image budget would be exceeded. The Owner can raise it at /security/ai/budgets; otherwise wait for the 24-hour window or continue without a new image.`
            : why.kind === "conflict"
              ? "ImageRequestConflict: this tool call already requested a different image."
              : why.kind === "session-required"
                ? "ImageSessionRequired: a per-session image budget is set, so images can only be generated inside a chat."
                : "ImageBudgetExceeded: plugin budget",
      });
    }
    if ("existing" in reserved) return ok({ existing: reserved.existing, callId: null });
    return ok({ existing: null, callId: reserved.callId });
  },
});

export const imageRequestsFinishOp = defineOperation({
  name: "image_requests.finish",
  // Why system-only: idempotency ledger the image service writes around each provider call —
  // infrastructure under generate_image / edit_image, not a separate action.
  actorScope: ["system"],
  database: "cms_admin",
  input: key
    .extend({
      callId: uuid,
      outputMediaId: uuid,
      result: z.record(z.string(), z.unknown()),
      costMicrocents: z.number().int().min(0),
      durationMs: z.number().int().min(0),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await finishImageRequest(tx, {
      scope: chatScope(input.chatSessionId),
      requestId: input.requestId,
      callId: input.callId,
      result: input.result,
      outputMediaId: input.outputMediaId,
      costMicrocents: input.costMicrocents,
      durationMs: input.durationMs,
    });
    return ok({});
  },
});

export const imageRequestsMarkUncertainOp = defineOperation({
  name: "image_requests.mark_uncertain",
  // Why system-only: idempotency ledger the image service writes around each provider call —
  // infrastructure under generate_image / edit_image, not a separate action.
  actorScope: ["system"],
  database: "cms_admin",
  input: key,
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await markImageRequestUncertain(tx, chatScope(input.chatSessionId), input.requestId);
    return ok({});
  },
});
