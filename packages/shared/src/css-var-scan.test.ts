// SPDX-License-Identifier: MPL-2.0

/**
 * issue #156 — scanner unit coverage: reference/definition extraction
 * (nested fallbacks, comments-in-values, strings), locally-defined
 * custom properties, did-you-mean suggestions, warning formatting.
 */

import { describe, expect, it } from "bun:test";
import {
  extractCssVarDefinitions,
  extractCssVarReferences,
  formatUnknownCssVarWarning,
  scanCssVars,
  unknownCssVarMarker,
} from "./css-var-scan.js";

const KNOWN = ["--color-primary", "--color-foreground", "--color-background", "--spacing-md"];

describe("extractCssVarReferences", () => {
  it("finds plain and fallback-carrying references, deduped", () => {
    const refs = extractCssVarReferences(
      ".a{color:var(--color-primary)}.b{color:var(--color-primary);background:var( --color-bg , #fff )}",
    );
    expect(refs).toEqual([
      { name: "--color-primary", hasFallback: false },
      { name: "--color-bg", hasFallback: true },
    ]);
  });

  it("handles nested var() fallbacks", () => {
    const refs = extractCssVarReferences("p{color:var(--a, var(--b, red))}");
    expect(refs.map((r) => r.name).sort()).toEqual(["--a", "--b"]);
  });
});

describe("extractCssVarDefinitions", () => {
  it("collects custom-property declarations, not references", () => {
    const defs = extractCssVarDefinitions(
      ":root{--site-gutter:2rem}.x{--local: 1px; color:var(--other)}",
    );
    expect([...defs].sort()).toEqual(["--local", "--site-gutter"]);
  });
});

describe("scanCssVars", () => {
  it("reports unknown refs with a did-you-mean suggestion", () => {
    const unknown = scanCssVars({ css: "h1{color:var(--color-foregruond)}", knownVars: KNOWN });
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.name).toBe("--color-foregruond");
    expect(unknown[0]?.suggestion).toBe("--color-foreground");
  });

  it("treats locally-defined custom properties as known", () => {
    const unknown = scanCssVars({
      css: ".hero{--hero-angle:12deg; transform:rotate(var(--hero-angle))}",
      knownVars: KNOWN,
    });
    expect(unknown).toEqual([]);
  });

  it("suppresses far-fetched suggestions", () => {
    const unknown = scanCssVars({ css: "p{width:var(--zzz-totally-unrelated)}", knownVars: KNOWN });
    expect(unknown[0]?.suggestion).toBeNull();
  });

  it("is silent on clean css", () => {
    expect(
      scanCssVars({
        css: "p{color:var(--color-primary);padding:var(--spacing-md)}",
        knownVars: KNOWN,
      }),
    ).toEqual([]);
  });
});

describe("formatUnknownCssVarWarning / marker", () => {
  it("formats an AI-actionable one-liner and distinguishes fallback vs invalid", () => {
    const msg = formatUnknownCssVarWarning([
      { name: "--color-bg", hasFallback: true, suggestion: "--color-background" },
      { name: "--nope", hasFallback: false, suggestion: null },
    ]);
    expect(msg).toContain("--color-bg");
    expect(msg).toContain("did you mean `--color-background`?");
    expect(msg).toContain("hardcoded fallback");
    expect(msg).toContain("won't apply");
  });

  it("returns null when nothing is unknown (no noise)", () => {
    expect(formatUnknownCssVarWarning([])).toBeNull();
  });

  it("marker follows the missing-content convention", () => {
    expect(unknownCssVarMarker("--color-bg")).toBe("unknown-css-var:--color-bg");
  });
});
