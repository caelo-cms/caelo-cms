// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1645) — `ctx.config.entities` takes any number of ids, as
 * the SDK promises: the reader asks the host op in its bounded chunks, so
 * an observer digest over a site with many configured modules never meets
 * the op's input limit.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { makePluginConfigReader } from "./config-handle.js";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";

const PLUGIN = {
  pluginId: "00000000-0000-4000-8000-0000000c0f11",
  pluginActorId: "00000000-0000-4000-8000-0000000c0f12",
  slug: "t1644-config-reader",
  definition: { entityConfig: { module: { mode: { type: "string" } } } },
} as unknown as LoadedPlugin;

describe("the config reader", () => {
  it("reads 12,001 entities in chunks the op accepts", async () => {
    const asked: number[] = [];
    const adapter = {
      runOperation: (op: { name: string }, _ctx: unknown, input: { ids?: string[] }) => {
        if (op.name !== "plugin_config.get_entities") throw new Error(`unexpected op ${op.name}`);
        const ids = input.ids ?? [];
        asked.push(ids.length);
        return ok({ entities: ids.map((id) => ({ id, values: { mode: id } })) });
      },
    } as unknown as DatabaseAdapter;
    const infra = { registry: new OperationRegistry(), adapter } as unknown as PluginHostInfra;
    const reader = makePluginConfigReader(PLUGIN, infra, {
      origin: "observer",
      actorId: PLUGIN.pluginActorId,
    });
    const ids = Array.from({ length: 12_001 }, (_, i) => `m${i}`);
    const values = await reader.entities("module", ids);
    expect(asked).toEqual([5000, 5000, 2001]);
    expect(values.size).toBe(12_001);
    expect(values.get("m12000")).toEqual({ mode: "m12000" });
  });
});
