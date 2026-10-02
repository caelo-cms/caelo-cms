// SPDX-License-Identifier: MPL-2.0

/**
 * `ctx.fonts` — read access to the shared font library for a plugin
 * holding `font_assets` (shipped plugins by manifest, installed ones by an
 * Owner grant for the exact artifact). Every call rechecks that the human
 * the plugin acts for may author content; the grant itself is checked in
 * the read's own transaction by `plugin_fonts.read` (font-ops.ts).
 */

import type { PluginFonts, PluginInvocation } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { hostSystemActorId, type LoadedPlugin, type PluginHostInfra } from "./dispatch.js";
import { operatorCanAuthor } from "./external-authorization.js";
import { FONT_READ_OP, type PluginFontRead, registerPluginFontOps } from "./font-ops.js";

export function makePluginFonts(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
): PluginFonts {
  const operator = invocation.origin === "chat" ? invocation.operatorActorId : invocation.actorId;

  async function read<T>(which: PluginFontRead, input: unknown): Promise<T> {
    if (!operator || !(await operatorCanAuthor(infra, hostSystemActorId(), operator))) {
      throw new Error("PluginFontAuthorPermissionDenied");
    }
    registerPluginFontOps(infra.registry);
    const r = await execute(
      infra.registry,
      infra.adapter,
      {
        actorId: hostSystemActorId(),
        actorKind: "system",
        requestId: `plugin-fonts-${plugin.slug}`,
      },
      FONT_READ_OP,
      {
        pluginId: plugin.pluginId,
        ...(plugin.externalApproval
          ? { pluginArtifactDigest: plugin.externalApproval.artifactDigest }
          : {}),
        read: which,
        input,
      },
    );
    if (!r.ok) {
      // Font names and bytes are not secret, but provider paths are: keep it short.
      throw new Error(
        `PluginFontOperationFailed: ${"message" in r.error ? r.error.message : r.error.kind}`,
      );
    }
    return r.value as T;
  }

  return Object.freeze<PluginFonts>({
    find: (input) => read("find", input),
    inspect: (input) => read("inspect", input),
    resolve: (input) => read("resolve", input),
    readChunk: (input) => read("read_chunk", input),
  });
}
