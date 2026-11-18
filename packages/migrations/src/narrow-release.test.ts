// SPDX-License-Identifier: MPL-2.0

/**
 * What a frozen release state publishes now (`narrowRelease`, #1329):
 * narrowing reaches both public databases at once, and a release-signed
 * plugin's approval is the Owner's current one (#1587). Its code is the one
 * in each gateway's image, so the approval frozen with the last Stage names
 * a release a Caelo update has replaced; published, it kept the live gateway
 * refusing the plugin until the next Publish live.
 */

import { describe, expect, it } from "bun:test";
import { type CurrentNarrowing, narrowRelease, type ReleaseState } from "./public-projection.js";

const SHIPPED = "11111111-1111-4111-8111-111111111111";
const AUTHORED = "22222222-2222-4222-8222-222222222222";
const BEFORE_UPDATE = "a".repeat(64);
const AFTER_UPDATE = "b".repeat(64);

const frozen: ReleaseState = {
  version: 1,
  plugins: [
    {
      id: SHIPPED,
      slug: "consent-manager",
      tier: 1,
      version: "0.1.0",
      actor_id: "33333333-3333-4333-8333-333333333333",
      manifest_json: null,
      source_code: null,
      approved_capabilities: [],
      approved_manifest_digest: BEFORE_UPDATE,
    },
    {
      id: AUTHORED,
      slug: "visitor-form",
      tier: 2,
      version: "1.0.0",
      actor_id: "44444444-4444-4444-8444-444444444444",
      manifest_json: { slug: "visitor-form" },
      source_code: "export default {}",
      approved_capabilities: null,
      approved_manifest_digest: null,
    },
  ],
  grants: [{ id: "7", plugin_id: AUTHORED, artifact_digest: "c".repeat(64), capability: "x" }],
  pluginRows: [{ plugin_id: SHIPPED, table_name: "settings", row_id: "r1", row: {} }],
  projected: [SHIPPED],
};

function now(overrides: Partial<CurrentNarrowing> = {}): CurrentNarrowing {
  return {
    activePluginIds: new Set([SHIPPED, AUTHORED]),
    liveGrantIds: new Set(["7"]),
    releaseSignedApprovals: new Map([
      [SHIPPED, { capabilities: ["snapshots"], manifestDigest: AFTER_UPDATE }],
    ]),
    pluginActorIds: new Map([
      [SHIPPED, "33333333-3333-4333-8333-333333333333"],
      [AUTHORED, "44444444-4444-4444-8444-444444444444"],
    ]),
    ...overrides,
  };
}

describe("narrowRelease", () => {
  it("publishes a release-signed plugin's approval as the Owner holds it now (#1587)", () => {
    const published = narrowRelease(frozen, now());
    expect(published.plugins[0]).toMatchObject({
      id: SHIPPED,
      approved_capabilities: ["snapshots"],
      approved_manifest_digest: AFTER_UPDATE,
    });
    // Everything else of the release stays as it was frozen.
    expect(published.plugins[1]).toEqual(frozen.plugins[1] as Record<string, unknown>);
    expect(published.pluginRows).toEqual(frozen.pluginRows);
    expect(published.grants).toEqual(frozen.grants);
  });

  it("publishes no approval for an active release-signed plugin that has none", () => {
    const published = narrowRelease(
      frozen,
      now({
        releaseSignedApprovals: new Map([[SHIPPED, { capabilities: null, manifestDigest: null }]]),
      }),
    );
    expect(published.plugins[0]).toMatchObject({
      approved_capabilities: null,
      approved_manifest_digest: null,
    });
    const missing = narrowRelease(frozen, now({ releaseSignedApprovals: new Map() }));
    expect(missing.plugins[0]).toMatchObject({
      approved_capabilities: null,
      approved_manifest_digest: null,
    });
  });

  it("still adds no plugin: an activation follows the release", () => {
    const published = narrowRelease(
      { ...frozen, plugins: [], grants: [], pluginRows: [], projected: [] },
      now(),
    );
    expect(published.plugins).toEqual([]);
  });

  it("leaves out a plugin deactivated and a grant revoked since the freeze", () => {
    const published = narrowRelease(
      frozen,
      now({ activePluginIds: new Set([AUTHORED]), liveGrantIds: new Set() }),
    );
    expect(published.plugins.map((p) => p.id)).toEqual([AUTHORED]);
    expect(published.grants).toEqual([]);
    expect(published.pluginRows).toEqual([]);
    expect(published.projected).toEqual([]);
  });
});
