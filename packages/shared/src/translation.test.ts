// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  buildModeOnePrompt,
  buildModeTwoPrompt,
  computeBlockDiff,
  type GlossaryEntry,
  type ModuleBlockSlot,
  translationResultPayload,
} from "./translation.js";

const SLOT = (overrides: Partial<ModuleBlockSlot> = {}): ModuleBlockSlot => ({
  blockName: "content",
  position: 0,
  moduleId: "11111111-1111-4111-8111-111111111111",
  moduleSlug: "hero",
  html: "<h1>Welcome</h1>",
  altText: null,
  caption: null,
  ...overrides,
});

describe("computeBlockDiff", () => {
  it("returns empty when source and variant align", () => {
    const slot = SLOT();
    expect(computeBlockDiff([slot], [slot])).toEqual([]);
  });

  it("emits changed when html differs", () => {
    const source = SLOT({ html: "<h1>Welcome — updated</h1>" });
    const variant = SLOT({ html: "<h1>Willkommen</h1>" });
    const ops = computeBlockDiff([source], [variant]);
    expect(ops.length).toBe(1);
    const [op] = ops;
    if (op?.kind !== "changed") throw new Error("expected changed");
    expect(op.before.html).toBe("<h1>Willkommen</h1>");
    expect(op.after.html).toBe("<h1>Welcome — updated</h1>");
  });

  it("emits added when source has a slot variant lacks", () => {
    const source = [SLOT({ position: 0 }), SLOT({ position: 1, html: "<p>New</p>" })];
    const variant = [SLOT({ position: 0 })];
    const ops = computeBlockDiff(source, variant);
    expect(ops.length).toBe(1);
    expect(ops[0]?.kind).toBe("added");
  });

  it("emits removed when variant has a slot source lacks", () => {
    const source = [SLOT({ position: 0 })];
    const variant = [SLOT({ position: 0 }), SLOT({ position: 1, html: "<p>Stale</p>" })];
    const ops = computeBlockDiff(source, variant);
    expect(ops.length).toBe(1);
    expect(ops[0]?.kind).toBe("removed");
  });

  it("matches by (blockName, position) — same blockName different position is added/removed", () => {
    const source = [SLOT({ position: 0 })];
    const variant = [SLOT({ position: 1 })];
    const ops = computeBlockDiff(source, variant);
    expect(ops.length).toBe(2);
    expect(ops.map((o) => o.kind).sort()).toEqual(["added", "removed"]);
  });

  it("alt/caption changes count as changed", () => {
    const source = SLOT({ altText: "A cat" });
    const variant = SLOT({ altText: "Eine Katze" });
    const ops = computeBlockDiff([source], [variant]);
    expect(ops[0]?.kind).toBe("changed");
  });
});

const GLOSSARY: GlossaryEntry[] = [
  { sourceTerm: "Caelo", translation: "Caelo", context: "brand name — never translate" },
  { sourceTerm: "CMS", translation: "CMS", context: null },
];

describe("buildModeOnePrompt", () => {
  it("includes locale codes, structural lock, glossary, style guide", () => {
    const { system, user } = buildModeOnePrompt({
      sourceLocale: "en",
      targetLocale: "de-AT",
      targetLocaleDisplayName: "German (Austria)",
      sourceModules: [SLOT()],
      glossary: GLOSSARY,
      styleGuide: "Use Sie form (formal).",
    });
    expect(system).toContain("Source locale: en");
    expect(system).toContain("Target locale: de-AT (German (Austria))");
    expect(system).toContain("STRUCTURAL LOCK");
    expect(system).toContain("Caelo");
    expect(system).toContain("Use Sie form");
    expect(user).toContain("Welcome");
  });

  it("omits empty glossary block", () => {
    const { system } = buildModeOnePrompt({
      sourceLocale: "en",
      targetLocale: "de",
      sourceModules: [SLOT()],
      glossary: [],
      styleGuide: null,
    });
    expect(system).not.toContain("## Glossary");
    expect(system).not.toContain("## Style guide");
  });
});

describe("buildModeTwoPrompt", () => {
  it("renders structured diff with before/after for changed blocks", () => {
    const source = SLOT({ html: "<h1>Welcome — Spring sale</h1>" });
    const variant = SLOT({ html: "<h1>Willkommen</h1>" });
    const diff = computeBlockDiff([source], [variant]);
    const { system, user } = buildModeTwoPrompt({
      sourceLocale: "en",
      targetLocale: "de",
      sourceModules: [source],
      variantModules: [variant],
      diff,
      glossary: [],
      styleGuide: null,
    });
    expect(system).toContain("STRUCTURAL LOCK");
    expect(system).toContain("Return ONE entry per CHANGED module");
    expect(user).toContain("Existing translation");
    expect(user).toContain("Willkommen"); // before
    expect(user).toContain("Spring sale"); // after
    expect(user).toContain("CHANGED");
  });

  it("renders empty diff hint when no ops", () => {
    const slot = SLOT();
    const { user } = buildModeTwoPrompt({
      sourceLocale: "en",
      targetLocale: "de",
      sourceModules: [slot],
      variantModules: [slot],
      diff: [],
      glossary: [],
      styleGuide: null,
    });
    expect(user).toContain("no changes detected");
  });
});

describe("translationResultPayload", () => {
  it("accepts the expected AI output shape", () => {
    const ok = translationResultPayload.safeParse({
      modules: [{ blockName: "content", position: 0, html: "<h1>Willkommen</h1>", altText: null }],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects unknown fields (.strict)", () => {
    const bad = translationResultPayload.safeParse({
      modules: [{ blockName: "content", position: 0, html: "<h1>x</h1>", extra: 1 }],
    });
    expect(bad.success).toBe(false);
  });
});
