// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import type { PluginImageResult, PluginImages } from "@caelo-cms/plugin-sdk";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AuthorDispatchContext, LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import { withExternalAuthorization } from "./external-authorization.js";
import { transformPrivateImage } from "./image-transform.js";
import { makePluginPrivateFiles } from "./private-files.js";

type Tx = Parameters<Parameters<PluginHostInfra["adapter"]["withAdminTransaction"]>[1]>[0];
const uuid = z.string().uuid();
const identity = z.object({ requestId: uuid }).strict();
const inputSchema = identity
  .extend({
    prompt: z.string().min(1).max(16000),
    imageSize: z.enum(["1K", "2K", "4K"]),
    references: z
      .array(z.object({ id: uuid, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
      .max(4),
    maxCostMicrocents: z.number().int().min(1).max(200_000_000),
  })
  .strict();
interface Row {
  id: string;
  input_sha256: string;
  model: string;
  status: PluginImageResult["status"];
  result: PluginImageResult | null;
  cost: string;
  created_at: Date | string;
}

/** Host infrastructure: exact installation authorization, budget reservation and
 * immutable request identity share a transaction. No network call holds a DB lock.
 * Failed/uncertain requests are never replayed automatically, even after restart. */
export function makePluginImages(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  author: AuthorDispatchContext,
): PluginImages {
  if (
    !plugin.definition.requestedCapabilities?.includes("image_generation") ||
    (plugin.provenance === "runtime-authored" &&
      !plugin.externalApproval?.capabilities.includes("image_generation"))
  )
    throw new Error("PluginImageCapabilityDenied");
  const files = makePluginPrivateFiles(plugin, infra, author);
  async function access<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const checked = async (tx: Tx) => {
      const rows = (await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM users u
        JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id
        JOIN permissions p ON p.id=rp.permission_id WHERE u.id=${author.operatorActorId}::uuid
        AND u.deleted_at IS NULL AND p.name='content.write') AS allowed`)) as unknown as {
        allowed: boolean;
      }[];
      if (!rows[0]?.allowed) throw new Error("PluginImageAuthorPermissionDenied");
      return work(tx);
    };
    if (plugin.externalApproval) return withExternalAuthorization(plugin, infra, checked);
    return infra.adapter.withAdminTransaction(
      { actorId: plugin.pluginActorId, actorKind: "system", requestId: "plugin-image" },
      async (tx) => {
        const rows = (await tx.execute(
          sql`SELECT status FROM plugins WHERE id=${plugin.pluginId}::uuid FOR SHARE`,
        )) as unknown as { status: string }[];
        if (rows[0]?.status !== "active") throw new Error("PluginImageInactive");
        return checked(tx);
      },
    );
  }
  async function read(tx: Tx, id: string): Promise<Row | undefined> {
    const rows =
      (await tx.execute(sql`SELECT r.*,c.cost_estimate_microcents AS cost FROM plugin_image_requests r
      JOIN ai_calls c ON c.id=r.call_id WHERE r.plugin_id=${plugin.pluginId}::uuid AND r.id=${id}::uuid`)) as unknown as Row[];
    return rows[0];
  }
  function result(row: Row): PluginImageResult {
    return (
      row.result ?? {
        requestId: row.id,
        model: row.model,
        status:
          row.status === "running" && Date.now() - new Date(row.created_at).getTime() > 210_000
            ? "uncertain"
            : row.status,
        costMicrocents: Number(row.cost),
      }
    );
  }
  return {
    async transform(input) {
      await access(async () => {});
      const result = await transformPrivateImage(files, infra, input);
      await access(async () => {});
      return result;
    },
    async describe() {
      await access(async () => {});
      if (!infra.imageProvider) throw new Error("PluginImageProviderUnavailable");
      return infra.imageProvider.describe();
    },
    async get(input) {
      const { requestId } = identity.parse(input);
      return access(async (tx) => {
        const row = await read(tx, requestId);
        return row ? result(row) : null;
      });
    },
    async generate(input) {
      const value = inputSchema.parse(input);
      if (!infra.imageProvider) throw new Error("PluginImageProviderUnavailable");
      await access(async () => {});
      const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const previous = await access((tx) => read(tx, value.requestId));
      if (previous) {
        if (previous.input_sha256 !== hash) throw new Error("PluginImageRequestConflict");
        return result(previous);
      }
      const config = await infra.imageProvider.describe();
      if (config.maxCostMicrocents > value.maxCostMicrocents)
        throw new Error("PluginImageRequestBudgetExceeded");
      if (!config.imageSizes.includes(value.imageSize))
        throw new Error("PluginImageResolutionUnsupported");
      const references: { data: Uint8Array; mediaType: string }[] = [];
      let total = 0;
      for (const ref of value.references) {
        const meta = await files.stat({ id: ref.id });
        if (
          meta.status !== "ready" ||
          meta.sha256 !== ref.sha256 ||
          !["image/png", "image/jpeg", "image/webp"].includes(meta.mediaType)
        )
          throw new Error("PluginImageReferenceInvalid");
        total += meta.sizeBytes;
        if (meta.sizeBytes > 10_000_000 || total > 20_000_000)
          throw new Error("PluginImageReferenceTooLarge");
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < meta.sizeBytes; offset += 262144)
          chunks.push(
            Buffer.from((await files.readChunk({ id: ref.id, offset })).base64, "base64"),
          );
        references.push({ data: Buffer.concat(chunks), mediaType: meta.mediaType });
      }
      const reserved = await access(async (tx) => {
        // All plugin image reservations serialize against each other, including different plugins.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(220, 1)`);
        const existing = await read(tx, value.requestId);
        if (existing) {
          if (existing.input_sha256 !== hash) throw new Error("PluginImageRequestConflict");
          return { existing };
        }
        const budgets = (await tx.execute(
          sql`SELECT scope,cap_microcents FROM ai_budgets WHERE operation_type='image' AND cap_microcents IS NOT NULL`,
        )) as unknown as { scope: string; cap_microcents: string }[];
        for (const budget of budgets) {
          if (budget.scope === "session" && !author.actor.chatBranchId)
            throw new Error("PluginImageSessionRequired");
          const scope =
            budget.scope === "day-per-actor"
              ? sql`AND actor_id=${author.operatorActorId}::uuid`
              : budget.scope === "session"
                ? sql`AND request_id=${`plugin-images-chat:${author.actor.chatBranchId}`}`
                : sql``;
          const since =
            budget.scope === "session" ? sql`` : sql`AND created_at > now()-interval '24 hours'`;
          const usage =
            (await tx.execute(sql`SELECT coalesce(sum(cost_estimate_microcents),0)::bigint AS spent FROM ai_calls
            WHERE operation_type='image' ${since} ${scope}`)) as unknown as { spent: string }[];
          if (
            Number(usage[0]?.spent ?? 0) + config.maxCostMicrocents >
            Number(budget.cap_microcents)
          )
            throw new Error(`PluginImageBudgetExceeded:${budget.scope}`);
        }
        const pluginBudget = (await tx.execute(sql`SELECT p.ai_cost_cap_microcents AS cap,
          coalesce((SELECT sum(cost_estimate_microcents) FROM ai_calls WHERE plugin_id=p.id AND created_at > now()-interval '24 hours'),0)::bigint AS spent
          FROM plugins p WHERE p.id=${plugin.pluginId}::uuid`)) as unknown as {
          cap: string | null;
          spent: string;
        }[];
        if (
          pluginBudget[0]?.cap !== null &&
          Number(pluginBudget[0]?.spent) + config.maxCostMicrocents > Number(pluginBudget[0]?.cap)
        )
          throw new Error("PluginImagePluginBudgetExceeded");
        const callId = crypto.randomUUID();
        await tx.execute(sql`INSERT INTO ai_calls(id,actor_id,plugin_id,provider,model,input_tokens,output_tokens,cached_tokens,
          cost_estimate_microcents,succeeded,operation_type,image_count,request_id) VALUES (${callId}::uuid,${author.operatorActorId}::uuid,
          ${plugin.pluginId}::uuid,'google',${config.model},0,0,0,${config.maxCostMicrocents},false,'image',1,${`plugin-images-chat:${author.actor.chatBranchId}`})`);
        await tx.execute(sql`INSERT INTO plugin_image_requests(plugin_id,id,input_sha256,call_id,model,status)
          VALUES (${plugin.pluginId}::uuid,${value.requestId}::uuid,${hash},${callId}::uuid,${config.model},'running')`);
        return { callId };
      });
      if (reserved.existing) return result(reserved.existing);
      try {
        const generated = await infra.imageProvider.generate({
          model: config.model,
          prompt: value.prompt,
          imageSize: value.imageSize,
          references,
        });
        const sha256 = createHash("sha256").update(generated.bytes).digest("hex");
        const meta = await files.begin({
          id: crypto.randomUUID(),
          sha256,
          mediaType: "image/jpeg",
          sizeBytes: generated.bytes.byteLength,
        });
        for (let offset = 0; offset < generated.bytes.byteLength; offset += 262144)
          await files.writeChunk({
            id: meta.id,
            offset,
            base64: Buffer.from(generated.bytes.subarray(offset, offset + 262144)).toString(
              "base64",
            ),
          });
        const file = await files.commit({ id: meta.id });
        const output: PluginImageResult = {
          requestId: value.requestId,
          status: "ready",
          file,
          width: generated.width,
          height: generated.height,
          model: config.model,
          costMicrocents: generated.costMicrocents,
        };
        await access(async (tx) => {
          await tx.execute(
            sql`UPDATE plugin_image_requests SET status='ready',result=${sql.param(output)} WHERE plugin_id=${plugin.pluginId}::uuid AND id=${value.requestId}::uuid`,
          );
          await tx.execute(
            sql`UPDATE ai_calls SET cost_estimate_microcents=${generated.costMicrocents},duration_ms=${generated.durationMs},succeeded=true WHERE id=${reserved.callId}::uuid`,
          );
        });
        return output;
      } catch {
        // Don't leak provider request headers, prompts or credentials through sandbox errors.
        await access(async (tx) => {
          await tx.execute(
            sql`UPDATE plugin_image_requests SET status='uncertain' WHERE plugin_id=${plugin.pluginId}::uuid AND id=${value.requestId}::uuid`,
          );
        });
        throw new Error(
          "PluginImageOutcomeUncertain: inspect this request; retrying requires a new paid request ID",
        );
      }
    },
  };
}
