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
  renderIssueBody,
  withAliases,
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

describe("dated snapshots (regression: Anthropic lists Haiku only as claude-haiku-4-5-20251001)", () => {
  it("adds the alias of a dated-only id", () => {
    expect(withAliases([{ id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" }])).toEqual([
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ]);
  });

  it("does not duplicate an alias the provider already lists", () => {
    const models = [
      { id: "claude-sonnet-5-5", label: "S" },
      { id: "claude-sonnet-5-5-20260901", label: "S" },
    ];
    expect(withAliases(models)).toHaveLength(2);
  });

  it("a dated-only family matches its slot and the alias is not treated as retired", () => {
    const { changes, unmatched } = refreshCatalog(catalog(), {
      anthropic: [
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
      ],
    });
    expect(unmatched).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("a newer dated-only model moves the slot to its alias", () => {
    const { changes } = refreshCatalog(catalog(), {
      anthropic: [
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
        { id: "claude-haiku-5-20261001", label: "Claude Haiku 5" },
      ],
    });
    expect(changes).toEqual([
      {
        provider: "anthropic",
        role: "fast",
        from: "claude-haiku-4-5",
        to: "claude-haiku-5",
        label: "Claude Haiku 5",
      },
    ]);
  });
});

describe("issue body for the coding agent", () => {
  const body = renderIssueBody({
    changes: [
      { provider: "anthropic", role: "default", from: "a", to: "claude-sonnet-6", label: "S6" },
      { provider: "google", role: "default", from: "b", to: "gemini-2.5-pro", label: "G" },
    ],
    skipped: ["openai"],
    unmatched: [],
    priced: new Set(["gemini-2.5-pro"]),
    pricingExample: "0224_p_pricing_sonnet_5_5_opus_5_5.sql",
  });

  it("carries the exact slot changes (the agent has no provider keys)", () => {
    expect(body).toContain("| anthropic | default | `a` | `claude-sonnet-6` | S6 |");
  });

  it("asks for pricing only for unpriced models, from the official page, never guessed", () => {
    expect(body).toContain(
      "`anthropic` / `claude-sonnet-6` — prices from https://platform.claude.com",
    );
    expect(body).not.toContain("`google` / `gemini-2.5-pro` — prices");
    expect(body).toContain("do NOT guess");
  });

  it("includes the Anthropic capability task, the SDK check and the test commands", () => {
    expect(body).toContain("rejectsForcedToolChoice");
    expect(body).toContain("@ai-sdk/<provider>");
    expect(body).toContain("bunx biome check .");
    expect(body).toContain("_Not checked (no API key configured): openai._");
  });

  it("numbers tasks consecutively when there is no Anthropic task (regression: list jumped 2 → 4)", () => {
    const numbered = body
      .split("\n")
      .filter((l) => /^\d+\. /.test(l))
      .map((l) => Number(l.split(".")[0]));
    expect(numbered).toEqual(numbered.map((_, i) => i + 1));
    const openAiOnly = renderIssueBody({
      changes: [
        { provider: "openai", role: "default", from: "gpt-4o", to: "gpt-5.5", label: "GPT-5.5" },
      ],
      skipped: [],
      unmatched: [],
      priced: new Set(),
      pricingExample: "0224_p_pricing_sonnet_5_5_opus_5_5.sql",
    });
    expect(openAiOnly).toContain("\n3. Check that the installed");
    expect(openAiOnly).toContain("\n4. Run `bun test");
    expect(openAiOnly).not.toContain("\n5. ");
  });

  it("names the newest pricing migration as the pattern and forbids SQL-less migrations", () => {
    expect(body).toContain("following `0224_p_pricing_sonnet_5_5_opus_5_5.sql`");
    expect(body).toContain("add no migration file at all");
    expect(body).toContain("Do not add tests that pin the catalog");
  });

  it("says so when nothing changed", () => {
    expect(
      renderIssueBody({
        changes: [],
        skipped: [],
        unmatched: [],
        priced: new Set(),
        pricingExample: "x.sql",
      }),
    ).toContain("up to date");
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
