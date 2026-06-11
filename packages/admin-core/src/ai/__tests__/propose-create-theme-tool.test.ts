// SPDX-License-Identifier: MPL-2.0

/**
 * issue #112 — regression pin: the AI composes the theme itself.
 *
 * `propose_create_theme` must require a full AI-authored DTCG token
 * document + a design-rationale description, and must NOT accept a
 * `preset` — the preset menu was the §1A gap that let a grayscale
 * mint satisfy the cold-start gate. These pins are at the tool
 * boundary (Zod schema + provider-facing JSON inputSchema + tool
 * description) so the enum can't quietly come back.
 */

import { describe, expect, it } from "bun:test";
import { proposeCreateThemeTool } from "../tools/propose-tools-batch.js";

/** Minimal-but-realistic composed document (valid DTCG shapes). */
const BRAND_DOC = {
  color: {
    background: { $type: "color", $value: "#ffffff" },
    foreground: { $type: "color", $value: "#0f172a" },
    primary: { $type: "color", $value: "#4f46e5" },
    "primary-foreground": { $type: "color", $value: "#eef2ff" },
  },
  typography: {
    body: { $type: "typography", $value: { fontFamily: "Inter, sans-serif", fontSize: "1rem" } },
    heading: { $type: "typography", $value: { fontFamily: "Inter, sans-serif", fontWeight: 700 } },
  },
  spacing: {
    md: { $type: "dimension", $value: "1rem" },
  },
  radius: {
    md: { $type: "dimension", $value: "0.5rem" },
  },
};

const VALID_INPUT = {
  slug: "brand-indigo",
  displayName: "Brand indigo",
  description: "Indigo primary for a developer-tools SaaS brand.",
  tokens: BRAND_DOC,
};

describe("propose_create_theme tool boundary (issue #112)", () => {
  it("rejects an input carrying a preset key (.strict() — the enum must not come back)", () => {
    const r = proposeCreateThemeTool.schema.safeParse({
      ...VALID_INPUT,
      preset: "shadcn-default",
    });
    expect(r.success).toBe(false);
  });

  it("rejects missing tokens and missing description", () => {
    const { tokens: _tokens, ...withoutTokens } = VALID_INPUT;
    expect(proposeCreateThemeTool.schema.safeParse(withoutTokens).success).toBe(false);

    const { description: _description, ...withoutDescription } = VALID_INPUT;
    expect(proposeCreateThemeTool.schema.safeParse(withoutDescription).success).toBe(false);
    expect(
      proposeCreateThemeTool.schema.safeParse({ ...VALID_INPUT, description: "" }).success,
    ).toBe(false);
  });

  it("accepts a composed DTCG document (and a 1-token document — shape, not completeness)", () => {
    expect(proposeCreateThemeTool.schema.safeParse(VALID_INPUT).success).toBe(true);
    expect(
      proposeCreateThemeTool.schema.safeParse({
        ...VALID_INPUT,
        tokens: { color: { primary: { $type: "color", $value: "#10b981" } } },
      }).success,
    ).toBe(true);
  });

  it("provider-facing inputSchema requires slug/displayName/description/tokens and has no preset", () => {
    const inputSchema = proposeCreateThemeTool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect([...inputSchema.required].sort()).toEqual(
      ["description", "displayName", "slug", "tokens"].sort(),
    );
    expect(Object.keys(inputSchema.properties)).not.toContain("preset");
  });

  it("tool description instructs composing the document and bans grayscale defaults", () => {
    const description = proposeCreateThemeTool.description ?? "";
    // Document-skeleton hint so the AI lands a valid document first call.
    expect(description).toContain("color");
    expect(description).toContain("typography");
    expect(description).toContain("spacing");
    expect(description).toContain("COMPOS");
    expect(description).toContain("do NOT default to neutral/grayscale");
    // No preset is offered anywhere — "no presets" wording is the only
    // mention allowed.
    expect(description).not.toContain("shadcn-default");
    expect(description).not.toContain("preset:");
  });
});
