// SPDX-License-Identifier: MPL-2.0

/**
 * #741 — on an AI-delegated call (Power-MCP) minting a module never runs
 * moduleize on the install's AI: raw HTML without `fields[]` is refused
 * before anything is read or written, with what to send instead.
 */

import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import { DELEGATED_MINT_NEEDS_FIELDS, mintModuleFromHtml } from "./_mint-module.js";
import type { ToolContext } from "./dispatch.js";

const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000002",
  actorKind: "ai",
  requestId: "mint-delegated-test",
};

/** Any database or provider access fails the test. */
const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error("must not be reached on a refused delegated mint");
    },
  },
);

describe("mintModuleFromHtml on an AI-delegated call", () => {
  it("refuses raw HTML without fields[] and says what to send", async () => {
    const r = await mintModuleFromHtml(
      ctx,
      {
        adapter: untouchable,
        registry: untouchable,
        provider: untouchable,
        aiDelegated: true,
      } as unknown as ToolContext,
      { html: "<section><h2>Raw heading</h2></section>", displayNameHint: "Raw" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.content).toBe(DELEGATED_MINT_NEEDS_FIELDS);
    expect(r.content).toContain("fields[]");
  });
});

/**
 * A tool context that records every `modules.create` (other ops succeed); the
 * provider fails the test if moduleize runs when it must not.
 */
function recordingToolCtx(provider: unknown): { toolCtx: ToolContext; created: unknown[] } {
  const created: unknown[] = [];
  const registry = {
    lookup: (name: string) => ({
      ok: true,
      value: {
        name,
        actorScope: ["human", "ai", "system"],
        input: { safeParse: (v: unknown) => ({ success: true, data: v }) },
      },
    }),
  };
  const adapter = {
    runOperation: async (op: { name: string }, _ctx: unknown, input: unknown) => {
      if (op.name === "modules.create") created.push(input);
      return { ok: true, value: { moduleId: "00000000-0000-0000-0000-0000000000aa" } };
    },
  };
  return { toolCtx: { registry, adapter, provider } as unknown as ToolContext, created };
}

/** A provider whose structured output is one fixed module. */
function moduleizeProvider(object: unknown) {
  return {
    name: "anthropic",
    model: "fixture",
    calls: 0,
    async generateObject() {
      this.calls += 1;
      return { object, inputTokens: 1, outputTokens: 1, model: "fixture" };
    },
  };
}

describe("mintModuleFromHtml with authored fields", () => {
  const BANNER =
    '<div data-consent-banner>{{#consent_categories}}<label><input type="checkbox" data-consent-category="{{key}}"> {{label}}</label>{{/consent_categories}}</div>';

  it("an explicit empty fields[] is used verbatim — moduleize does not run (#1186)", async () => {
    const { toolCtx, created } = recordingToolCtx(untouchable);
    const r = await mintModuleFromHtml(ctx, toolCtx, {
      html: BANNER,
      displayNameHint: "Cookie banner",
      fieldsHint: [],
      kind: "utility",
    });
    expect(r.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect((created[0] as { html: string }).html).toBe(BANNER);
    expect((created[0] as { fields: unknown[] }).fields).toEqual([]);
  });

  it("caller displayName, kind and description win over moduleize's (#1173)", async () => {
    const provider = moduleizeProvider({
      html: "<h1>{{hero_title}}</h1>",
      fields: [{ name: "hero_title", kind: "text", label: "Title", default: "Welcome" }],
      displayName: "Moduleized name",
      kind: "content",
      description: "",
    });
    const { toolCtx, created } = recordingToolCtx(provider);
    const r = await mintModuleFromHtml(ctx, toolCtx, {
      html: "<h1>Welcome</h1>",
      displayNameHint: "Welcome hero",
      description: "Standalone marketing hero",
      kind: "hero",
    });
    expect(r.ok).toBe(true);
    expect(provider.calls).toBe(1);
    expect(created[0]).toMatchObject({
      displayName: "Welcome hero",
      description: "Standalone marketing hero",
      kind: "hero",
      html: "<h1>{{hero_title}}</h1>",
    });
  });
});
