// SPDX-License-Identifier: MPL-2.0

/**
 * `ctx.siteMedia.readChunk` input checks. The input arrives from plugin
 * code (for a sandboxed plugin, as JSON over the RPC channel), so a
 * malformed shape must fail with a named error before any permission
 * lookup, query, or byte fetch — none of the stubs below may be reached.
 */

import { describe, expect, it } from "bun:test";
import type { PluginSiteMedia } from "@caelo-cms/plugin-sdk";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import { makePluginSiteMedia } from "./site-media.js";

function unreachable(): never {
  throw new Error("input validation must run before the host is touched");
}

const plugin = {
  slug: "probe",
  pluginId: "11111111-1111-4111-8111-111111111111",
  pluginActorId: "22222222-2222-4222-8222-222222222222",
} as unknown as LoadedPlugin;
const infra = {
  get adapter() {
    return unreachable();
  },
  get registry() {
    return unreachable();
  },
  siteMediaBytes: unreachable,
} as unknown as PluginHostInfra;
const siteMedia = makePluginSiteMedia(plugin, infra, {
  origin: "system",
  actorId: "33333333-3333-4333-8333-333333333333",
});

type ReadChunkInput = Parameters<PluginSiteMedia["readChunk"]>[0];

describe("siteMedia.readChunk input validation", () => {
  const sha = "a".repeat(64);
  const id = "44444444-4444-4444-8444-444444444444";

  it.each([
    ["null", null],
    ["a string", "media-id"],
    ["missing id", { sha256: sha, offset: 0 }],
    ["non-string id", { id: 7, sha256: sha, offset: 0 }],
    ["missing sha256", { id, offset: 0 }],
    ["missing offset", { id, sha256: sha }],
    ["string offset", { id, sha256: sha, offset: "0" }],
  ])("rejects %s with SiteMediaInputInvalid", async (_label, input) => {
    await expect(siteMedia.readChunk(input as unknown as ReadChunkInput)).rejects.toThrow(
      "SiteMediaInputInvalid",
    );
  });

  it.each([
    ["negative", -262_144],
    ["fractional", 0.5],
    ["unaligned", 1000],
  ])("rejects a %s offset with SiteMediaOffsetInvalid", async (_label, offset) => {
    await expect(siteMedia.readChunk({ id, sha256: sha, offset })).rejects.toThrow(
      "SiteMediaOffsetInvalid",
    );
  });
});
