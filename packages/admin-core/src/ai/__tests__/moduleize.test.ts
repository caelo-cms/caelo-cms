// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the `moduleize` building block against a scripted provider
 * (no DB, no real AI). Covers: first-try valid, one repair pass, exhausting the
 * repair budget (loud throw), a turn that never calls submit_module, and the
 * retry-telemetry callback firing exactly when a repair happened.
 */

import { describe, expect, it } from "bun:test";
import { type ModuleizeRetryRecord, moduleize } from "../moduleize.js";
import type { ProviderEvent } from "../provider.js";
import { MultiFixtureProvider } from "../providers/anthropic.js";

function submitCall(args: unknown): ProviderEvent[] {
  return [
    { kind: "tool-call", id: "1", name: "submit_module", arguments: args },
    { kind: "usage", inputTokens: 100, outputTokens: 20, cachedTokens: 0 },
    { kind: "done", stopReason: "tool_use" },
  ];
}

const VALID = {
  html: `<section><h1>{{hero_title}}</h1><p>{{hero_body}}</p></section>`,
  // Content-preservation contract: defaults carry the original copy the
  // placeholders replaced — a submit without ANY default is rejected.
  fields: [
    { name: "hero_title", kind: "text", label: "Hero Title", default: "Welcome" },
    { name: "hero_body", kind: "richtext", label: "Hero Body", default: "Body copy." },
  ],
  displayName: "Hero",
  kind: "hero",
  description: "Top-of-page hero.",
};

// Contract-invalid: html references {{ghost}} with no matching field.
const INVALID = {
  html: `<h1>{{ghost}}</h1>`,
  fields: [],
  displayName: "Broken",
  kind: "content",
  description: "",
};

const RAW_HTML = `<section><h1>Welcome</h1><p>Some copy.</p></section>`;

describe("moduleize", () => {
  it("returns the module on a first-try valid submit (no retry, no telemetry)", async () => {
    let retried = false;
    const out = await moduleize({
      provider: new MultiFixtureProvider([submitCall(VALID)]),
      html: RAW_HTML,
      onRetry: async () => {
        retried = true;
      },
    });
    expect(out.fields.map((f) => f.name)).toEqual(["hero_title", "hero_body"]);
    expect(out.kind).toBe("hero");
    expect(retried).toBe(false);
  });

  it("repairs once (invalid → valid) and fires onRetry with ok_after_repair", async () => {
    const records: ModuleizeRetryRecord[] = [];
    const out = await moduleize({
      provider: new MultiFixtureProvider([submitCall(INVALID), submitCall(VALID)]),
      html: RAW_HTML,
      onRetry: async (r) => {
        records.push(r);
      },
    });
    expect(out.displayName).toBe("Hero");
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("ok_after_repair");
    expect(records[0]?.attempts).toBe(2);
    expect(records[0]?.errors[0]).toContain("ghost");
    expect(records[0]?.inputTokens).toBe(200); // accumulated across both calls
  });

  it("rejects a submit whose fields carry NO defaults (content-preservation contract) and repairs", async () => {
    // The extract-fields live run lost "Welcome to Caelo": the model
    // parametrised the copy away without defaults. That submit is now a
    // contract violation → retry, not a silent content loss.
    const NO_DEFAULTS = {
      ...VALID,
      fields: VALID.fields.map(({ default: _d, ...rest }) => rest),
    };
    const records: ModuleizeRetryRecord[] = [];
    const out = await moduleize({
      provider: new MultiFixtureProvider([submitCall(NO_DEFAULTS), submitCall(VALID)]),
      html: RAW_HTML,
      onRetry: async (r) => void records.push(r),
    });
    expect(out.fields.some((f) => "default" in f && f.default !== undefined)).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]?.errors[0]).toContain("default");
  });

  it("throws loudly after exhausting repairs and fires onRetry with failed", async () => {
    const records: ModuleizeRetryRecord[] = [];
    const provider = new MultiFixtureProvider([
      submitCall(INVALID),
      submitCall(INVALID),
      submitCall(INVALID),
    ]);
    await expect(
      moduleize({
        provider,
        html: RAW_HTML,
        maxRepairs: 2,
        onRetry: async (r) => void records.push(r),
      }),
    ).rejects.toThrow(/moduleize failed after 3 attempts/);
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("failed");
    expect(records[0]?.attempts).toBe(3);
    expect(records[0]?.finalFields).toBeUndefined();
  });

  it("fails immediately on a provider/API error — no retry, no telemetry", async () => {
    let retried = false;
    const errEvents: ProviderEvent[] = [
      { kind: "error", message: "You have reached your specified API usage limits." },
      { kind: "done", stopReason: "error" },
    ];
    // Two error turns queued, but moduleize must throw after the FIRST without
    // touching the second (no repair on a hard infra error).
    await expect(
      moduleize({
        provider: new MultiFixtureProvider([errEvents, errEvents]),
        html: RAW_HTML,
        onRetry: async () => {
          retried = true;
        },
      }),
    ).rejects.toThrow(/provider error — You have reached/);
    expect(retried).toBe(false);
  });

  it("treats a turn with no submit_module call as a repairable error", async () => {
    const textOnly: ProviderEvent[] = [
      { kind: "text-delta", text: "Here is the module..." },
      { kind: "usage", inputTokens: 50, outputTokens: 10, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
    const out = await moduleize({
      provider: new MultiFixtureProvider([textOnly, submitCall(VALID)]),
      html: RAW_HTML,
    });
    expect(out.kind).toBe("hero");
  });
});
