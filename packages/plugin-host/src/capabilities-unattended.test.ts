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
import { OperationRegistry } from "@caelo-cms/query-api";
import { makePluginContext } from "./capabilities.js";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";

const ADMIN_INFRA = {
  adapter: { hasAdminDatabase: true } as never,
  registry: new OperationRegistry(),
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
      cmsOperations: capabilities.includes("cms_admin") ? ["pages.list"] : null,
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

async function ctxFor(
  plugin: LoadedPlugin,
  invocation: PluginInvocation,
  infra = ADMIN_INFRA,
  sandboxKind?: "journal" | "rebuild",
) {
  return (await makePluginContext({
    plugin,
    infra,
    invocation,
    ...(sandboxKind ? { sandboxKind } : {}),
  })) as PluginContextTier1;
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

  it("without the receipt there is no storage, and a render never gets it", async () => {
    expect((await ctxFor(external([]), { origin: "worker", actorId })).adminQuery).toBeUndefined();
    expect(
      (await ctxFor(external(["cms_admin_schema"]), { origin: "render", actorId })).adminQuery,
    ).toBeUndefined();
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

describe("#1729 — the cms_admin and change_journal brokers in a runtime-installed plugin's context", () => {
  const branch = "33333333-3333-4333-8333-333333333333";

  it("a journal batch on a chat's branch acts unattended on that branch: storage and core calls", async () => {
    const ctx = await ctxFor(
      external(["cms_admin_schema", "cms_admin"]),
      { origin: "chat", actorId, chatBranchId: branch },
      ADMIN_INFRA,
      "journal",
    );
    expect(ctx.adminQuery).toBeDefined();
    expect(ctx.cms).toBeDefined();
    expect(ctx.invocation.chatBranchId).toBe(branch);
    // Without the journal kind the same chat call (no person behind it) gets neither.
    const plain = await ctxFor(external(["cms_admin_schema", "cms_admin"]), {
      origin: "chat",
      actorId,
      chatBranchId: branch,
    });
    expect(plain.adminQuery).toBeUndefined();
    expect(plain.cms).toBeUndefined();
  });

  it("a render gets core reads through ctx.cms and refuses its writes, and no author handle", async () => {
    const ctx = await ctxFor(external(["cms_admin_schema", "cms_admin"]), {
      origin: "render",
      actorId,
    });
    expect(ctx.adminQuery).toBeUndefined();
    expect(ctx.cms).toBeDefined();
    // The registry of this fixture holds nothing: the handle refuses before any database call.
    await expect(ctx.cms?.call("pages.update", {}) as Promise<unknown>).rejects.toThrow(
      "no operation of that name",
    );
  });

  it("refuses public-table writes from journal batches and rebuilds, for every plugin (Q12)", async () => {
    const withPublic = external(["cms_admin_schema"], { schema: { pub: { body: "text" } } });
    for (const kind of ["journal", "rebuild"] as const) {
      const ctx = await ctxFor(withPublic, { origin: "system", actorId }, ADMIN_INFRA, kind);
      await expect(ctx.query.insert("pub", { body: "x" }) as Promise<unknown>).rejects.toThrow(
        "cannot write its public tables from a change-journal",
      );
    }
    const shipped: LoadedPlugin = {
      ...withPublic,
      provenance: "release-signed",
      externalApproval: undefined,
      definition: { ...withPublic.definition, tier: 1 } as unknown as PluginDefinition,
    } as LoadedPlugin;
    const ctx = await ctxFor(shipped, { origin: "system", actorId }, ADMIN_INFRA, "journal");
    await expect(ctx.query.insert("pub", { body: "x" }) as Promise<unknown>).rejects.toThrow(
      "cannot write its public tables from a change-journal batch",
    );
  });
});
