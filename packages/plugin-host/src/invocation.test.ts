// SPDX-License-Identifier: MPL-2.0

/**
 * CMS_REQUIREMENTS §14.7 — every plugin call carries who it acts for and
 * on which branch. A missing or self-contradicting invocation must fail
 * loudly: silently acting as "main, nobody" is the defect this closes.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1, PluginDefinition } from "@caelo-cms/plugin-sdk";
import { makePluginContext } from "./capabilities.js";
import { assertInvocationConsistent, type LoadedPlugin, type PluginHostInfra } from "./dispatch.js";

const VISITOR = { visitorId: "v", sessionToken: null };
const BRANCH = "22222222-2222-4222-8222-222222222222";

describe("assertInvocationConsistent", () => {
  it("accepts each origin in its legitimate shape", () => {
    expect(() =>
      assertInvocationConsistent(
        { origin: "chat", actorId: "ai", chatBranchId: BRANCH },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      assertInvocationConsistent({ origin: "visitor", actorId: "v" }, VISITOR),
    ).not.toThrow();
    for (const origin of ["owner-panel", "approved", "worker", "render", "system"] as const) {
      expect(() => assertInvocationConsistent({ origin, actorId: "a" }, undefined)).not.toThrow();
    }
    expect(() =>
      assertInvocationConsistent(
        { origin: "render", actorId: "a", chatBranchId: BRANCH },
        undefined,
      ),
    ).not.toThrow();
  });

  it("rejects a missing invocation or actor", () => {
    expect(() => assertInvocationConsistent(undefined as never, undefined)).toThrow(
      "PluginInvocationInvalid",
    );
    expect(() => assertInvocationConsistent({ origin: "system", actorId: "" }, undefined)).toThrow(
      "actorId",
    );
  });

  it("rejects a visitor origin without a visitor context, and the reverse", () => {
    expect(() =>
      assertInvocationConsistent({ origin: "visitor", actorId: "v" }, undefined),
    ).toThrow("PluginInvocationInvalid");
    expect(() => assertInvocationConsistent({ origin: "system", actorId: "a" }, VISITOR)).toThrow(
      "PluginInvocationInvalid",
    );
  });

  it("rejects a chat call without its branch, and a branch where none can exist", () => {
    expect(() => assertInvocationConsistent({ origin: "chat", actorId: "ai" }, undefined)).toThrow(
      "branch",
    );
    for (const origin of ["owner-panel", "approved", "worker", "system"] as const) {
      expect(() =>
        assertInvocationConsistent({ origin, actorId: "a", chatBranchId: BRANCH }, undefined),
      ).toThrow("cannot carry a chat branch");
    }
  });
});

describe("ctx.invocation", () => {
  it("reaches the plugin, frozen", async () => {
    const plugin = {
      pluginId: "11111111-1111-4111-8111-111111111111",
      slug: "invocation-probe",
      version: "1.0.0",
      tier: 1,
      provenance: "release-signed",
      pluginActorId: "33333333-3333-4333-8333-333333333333",
      definition: {
        slug: "invocation-probe",
        version: "1.0.0",
        schema: {},
        operations: {},
      } as unknown as PluginDefinition<PluginContextTier1>,
    } as unknown as LoadedPlugin;
    const infra = { adapter: {} as never, registry: {} as never } satisfies PluginHostInfra;
    const invocation = {
      origin: "chat" as const,
      actorId: "ai",
      operatorActorId: "owner",
      chatBranchId: BRANCH,
      chatTaskId: "task",
    };
    const ctx = await makePluginContext({ plugin, infra, invocation });
    expect(ctx.invocation).toEqual(invocation);
    expect(Object.isFrozen(ctx.invocation)).toBe(true);
  });
});
