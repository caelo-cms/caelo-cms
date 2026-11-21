// SPDX-License-Identifier: MPL-2.0

/**
 * Where an ai-chat request meets the gateway (#1654): the declared
 * conversation of an attached plugin, its tools resolved to active plugins'
 * search and read operations, and the runtime that runs them on this
 * environment's collection releases. server.ts routes; chat.ts answers.
 */

import {
  isPluginDisabled,
  loadedPlugins,
  runCollectionOperation,
} from "@caelo-cms/plugin-host/gateway";
import {
  type AiChatOperationManifest,
  aiChatOperationManifest,
  type ConfigLeaf,
  configLeaves,
  parseConfigSchema,
} from "@caelo-cms/plugin-sdk";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import {
  declaredCollectionOperation,
  defaultQueryEmbedder,
  type GatewayCollections,
} from "../collections.js";
import type { AiChatContext } from "./chat.js";
import type { ResolvedTool, ToolRuntime } from "./tools.js";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "gateway-visitor-ai-tools",
};

/** The attached plugin's declared conversation `operation`, re-validated, or null. */
export function declaredAiChatOperation(
  slug: string,
  operation: string,
): {
  readonly pluginId: string;
  readonly op: AiChatOperationManifest;
  readonly config: ReadonlyMap<string, ConfigLeaf["field"]>;
} | null {
  const plugin = loadedPlugins.bySlug(slug);
  if (!plugin || isPluginDisabled(slug)) return null;
  const raw = (plugin.definition.aiChatOperations ?? []).find((o) => o.name === operation);
  if (!raw) return null;
  const parsed = aiChatOperationManifest.safeParse(raw);
  if (!parsed.success) return null;
  let leaves: ConfigLeaf[] = [];
  try {
    leaves = plugin.definition.config
      ? configLeaves(parseConfigSchema(plugin.definition.config))
      : [];
  } catch {
    return null;
  }
  return {
    pluginId: plugin.pluginId,
    op: parsed.data,
    config: new Map(leaves.map((l) => [l.path, l.field])),
  };
}

/**
 * The declaration's tools as active plugins' search and read operations.
 * One that does not resolve (its plugin is not active, the operation is
 * gone or is not search/read) makes the conversation unavailable: it is
 * never answered with fewer tools than the Owner approved.
 */
export function resolveAiChatTools(op: AiChatOperationManifest): AiChatContext["tools"] {
  const tools: ResolvedTool[] = [];
  for (const decl of op.tools) {
    const found = declaredCollectionOperation(decl.plugin, decl.operation);
    if (!found)
      return {
        ok: false,
        problem: `tool ${decl.plugin}/${decl.operation} is not an active plugin's collection operation`,
      };
    if (found.op.kind !== "search" && found.op.kind !== "read")
      return {
        ok: false,
        problem: `tool ${decl.plugin}/${decl.operation} is a ${found.op.kind} operation`,
      };
    tools.push({ decl, pluginId: found.pluginId, op: found.op });
  }
  return { ok: true, tools };
}

/** Runs tools on this gateway's published collection releases. */
export function collectionToolRuntime(
  adapter: DatabaseAdapter,
  collections: GatewayCollections,
  mayCache: () => boolean,
): ToolRuntime {
  return {
    async release(t) {
      const keys = await collections.releaseKeys(adapter, SYSTEM_CTX, mayCache);
      const key = keys.get(`${t.pluginId}:${t.op.collection}`);
      if (!key) return null;
      const entry = await collections.release(t.decl.plugin, t.op.collection, key);
      const anchorsOf = t.op.kind === "search" ? t.op.anchors : undefined;
      const anchorKey = anchorsOf ? keys.get(`${t.pluginId}:${anchorsOf.collection}`) : undefined;
      const anchors =
        anchorsOf && anchorKey
          ? await collections.release(t.decl.plugin, anchorsOf.collection, anchorKey)
          : null;
      return { entry, key, anchors };
    },
    run: (t, release, params) =>
      runCollectionOperation(t.op, release.entry, release.key, params, {
        embedQuery: defaultQueryEmbedder(),
        anchors: release.anchors,
      }),
  };
}
