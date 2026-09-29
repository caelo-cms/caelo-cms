// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Catalog,
  compareVersions,
  openAiLabel,
  pickNewest,
  pricedModels,
  refreshCatalog,
  renderSummary,
} from "./refresh-model-catalog.js";

const slot = (role: string, match: string, id: string) => ({
  role,
  note: "",
  match,
  id,
  label: id,
});

const catalog = (): Catalog => ({
  providers: {
    anthropic: {
      slots: [
        slot("default", "^claude-sonnet-\\d+(-\\d+)?$", "claude-sonnet-5"),
        slot("fast", "^claude-haiku-\\d+(-\\d+)?$", "claude-haiku-4-5"),
      ],
    },
    openai: { slots: [slot("default", "^gpt-\\d+(\\.\\d+)?o?$", "gpt-4o")] },
    google: { slots: [slot("default", "^gemini-\\d+(\\.\\d+)?-pro$", "gemini-1.5-pro")] },
  },
});

describe("version ordering", () => {
  it("orders by numeric version, point releases above the base", () => {
    expect(compareVersions("claude-sonnet-5-5", "claude-sonnet-5")).toBeGreaterThan(0);
    expect(compareVersions("claude-opus-5", "claude-opus-4-8")).toBeGreaterThan(0);
    expect(compareVersions("gemini-2.5-pro", "gemini-10-pro")).toBeLessThan(0);
  });

  it("picks the newest match and ignores dated snapshots and previews", () => {
    const models = [
      { id: "claude-sonnet-4-6", label: "" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-4-5-20251001", label: "" },
      { id: "gemini-3.0-pro-preview", label: "" },
    ];
    expect(pickNewest(models, "^claude-sonnet-\\d+(-\\d+)?$")?.id).toBe("claude-sonnet-5-5");
    expect(pickNewest(models, "^claude-haiku-\\d+(-\\d+)?$")).toBeUndefined();
    expect(pickNewest(models, "^gemini-\\d+(\\.\\d+)?-pro$")).toBeUndefined();
  });
});

describe("refreshCatalog", () => {
  it("moves a slot to a newer model and takes its display name", () => {
    const { catalog: next, changes } = refreshCatalog(catalog(), {
      anthropic: [
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      ],
    });
    expect(changes).toEqual([
      {
        provider: "anthropic",
        role: "default",
        from: "claude-sonnet-5",
        to: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
      },
    ]);
    expect(next.providers.anthropic.slots[0]).toMatchObject({
      id: "claude-sonnet-5-5",
      label: "Claude Sonnet 5.5",
    });
    expect(next.providers.openai.slots[0]?.id).toBe("gpt-4o");
  });

  it("leaves providers without a listing untouched (no key configured)", () => {
    const { catalog: next, changes } = refreshCatalog(catalog(), {});
    expect(changes).toEqual([]);
    expect(next).toEqual(catalog());
  });

  it("replaces a retired model even without a higher version", () => {
    const { changes } = refreshCatalog(catalog(), {
      google: [{ id: "gemini-1.0-pro", label: "Gemini 1.0 Pro" }],
    });
    expect(changes[0]).toMatchObject({ from: "gemini-1.5-pro", to: "gemini-1.0-pro" });
  });

  it("reports a slot whose regex matches nothing", () => {
    const { unmatched } = refreshCatalog(catalog(), { openai: [{ id: "o3", label: "o3" }] });
    expect(unmatched).toEqual(["openai/default (^gpt-\\d+(\\.\\d+)?o?$)"]);
  });

  it("the shipped catalog parses and every slot regex compiles", () => {
    const shipped = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../packages/admin-core/src/ai/model-catalog.json"),
        "utf8",
      ),
    ) as Catalog;
    for (const p of Object.values(shipped.providers)) {
      for (const s of p.slots) {
        expect(new RegExp(s.match).test(s.id)).toBe(true);
      }
    }
  });
});

describe("summary", () => {
  it("lists pricing and capability follow-ups for new models only where needed", () => {
    const summary = renderSummary({
      changes: [
        { provider: "anthropic", role: "default", from: "a", to: "claude-sonnet-6", label: "S6" },
        { provider: "google", role: "default", from: "b", to: "gemini-2.5-pro", label: "G" },
      ],
      skipped: ["openai"],
      unmatched: [],
      priced: new Set(["gemini-2.5-pro"]),
    });
    expect(summary).toContain("ai_pricing` migration for `anthropic` / `claude-sonnet-6`");
    expect(summary).not.toContain("migration for `google`");
    expect(summary).toContain("rejectsForcedToolChoice");
    expect(summary).toContain("Skipped (no API key configured): openai.");
  });

  it("finds priced models in migration SQL", () => {
    const priced = pricedModels([
      "VALUES ('anthropic', 'claude-sonnet-5-5', 'text', 1),\n  ('google',   'gemini-1.5-pro', 'text', 2)",
    ]);
    expect([...priced].sort()).toEqual(["claude-sonnet-5-5", "gemini-1.5-pro"]);
  });

  it("derives readable OpenAI labels", () => {
    expect(openAiLabel("gpt-4.1-mini")).toBe("GPT-4.1 Mini");
    expect(openAiLabel("gpt-4o")).toBe("GPT-4o");
  });
});
