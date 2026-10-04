// SPDX-License-Identifier: MPL-2.0

/**
 * `ctx.siteMedia` (#530) — a broker over `plugin_site_media.*`
 * (site-media-ops.ts). Like `ctx.privateFiles`, it runs every operation as
 * the plugin with the running artifact's digest (the operation checks the
 * grant) and rechecks on every call that the human it acts for may author.
 * Bytes come through the host's `siteMediaBytes` hook, verified against
 * the requested sha256; the plugin never sees a storage key.
 */

import { createHash } from "node:crypto";
import type {
  PluginInvocation,
  PluginSiteMedia,
  PluginSiteMediaAsset,
} from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { hostSystemActorId, type LoadedPlugin, type PluginHostInfra } from "./dispatch.js";
import { operatorCanAuthor } from "./external-authorization.js";
import { registerPluginSiteMediaOps, SITE_MEDIA_OPS } from "./site-media-ops.js";

const CHUNK = 262_144;

export function makePluginSiteMedia(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
): PluginSiteMedia {
  const ctx = {
    actorId: plugin.pluginActorId,
    actorKind: "plugin" as const,
    pluginId: plugin.pluginId,
    requestId: `plugin-site-media-${plugin.slug}`,
    ...(plugin.externalApproval
      ? { pluginArtifactDigest: plugin.externalApproval.artifactDigest }
      : {}),
  };
  const operator = invocation.origin === "chat" ? invocation.operatorActorId : invocation.actorId;
  async function run<T>(operation: string, input: unknown): Promise<T> {
    if (!operator || !(await operatorCanAuthor(infra, hostSystemActorId(), operator))) {
      throw new Error("SiteMediaAuthorPermissionDenied");
    }
    registerPluginSiteMediaOps(infra.registry);
    const r = await execute(infra.registry, infra.adapter, ctx, operation, input);
    if (!r.ok) throw new Error("message" in r.error ? String(r.error.message) : r.error.kind);
    return r.value as T;
  }
  return Object.freeze({
    find: async (input) =>
      (await run<{ assets: PluginSiteMediaAsset[] }>(SITE_MEDIA_OPS.find, input)).assets,
    inspect: async (input) =>
      (await run<{ assets: PluginSiteMediaAsset[] }>(SITE_MEDIA_OPS.inspect, input)).assets,
    readChunk: async (input) => {
      if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset % CHUNK !== 0) {
        throw new Error("SiteMediaOffsetInvalid: offsets are multiples of 262144");
      }
      if (!infra.siteMediaBytes) throw new Error("SiteMediaUnavailable");
      const located = await run<{ storageKey: string; sizeBytes: number }>(SITE_MEDIA_OPS.read, {
        id: input.id,
        sha256: input.sha256,
      });
      if (input.offset >= located.sizeBytes && located.sizeBytes > 0) {
        throw new Error("SiteMediaOffsetInvalid: past the end of the image");
      }
      const bytes = await infra.siteMediaBytes(located.storageKey);
      // The row's sha256 names the original's bytes; refuse anything else.
      if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) {
        throw new Error("SiteMediaIntegrityMismatch");
      }
      return {
        base64: Buffer.from(bytes.subarray(input.offset, input.offset + CHUNK)).toString("base64"),
      };
    },
  } satisfies PluginSiteMedia);
}
