// SPDX-License-Identifier: MPL-2.0

/**
 * `ctx.images` — private image generation and local derivatives for a
 * plugin granted `image_generation` (with `private_files`, where results
 * are stored). The broker owns the provider call; the paid-request
 * ledger is the `plugin_images.*` operations (image-ops.ts) and the bytes
 * go through `ctx.privateFiles`. The plugin never sees a key, a provider
 * URL or a network.
 *
 * No database lock is held across the provider call. A request id is
 * idempotent: the same id and input return the recorded result; an
 * uncertain outcome is never retried automatically — a new id is a new,
 * deliberate payment.
 */

import { createHash } from "node:crypto";
import type { PluginImageResult, PluginImages, PluginInvocation } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { hostSystemActorId, type LoadedPlugin, type PluginHostInfra } from "./dispatch.js";
import { operatorCanAuthor } from "./external-authorization.js";
import { IMAGE_OPS, registerPluginImageOps } from "./image-ops.js";
import { transformPrivateImage } from "./image-transform.js";
import { makePluginPrivateFiles } from "./private-files.js";

const uuid = z.string().uuid();
const identity = z.object({ requestId: uuid }).strict();
const generateInput = identity
  .extend({
    prompt: z.string().min(1).max(16000),
    imageSize: z.enum(["1K", "2K", "4K"]),
    references: z
      .array(z.object({ id: uuid, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
      .max(4),
    maxCostMicrocents: z.number().int().min(1).max(200_000_000),
  })
  .strict();

interface RequestRow {
  id: string;
  inputSha256: string;
  model: string;
  status: PluginImageResult["status"];
  result: PluginImageResult | null;
  costMicrocents: number;
  createdAt: string;
  prompt: string | null;
  references: { id: string; sha256: string }[];
}

/** A running request older than the provider deadline is reported as uncertain. */
function toResult(row: RequestRow): PluginImageResult {
  // #532 — every result carries how it was requested.
  const provenance = {
    prompt: row.prompt,
    references: row.references.map(({ id, sha256 }) => ({ id, sha256 })),
  };
  if (row.result) return { ...row.result, provenance };
  return {
    requestId: row.id,
    model: row.model,
    status:
      row.status === "running" && Date.now() - new Date(row.createdAt).getTime() > 210_000
        ? "uncertain"
        : row.status,
    costMicrocents: row.costMicrocents,
    provenance,
  };
}

export function makePluginImages(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
): PluginImages {
  const files = makePluginPrivateFiles(plugin, infra, invocation);
  const operator = invocation.origin === "chat" ? invocation.operatorActorId : invocation.actorId;
  const system = () => ({
    actorId: hostSystemActorId(),
    actorKind: "system" as const,
    requestId: `plugin-images-${plugin.slug}`,
  });

  async function authorized(): Promise<string> {
    if (!operator || !(await operatorCanAuthor(infra, hostSystemActorId(), operator))) {
      throw new Error("PluginImageAuthorPermissionDenied");
    }
    return operator;
  }
  async function run<T>(operation: string, input: unknown): Promise<T> {
    registerPluginImageOps(infra.registry);
    const r = await execute(infra.registry, infra.adapter, system(), operation, input);
    if (!r.ok) throw new Error("message" in r.error ? String(r.error.message) : r.error.kind);
    return r.value as T;
  }
  const read = async (requestId: string) =>
    (
      await run<{ request: RequestRow | null }>(IMAGE_OPS.read, {
        pluginId: plugin.pluginId,
        requestId,
      })
    ).request;

  return Object.freeze({
    async transform(input) {
      await authorized();
      // Local only: reads and writes go through ctx.privateFiles' checks.
      return transformPrivateImage(files, infra, input);
    },
    async describe() {
      await authorized();
      if (!infra.imageProvider) throw new Error("PluginImageProviderUnavailable");
      return infra.imageProvider.describe();
    },
    async get(input) {
      const { requestId } = identity.parse(input);
      await authorized();
      const row = await read(requestId);
      return row ? toResult(row) : null;
    },
    async generate(input) {
      const value = generateInput.parse(input);
      const operatorId = await authorized();
      if (!infra.imageProvider) throw new Error("PluginImageProviderUnavailable");
      const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const previous = await read(value.requestId);
      if (previous) {
        if (previous.inputSha256 !== hash) throw new Error("PluginImageRequestConflict");
        return toResult(previous);
      }
      const config = await infra.imageProvider.describe();
      if (config.maxCostMicrocents > value.maxCostMicrocents) {
        throw new Error("PluginImageRequestBudgetExceeded");
      }
      if (!config.imageSizes.includes(value.imageSize)) {
        throw new Error("PluginImageResolutionUnsupported");
      }
      const references: { data: Uint8Array; mediaType: string }[] = [];
      let total = 0;
      for (const ref of value.references) {
        const meta = await files.stat({ id: ref.id });
        if (
          meta.status !== "ready" ||
          meta.sha256 !== ref.sha256 ||
          !["image/png", "image/jpeg", "image/webp"].includes(meta.mediaType)
        ) {
          throw new Error("PluginImageReferenceInvalid");
        }
        total += meta.sizeBytes;
        if (meta.sizeBytes > 10_000_000 || total > 20_000_000) {
          throw new Error("PluginImageReferenceTooLarge");
        }
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < meta.sizeBytes; offset += 262_144) {
          chunks.push(
            Buffer.from((await files.readChunk({ id: ref.id, offset })).base64, "base64"),
          );
        }
        references.push({ data: Buffer.concat(chunks), mediaType: meta.mediaType });
      }
      const reserved = await run<{ existing: RequestRow | null; callId: string | null }>(
        IMAGE_OPS.reserve,
        {
          pluginId: plugin.pluginId,
          requestId: value.requestId,
          ...(plugin.externalApproval
            ? { pluginArtifactDigest: plugin.externalApproval.artifactDigest }
            : {}),
          inputSha256: hash,
          model: config.model,
          maxCostMicrocents: config.maxCostMicrocents,
          operatorActorId: operatorId,
          ...(invocation.chatBranchId ? { chatBranchId: invocation.chatBranchId } : {}),
          prompt: value.prompt,
          references: value.references,
          requested: { imageSize: value.imageSize },
        },
      );
      if (reserved.existing) return toResult(reserved.existing);
      const callId = reserved.callId as string;
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
        for (let offset = 0; offset < generated.bytes.byteLength; offset += 262_144) {
          await files.writeChunk({
            id: meta.id,
            offset,
            base64: Buffer.from(generated.bytes.subarray(offset, offset + 262_144)).toString(
              "base64",
            ),
          });
        }
        const file = await files.commit({ id: meta.id });
        const output: PluginImageResult = {
          requestId: value.requestId,
          status: "ready",
          file,
          width: generated.width,
          height: generated.height,
          model: config.model,
          costMicrocents: generated.costMicrocents,
          provenance: {
            prompt: value.prompt,
            references: value.references.map(({ id, sha256 }) => ({ id, sha256 })),
          },
        };
        await run(IMAGE_OPS.finish, {
          pluginId: plugin.pluginId,
          requestId: value.requestId,
          callId,
          result: output,
          costMicrocents: generated.costMicrocents,
          durationMs: generated.durationMs,
        });
        return output;
      } catch {
        // No provider headers, prompts or credentials reach the sandbox.
        await run(IMAGE_OPS.markUncertain, {
          pluginId: plugin.pluginId,
          requestId: value.requestId,
        });
        throw new Error(
          "PluginImageOutcomeUncertain: inspect this request; retrying requires a new paid request ID",
        );
      }
    },
  } satisfies PluginImages);
}
