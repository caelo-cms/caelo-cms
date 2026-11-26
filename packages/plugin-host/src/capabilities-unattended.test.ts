// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 decision Q1 A — what a runtime-installed plugin's context holds in a
 * call that acts for nobody (a worker run, `onActivate`, a journal batch on
 * main, an observer, a batch): private storage on main, as the plugin
 * actor, when the Owner granted it for the running artifact, and nothing
 * else. Render and visitor calls stay without author handles, and the
 * gateway gets the read-only visitor projection only. No database:
 * building the handles touches none.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1, PluginDefinition, PluginInvocation } from "@caelo-cms/plugin-sdk";
import { makePluginContext } from "./capabilities.js";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";

const ADMIN_INFRA = {
  adapter: { hasAdminDatabase: true } as never,
  registry: {} as never,
} satisfies PluginHostInfra;
const GATEWAY_INFRA = {
  adapter: { hasAdminDatabase: false } as never,
  registry: {} as never,
} satisfies PluginHostInfra;

function external(capabilities: string[], extra: Record<string, unknown> = {}): LoadedPlugin {
  return {
    pluginId: "11111111-1111-4111-8111-111111111111",
    slug: "unattended-probe",
    version: "1.0.0",
    tier: 2,
    provenance: "runtime-authored",
    pluginActorId: "22222222-2222-4222-8222-222222222222",
    externalApproval: {
      artifactDigest: "d".repeat(64),
      grantIds: ["1"],
      capabilities: capabilities as never,
      systemActorId: "00000000-0000-0000-0000-00000000ffff",
    },
    definition: {
      slug: "unattended-probe",
      version: "1.0.0",
      tier: 2,
      schema: {},
      adminSchema: { notes: { body: "text" } },
      operations: {},
      ...extra,
    } as unknown as PluginDefinition,
  };
}

async function ctxFor(plugin: LoadedPlugin, invocation: PluginInvocation, infra = ADMIN_INFRA) {
  return (await makePluginContext({ plugin, infra, invocation })) as PluginContextTier1;
}

const actorId = "22222222-2222-4222-8222-222222222222";

describe("#1729 Q1 A — unattended calls of a runtime-installed plugin", () => {
  it("worker, system, observer and batch get private storage on main", async () => {
    for (const invocation of [
      { origin: "worker", actorId },
      { origin: "system", actorId },
      { origin: "observer", actorId, stageRunId: actorId },
      { origin: "batch", actorId, batchRunId: actorId },
    ] as PluginInvocation[]) {
      const ctx = await ctxFor(external(["cms_admin_schema"]), invocation);
      expect({ origin: invocation.origin, storage: Boolean(ctx.adminQuery) }).toEqual({
        origin: invocation.origin,
        storage: true,
      });
      // Nothing beyond private storage: no files, images, fonts or media.
      expect(ctx.privateFiles).toBeUndefined();
      expect(ctx.fonts).toBeUndefined();
      expect(ctx.siteMedia).toBeUndefined();
    }
  });

  it("without the receipt there is no storage, on any origin", async () => {
    expect((await ctxFor(external([]), { origin: "worker", actorId })).adminQuery).toBeUndefined();
    expect((await ctxFor(external([]), { origin: "render", actorId })).adminQuery).toBeUndefined();
  });

  it("a render point reads private storage and cannot write it (#1729)", async () => {
    const render = await ctxFor(external(["cms_admin_schema"]), { origin: "render", actorId });
    expect(render.adminQuery).toBeDefined();
    await expect(
      render.adminQuery?.insert("notes", { body: "x" }) as Promise<unknown>,
    ).rejects.toThrow("cannot write from a render call");
  });

  it("the gateway gets the read-only visitor projection, only when one is declared", async () => {
    const projected = await ctxFor(
      external(["cms_admin_schema"], { visitorProjection: { notes: ["body"] } }),
      { origin: "system", actorId },
      GATEWAY_INFRA,
    );
    expect(projected.adminQuery).toBeDefined();
    await expect(
      projected.adminQuery?.insert("notes", { body: "x" }) as Promise<unknown>,
    ).rejects.toThrow("the public side cannot write private storage");
    const without = await ctxFor(
      external(["cms_admin_schema"]),
      { origin: "system", actorId },
      GATEWAY_INFRA,
    );
    expect(without.adminQuery).toBeUndefined();
  });
});
