// SPDX-License-Identifier: MPL-2.0

/**
 * `ctx.config` (epic #1644, R6): a broker over the `plugin_config.*`
 * operations, like `ctx.adminQuery` over `plugin_storage.*`. A call reads
 * the configuration on the invocation's branch: a chat sees its own
 * unmerged changes, a Stage and a job see what was staged. The gateway
 * gets no handle; what visitors' requests need of the configuration
 * reaches it frozen in the collection's search profile.
 */

import type { ConfigEntityKind, PluginConfigReader, PluginInvocation } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import {
  isPluginDisabled,
  type LoadedPlugin,
  loadedPlugins,
  type PluginHostInfra,
} from "./dispatch.js";
import { CONFIG_OPS, loadedConfigLookup, registerPluginConfigOps } from "./plugin-config.js";

/** Registers the configuration operations against this host's loaded plugins. */
export function ensureConfigOps(infra: PluginHostInfra): void {
  registerPluginConfigOps(infra.registry, {
    lockPluginRow: infra.lockPluginRow,
    lookup: loadedConfigLookup((slug) => loadedPlugins.bySlug(slug), isPluginDisabled),
  });
}

/** True when the plugin declares anything `ctx.config` reads. */
export function hasConfig(plugin: LoadedPlugin): boolean {
  return Boolean(plugin.definition.config || plugin.definition.entityConfig);
}

/** The `ctx.config` handle of one invocation. */
export function makePluginConfigReader(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
): PluginConfigReader {
  ensureConfigOps(infra);
  const ctx = {
    actorId: plugin.pluginActorId,
    actorKind: "plugin" as const,
    pluginId: plugin.pluginId,
    requestId: `plugin-${plugin.slug}-config`,
    ...(invocation.chatBranchId ? { chatBranchId: invocation.chatBranchId } : {}),
    ...(invocation.chatTaskId ? { chatTaskId: invocation.chatTaskId } : {}),
  };
  async function run<T>(op: string, input: unknown): Promise<T> {
    const r = await execute(infra.registry, infra.adapter, ctx, op, input);
    if (!r.ok) throw new Error("message" in r.error ? String(r.error.message) : r.error.kind);
    return r.value as T;
  }
  const entities = async (
    kind: ConfigEntityKind,
    ids: readonly string[] | undefined,
    configuredOnly: boolean,
  ) =>
    (
      await run<{ entities: { id: string; values: Record<string, unknown> }[] }>(
        CONFIG_OPS.getEntities,
        { pluginSlug: plugin.slug, kind, ids, configuredOnly },
      )
    ).entities;
  return Object.freeze({
    get: async () =>
      (await run<{ values: Record<string, unknown> }>(CONFIG_OPS.get, { pluginSlug: plugin.slug }))
        .values,
    entity: async (kind: ConfigEntityKind, id: string) =>
      (await entities(kind, [id], false))[0]?.values ?? {},
    entities: async (kind: ConfigEntityKind, ids: readonly string[]) =>
      new Map((await entities(kind, ids, false)).map((e) => [e.id, e.values] as const)),
    configured: async (kind: ConfigEntityKind) =>
      (await entities(kind, undefined, true)).map((e) => e.id),
  });
}

/** An active plugin with something to configure, for the settings overview. */
export interface ConfigurablePlugin {
  readonly slug: string;
  readonly version: string;
  readonly hasConfig: boolean;
  readonly entityKinds: readonly string[];
}

/** Every active plugin that declares `config` or `entityConfig`, by slug. */
export function configurablePlugins(): ConfigurablePlugin[] {
  return loadedPlugins
    .all()
    .filter((p) => hasConfig(p) && !isPluginDisabled(p.slug))
    .map((p) => ({
      slug: p.slug,
      version: p.version,
      hasConfig: Boolean(p.definition.config),
      entityKinds: Object.keys(p.definition.entityConfig ?? {}),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
