// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the `moduleize` building block against a scripted provider
 * (no DB, no real AI). Covers: first-try valid, one repair pass, exhausting the
 * repair budget (loud throw), a turn that produced no schema-valid object, and
 * the retry-telemetry callback firing exactly when a repair happened.
 *
 * moduleize uses the SDK-native structured-output path (provider.generateObject,
 * CLAUDE.md §12), so the fixture scripts a queue of generateObject OUTCOMES —
 * one per attempt — instead of streamed submit_module tool-call events:
 *   - a plain object  → generateObject returns { object }
 *   - `undefined`     → the NoObjectGeneratedError case (repairable)
 *   - `{ throw: msg }`→ a hard provider/API error (generateObject throws)
 */

import { describe, expect, it } from "bun:test";
import { type ModuleizeRetryRecord, moduleize } from "../moduleize.js";
import type {
  AIProvider,
  GenerateInput,
  GenerateObjectInput,
  GenerateObjectResult,
  ProviderEvent,
  ProviderName,
} from "../provider.js";

type ObjectOutcome = unknown | { throw: string };

/** Scripts generateObject: one queued outcome per moduleize attempt. */
class ObjectFixtureProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model = "claude-opus-4-7";
  #idx = 0;
  constructor(private readonly outcomes: readonly ObjectOutcome[]) {}

  // eslint-disable-next-line require-yield
  async *generate(_input: GenerateInput): AsyncIterable<ProviderEvent> {
    throw new Error("moduleize should call generateObject, not generate");
  }

  async generateObject(_input: GenerateObjectInput): Promise<GenerateObjectResult> {
    const outcome = this.outcomes[this.#idx] ?? undefined;
    this.#idx += 1;
    if (outcome && typeof outcome === "object" && "throw" in outcome) {
      throw new Error((outcome as { throw: string }).throw);
    }
    return {
      object: outcome,
      inputTokens: 100,
      outputTokens: 20,
      model: this.model,
    };
  }
}

const provErr = (message: string): ObjectOutcome => ({ throw: message });

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
      provider: new ObjectFixtureProvider([VALID]),
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
      provider: new ObjectFixtureProvider([INVALID, VALID]),
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
      provider: new ObjectFixtureProvider([NO_DEFAULTS, VALID]),
      html: RAW_HTML,
      onRetry: async (r) => void records.push(r),
    });
    expect(out.fields.some((f) => "default" in f && f.default !== undefined)).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]?.errors[0]).toContain("default");
  });

  it("throws loudly after exhausting repairs and fires onRetry with failed", async () => {
    const records: ModuleizeRetryRecord[] = [];
    const provider = new ObjectFixtureProvider([INVALID, INVALID, INVALID]);
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
    // Two error outcomes queued, but moduleize must throw after the FIRST
    // without touching the second (no repair on a hard infra error).
    await expect(
      moduleize({
        provider: new ObjectFixtureProvider([
          provErr("You have reached your specified API usage limits."),
          provErr("You have reached your specified API usage limits."),
        ]),
        html: RAW_HTML,
        onRetry: async () => {
          retried = true;
        },
      }),
    ).rejects.toThrow(/provider error — You have reached/);
    expect(retried).toBe(false);
  });

  it("treats a turn that produced no schema-valid object as a repairable error", async () => {
    // generateObject's NoObjectGeneratedError surfaces as object:undefined —
    // repairable, so the next attempt's valid object still wins.
    const out = await moduleize({
      provider: new ObjectFixtureProvider([undefined, VALID]),
      html: RAW_HTML,
    });
    expect(out.kind).toBe("hero");
  });
});
