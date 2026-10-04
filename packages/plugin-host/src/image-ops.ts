// SPDX-License-Identifier: MPL-2.0

/**
 * Paid image generation for plugins, as named operations (CMS_REQUIREMENTS
 * §14.5 `image_generation`, §14.7). The host broker (images.ts) runs the
 * provider call itself; these operations hold the ledger around it:
 *
 * - `reserve` checks the plugin's `image_generation` receipt for exactly
 *   the running artifact (same check as private storage, in this
 *   transaction), then reserves through the shared ledger (image-ledger.ts,
 *   also used by the chat's `generate_image`): every image budget and the
 *   plugin's own cap, under one lock, with provenance recorded.
 * - `finish` / `mark_uncertain` settle it. An uncertain outcome keeps its
 *   reservation and is never retried automatically — retrying would pay
 *   twice; a new request id is a new, deliberate payment.
 * - `read` returns a request by id: the same id is idempotent.
 *
 * System-only: the ledger tables are host data under forced RLS. The
 * broker passes the plugin, artifact and operator it acts for.
 */

import {
  defineOperation,
  type OperationDefinition,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { z } from "zod";
import {
  finishImageRequest,
  markImageRequestUncertain,
  readImageRequest,
  reserveImageRequest,
} from "./image-ledger.js";
import { privateGrantRefusal } from "./private-storage.js";

export const IMAGE_OPS = {
  read: "plugin_images.read",
  reserve: "plugin_images.reserve",
  finish: "plugin_images.finish",
  markUncertain: "plugin_images.mark_uncertain",
} as const;

const uuid = z.string().uuid();
const request = z.object({ pluginId: uuid, requestId: uuid }).strict();

const requestRow = z.object({
  id: z.string(),
  inputSha256: z.string(),
  model: z.string(),
  status: z.enum(["running", "ready", "uncertain"]),
  result: z.unknown().nullable(),
  costMicrocents: z.number(),
  createdAt: z.string(),
  prompt: z.string().nullable(),
  references: z.array(z.unknown()),
});
type RequestRow = z.infer<typeof requestRow>;

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

function fail(operation: string, message: string) {
  return err({ kind: "HandlerError" as const, operation, message });
}

/** A plugin's requests live in its own ledger scope. */
const pluginScope = (pluginId: string) => `plugin:${pluginId}`;

async function readRequest(
  tx: Tx,
  pluginId: string,
  requestId: string,
): Promise<RequestRow | null> {
  const r = await readImageRequest(tx, pluginScope(pluginId), requestId);
  if (!r) return null;
  return {
    id: r.id,
    inputSha256: r.inputSha256,
    model: r.model,
    status: r.status,
    result: r.result,
    costMicrocents: r.costMicrocents,
    createdAt: r.createdAt,
    prompt: r.prompt,
    references: r.references,
  };
}

const readOp = defineOperation({
  name: IMAGE_OPS.read,
  // Why system-only: host ledger; the broker reads on the plugin's behalf.
  actorScope: ["system"],
  database: "cms_admin",
  input: request,
  output: z.object({ request: requestRow.nullable() }),
  handler: async (_ctx, input, tx) =>
    ok({ request: await readRequest(tx, input.pluginId, input.requestId) }),
});

const reserveOp = defineOperation({
  name: IMAGE_OPS.reserve,
  // Why system-only: see read.
  actorScope: ["system"],
  database: "cms_admin",
  input: request
    .extend({
      pluginArtifactDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
      model: z.string().min(1).max(200),
      maxCostMicrocents: z.number().int().min(1),
      operatorActorId: uuid,
      chatBranchId: uuid.optional(),
      // #532 provenance.
      operation: z.enum(["generate", "edit"]).default("generate"),
      prompt: z.string().min(1).max(16000),
      references: z
        .array(z.object({ id: uuid, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
        .max(15),
      mask: z
        .object({ id: uuid, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .optional(),
      requested: z.record(z.string(), z.unknown()),
    })
    .strict(),
  output: z.object({ existing: requestRow.nullable(), callId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const op = IMAGE_OPS.reserve;
    // The grant check reads the plugin's own context: plugin + artifact.
    const pluginCtx: ExecutionContext = {
      ...ctx,
      pluginId: input.pluginId,
      ...(input.pluginArtifactDigest ? { pluginArtifactDigest: input.pluginArtifactDigest } : {}),
    };
    const refused = await privateGrantRefusal(tx, pluginCtx, "image_generation");
    if (refused) return fail(op, `${op}: ${refused}`);
    const reserved = await reserveImageRequest(tx, {
      scope: pluginScope(input.pluginId),
      requestId: input.requestId,
      inputSha256: input.inputSha256,
      operation: input.operation,
      prompt: input.prompt,
      // An edit's first file is the image it changes.
      references: input.references.map((r, i) => ({
        kind: input.operation === "edit" && i === 0 ? "source" : "plugin-file",
        ...r,
      })),
      mask: input.mask ? { kind: "mask", ...input.mask } : null,
      requested: input.requested,
      provider: "google",
      model: input.model,
      maxCostMicrocents: input.maxCostMicrocents,
      actorId: input.operatorActorId,
      pluginId: input.pluginId,
      sessionTag: `plugin-images-chat:${input.chatBranchId ?? "none"}`,
    });
    if ("refused" in reserved) {
      const why = reserved.refused;
      return fail(
        op,
        why.kind === "conflict"
          ? "PluginImageRequestConflict: this request id was used for another request"
          : why.kind === "session-required"
            ? "PluginImageSessionRequired: a per-session image budget needs a chat"
            : why.kind === "budget"
              ? `PluginImageBudgetExceeded:${why.scope}`
              : "PluginImagePluginBudgetExceeded",
      );
    }
    if ("existing" in reserved) {
      return ok({ existing: await readRequest(tx, input.pluginId, input.requestId), callId: null });
    }
    return ok({ existing: null, callId: reserved.callId });
  },
});

const finishOp = defineOperation({
  name: IMAGE_OPS.finish,
  // Why system-only: see read.
  actorScope: ["system"],
  database: "cms_admin",
  input: request
    .extend({
      callId: uuid,
      result: z.record(z.string(), z.unknown()),
      costMicrocents: z.number().int().min(0),
      durationMs: z.number().int().min(0),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await finishImageRequest(tx, {
      scope: pluginScope(input.pluginId),
      requestId: input.requestId,
      callId: input.callId,
      result: input.result,
      costMicrocents: input.costMicrocents,
      durationMs: input.durationMs,
    });
    return ok({});
  },
});

const markUncertainOp = defineOperation({
  name: IMAGE_OPS.markUncertain,
  // Why system-only: see read.
  actorScope: ["system"],
  database: "cms_admin",
  input: request,
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await markImageRequestUncertain(tx, pluginScope(input.pluginId), input.requestId);
    return ok({});
  },
});

const ALL = [readOp, reserveOp, finishOp, markUncertainOp];

/** Register the image ledger operations (idempotent, like the storage ops). */
export function registerPluginImageOps(registry: OperationRegistry): void {
  if (registry.has(IMAGE_OPS.read)) return;
  // The registry stores every op as OperationDefinition<unknown, unknown>.
  for (const op of ALL) registry.register(op as OperationDefinition<unknown, unknown>);
}
