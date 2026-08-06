// SPDX-License-Identifier: MPL-2.0

/**
 * #388 adversarial — the provenance grantability ceiling, enforced at
 * the runtime capability factory independently of the validator: a
 * runtime-authored plugin whose definition (somehow) requests elevated
 * capabilities still receives ONLY the sandbox base context.
 *
 * No DB: makePluginContext builds closures without touching the
 * adapter; only actual ctx.query/cms calls would.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1, PluginDefinition } from "@caelo-cms/plugin-sdk";
import { makePluginContext } from "./capabilities.js";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";

const FAKE_INFRA = {
  adapter: {} as never,
  registry: {} as never,
  aiProvider: { complete: async () => ({ text: "", inputTokens: 0, outputTokens: 0 }) },
  emitSnapshot: (async () => ({ siteSnapshotId: "s" })) as never,
} satisfies PluginHostInfra;

function makeLoaded(overrides: Partial<LoadedPlugin>): LoadedPlugin {
  const definition = {
    slug: "ceiling-probe",
    version: "1.0.0",
    tier: 1,
    schema: {},
    operations: { noop: async () => ({}) },
    // The over-reach under test: every elevated capability requested.
    requestedCapabilities: ["cms_admin", "ai_provider", "snapshots", "email"],
  } as unknown as PluginDefinition<PluginContextTier1>;
  return {
    pluginId: "11111111-1111-4111-8111-111111111111",
    slug: "ceiling-probe",
    version: "1.0.0",
    tier: 1,
    provenance: "release-signed",
    definition,
    pluginActorId: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

describe("#388 — provenance grantability ceiling at the capability factory", () => {
  it("release-signed: requested elevated handles are attached", async () => {
    const ctx = (await makePluginContext({
      plugin: makeLoaded({}),
      infra: FAKE_INFRA,
    })) as PluginContextTier1;
    expect(ctx.cms).toBeDefined();
    expect(ctx.ai).toBeDefined();
    expect(ctx.snapshots).toBeDefined();
    expect(ctx.email).toBeDefined();
  });

  it("runtime-authored: the SAME definition gets the sandbox base only", async () => {
    const ctx = (await makePluginContext({
      plugin: makeLoaded({ provenance: "runtime-authored", tier: 2 }),
      infra: FAKE_INFRA,
    })) as PluginContextTier1;
    expect(ctx.query).toBeDefined();
    expect(ctx.captcha).toBeDefined();
    expect(ctx.cms).toBeUndefined();
    expect(ctx.ai).toBeUndefined();
    expect(ctx.snapshots).toBeUndefined();
    expect(ctx.email).toBeUndefined();
  });

  it("runtime-authored provenance wins even when tier says 1 (defense in depth)", async () => {
    // A drifted row/registration where tier and provenance disagree must
    // fail CLOSED: provenance is the authority.
    const ctx = (await makePluginContext({
      plugin: makeLoaded({ provenance: "runtime-authored", tier: 1 }),
      infra: FAKE_INFRA,
    })) as PluginContextTier1;
    expect(ctx.cms).toBeUndefined();
    expect(ctx.ai).toBeUndefined();
  });
});
