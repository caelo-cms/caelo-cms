// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — an installed plugin's workers go through the scheduler exactly
 * like a shipped plugin's, including #1720/#1728: an approved artifact
 * whose cron a newer croner refuses still loads, and only that worker stays
 * off the schedule. No database: the definition is built from the manifest
 * and scheduling is in memory.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { externalArtifactDigest } from "@caelo-cms/plugin-sandbox";
import type { PluginManifest } from "@caelo-cms/plugin-sdk";
import type { PluginHostInfra, runPluginOperation } from "./dispatch.js";
import { externalPluginDefinition } from "./external-plugin.js";
import { pluginWorkerScheduler } from "./scheduler.js";

const manifest: PluginManifest = {
  slug: "worker-probe",
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["tick"],
  hasStaticRender: false,
  hasBuildAssets: false,
  hasDeferrals: false,
  hasContentVariants: false,
  hasLinkResolve: false,
  hasShareImages: false,
  hasListResolve: false,
  workers: [
    { name: "good", cron: "* * * * *", operationName: "tick" },
    { name: "bad", cron: "61 * * * *", operationName: "tick" },
  ],
  requestedCapabilities: ["background_workers"],
  capabilityReasons: { background_workers: "Tick" },
};
const source = `export default {slug:"worker-probe",version:"1.0.0",tier:2,operations:{tick:async()=>null}};`;

afterEach(() => pluginWorkerScheduler.shutdown());

describe("external workers", () => {
  it("load from an approved artifact with a refused cron; only that worker is off the schedule", () => {
    const definition = externalPluginDefinition({
      pluginId: "11111111-1111-4111-8111-111111111111",
      approval: {
        artifactDigest: externalArtifactDigest(manifest, source),
        grantIds: ["1"],
        capabilities: ["background_workers"],
        systemActorId: "00000000-0000-0000-0000-00000000ffff",
      },
      manifest,
      source,
      infra: {} as PluginHostInfra,
      systemActorId: "00000000-0000-0000-0000-00000000ffff",
    });
    expect(definition.workers?.map((w) => w.name)).toEqual(["good", "bad"]);
    const off = pluginWorkerScheduler.schedule({
      pluginSlug: definition.slug,
      workers: definition.workers ?? [],
      dispatch: (async () => ({ ok: true, value: null })) as unknown as typeof runPluginOperation,
      pluginActorId: "22222222-2222-4222-8222-222222222222",
    });
    expect(off.map((w) => w.workerName)).toEqual(["bad"]);
    expect(pluginWorkerScheduler.list().map((w) => w.workerName)).toEqual(["good"]);
  });
});
