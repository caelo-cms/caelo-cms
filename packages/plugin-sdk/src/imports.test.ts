// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports — the `imports` declaration (docs/data-imports.md): what the
 * manifest accepts, and that the one projection carries it into the signed
 * manifest.
 */

import { describe, expect, it } from "bun:test";
import { manifestFromDefinition, type PluginImportKind, pluginManifest } from "./index.js";

const KIND: PluginImportKind = {
  kind: "guestbook_entries",
  label: "Guestbook entries",
  description: "Entries of another guestbook.",
  release: "stage",
  fields: { page: { type: "pageRef" }, text: { type: "text", maxLength: 2000 } },
  apply: "apply_entries",
  remove: "remove_entries",
};

function manifest(imports: unknown[]) {
  return pluginManifest.safeParse({
    slug: "guestbook",
    version: "1.0.0",
    tier: 1,
    schema: {},
    operations: ["apply_entries", "remove_entries"],
    imports,
  });
}

function messages(r: ReturnType<typeof manifest>): string {
  return r.success ? "" : r.error.issues.map((i) => i.message).join("\n");
}

describe("pluginManifest — imports", () => {
  it("accepts a kind whose operations the plugin has", () => {
    expect(manifest([KIND]).success).toBe(true);
    expect(manifest([{ ...KIND, apply: "apply_entries", remove: undefined }]).success).toBe(true);
  });

  it("refuses operations the plugin does not have, and a kind twice", () => {
    expect(messages(manifest([{ ...KIND, apply: "nope" }]))).toContain(
      `the import's apply operation "nope" is not one of the plugin's operations`,
    );
    expect(messages(manifest([KIND, KIND]))).toContain("an import kind is declared twice");
  });

  it("refuses a remove without an apply, a target kind without storage, and core's names", () => {
    const { apply: _a, ...noApply } = KIND;
    expect(messages(manifest([noApply]))).toContain("declare `apply` too");
    expect(
      messages(manifest([{ ...KIND, release: "target", apply: undefined, remove: undefined }])),
    ).toContain("release `target`");
    expect(messages(manifest([{ ...KIND, kind: "redirects" }]))).toContain("core import kind");
  });

  it("refuses reserved and second page fields", () => {
    expect(
      manifest([{ ...KIND, fields: { sourceKey: { type: "string", maxLength: 9 } } }]).success,
    ).toBe(false);
    expect(
      manifest([{ ...KIND, fields: { a: { type: "pageRef" }, b: { type: "pageRef" } } }]).success,
    ).toBe(false);
  });

  it("is carried into the manifest by manifestFromDefinition", () => {
    const m = manifestFromDefinition({
      slug: "guestbook",
      version: "1.0.0",
      tier: 1,
      schema: {},
      operations: { apply_entries: async () => ({}), remove_entries: async () => ({}) },
      imports: [KIND],
    } as unknown as Parameters<typeof manifestFromDefinition>[0]);
    expect(m.imports?.[0]?.kind).toBe("guestbook_entries");
  });
});
