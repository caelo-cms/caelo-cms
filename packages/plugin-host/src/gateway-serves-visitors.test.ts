// SPDX-License-Identifier: MPL-2.0

/**
 * #1339 (epic #763 E14 a) — servesVisitorOperations is `false` only when the
 * gateway knows no active plugin serves visitors: an active plugin it could
 * not attach (a transient artifact read failure) leaves it unknown, so the
 * gateway keeps retrying instead of caching "off" (Codex review on #1429).
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import {
  bootstrapDispatchOnly,
  markDispatchRegistryStale,
  resetDispatchOnlyHost,
  servesVisitorOperations,
  syncDispatchPlugins,
} from "./gateway-attach.js";

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

/**
 * A cms_public adapter that answers the published-section check, then the
 * registry with `registry`, and fails every other read (the artifact).
 */
function fakeAdapter(registry: () => unknown[]): DatabaseAdapter {
  return {
    withPublicTransaction: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      let call = 0;
      return fn({
        execute: async () => {
          call++;
          if (call === 1) return [{ ok: 1 }];
          if (call === 2) return registry();
          throw new Error("connection reset");
        },
      });
    },
  } as unknown as DatabaseAdapter;
}

const runtimeAuthored = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "visitor-form",
  tier: 2,
  version: "1.0.0",
  actor_id: "22222222-2222-4222-8222-222222222222",
  approved_capabilities: null,
  approved_manifest_digest: null,
};

afterEach(() => resetDispatchOnlyHost());

describe("servesVisitorOperations (#1339)", () => {
  it("is false when the registry has no active plugin", async () => {
    await bootstrapDispatchOnly({
      infra: { adapter: fakeAdapter(() => []), registry: {} as never },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [],
    });
    expect(servesVisitorOperations()).toBe(false);
    // A publish notification makes it unknown until the next sync.
    markDispatchRegistryStale();
    expect(servesVisitorOperations()).toBeNull();
    await syncDispatchPlugins();
    expect(servesVisitorOperations()).toBe(false);
  });

  it("is unknown, not false, while an active plugin could not be attached", async () => {
    await bootstrapDispatchOnly({
      infra: { adapter: fakeAdapter(() => [runtimeAuthored]), registry: {} as never },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [],
    });
    expect(servesVisitorOperations()).toBeNull();
  });
});
