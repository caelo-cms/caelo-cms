// SPDX-License-Identifier: MPL-2.0

/**
 * `ctx.privateFiles` — a broker over the `plugin_files.*` operations
 * (file-ops.ts). It validates nothing itself and holds no credentials:
 * every call runs the operation as the plugin, with the invocation's chat
 * branch and the running artifact's digest, and the operation checks the
 * grant in its own transaction. Attached only for an authoring invocation
 * whose human may author content (capabilities.ts).
 */

import type { PluginInvocation, PluginPrivateFiles } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { hostSystemActorId, type LoadedPlugin, type PluginHostInfra } from "./dispatch.js";
import { operatorCanAuthor } from "./external-authorization.js";
import { FILE_OPS, registerPluginFileOps } from "./file-ops.js";

export function makePluginPrivateFiles(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
): PluginPrivateFiles {
  const ctx = {
    actorId: plugin.pluginActorId,
    actorKind: "plugin" as const,
    pluginId: plugin.pluginId,
    requestId: `plugin-files-${plugin.slug}`,
    ...(invocation.chatBranchId ? { chatBranchId: invocation.chatBranchId } : {}),
    ...(plugin.externalApproval
      ? { pluginArtifactDigest: plugin.externalApproval.artifactDigest }
      : {}),
  };
  const operator = invocation.origin === "chat" ? invocation.operatorActorId : invocation.actorId;
  async function run<T>(operation: string, input: unknown): Promise<T> {
    // A handle kept past its invocation must stop once the author loses
    // content.write — files are author data.
    if (!operator || !(await operatorCanAuthor(infra, hostSystemActorId(), operator))) {
      throw new Error("PrivateFileAuthorPermissionDenied");
    }
    registerPluginFileOps(infra.registry);
    const r = await execute(infra.registry, infra.adapter, ctx, operation, input);
    if (!r.ok) throw new Error("message" in r.error ? String(r.error.message) : r.error.kind);
    return r.value as T;
  }
  return Object.freeze({
    begin: (input) => run(FILE_OPS.begin, input),
    writeChunk: async (input) => {
      await run(FILE_OPS.writeChunk, input);
    },
    commit: (input) => run(FILE_OPS.commit, input),
    stat: (input) => run(FILE_OPS.stat, input),
    readChunk: (input) => run(FILE_OPS.readChunk, input),
    remove: async (input) => {
      await run(FILE_OPS.remove, input);
    },
  } satisfies PluginPrivateFiles);
}
