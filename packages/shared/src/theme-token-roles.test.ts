// SPDX-License-Identifier: MPL-2.0

/**
 * issue #430 — a token's ROLE is set in the same call as its value and
 * must survive every later value-only edit.
 *
 * Before this, `applyDtcgWrites` rebuilt each leaf as `{$value, $type}`
 * and silently dropped `$description`, so recording a role was pointless:
 * the next `set_theme_tokens` erased it. These tests pin the write path
 * (normalizer lifts the role off the DTCG envelope), the preserve path,
 * and the lookup the design guard uses to replay roles at the point of
 * use.
 */

import { describe, expect, it } from "bun:test";
import { listTokenRoles } from "./theme-render.js";
import { normalizeTokens } from "./theme-normalize.js";
import { applyDtcgWrites, type ThemeDocument, validateThemeTokens } from "./themes.js";

const ROLE = "CTAs and links only — never large background fills";

function write(doc: ThemeDocument, set: Record<string, unknown>): ThemeDocument {
  const n = normalizeTokens(set);
  return applyDtcgWrites(doc, n.set, n.types, n.descriptions);
}

describe("token roles ride with the value (issue #430)", () => {
  it("lifts $description off the envelope onto the canonical path", () => {
    const n = normalizeTokens({
      "color.primary": { $type: "color", $value: "#4f46e5", $description: ROLE },
    });
    expect(n.descriptions["color.primary"]).toBe(ROLE);
    // The envelope is still unwrapped for the value itself.
    expect(n.set["color.primary"]).toBe("#4f46e5");
  });

  it("stores the role on the leaf and keeps the document valid", () => {
    const doc = write({}, {
      "color.primary": { $type: "color", $value: "#4f46e5", $description: ROLE },
    });
    expect((doc.color as Record<string, { $description?: string }>).primary.$description).toBe(ROLE);
    expect(() => validateThemeTokens(doc)).not.toThrow();
  });

  it("PRESERVES the role across a later value-only edit", () => {
    let doc = write({}, {
      "color.primary": { $type: "color", $value: "#4f46e5", $description: ROLE },
    });
    doc = write(doc, { primaryColor: "#ff6600" });
    const leaf = (doc.color as Record<string, { $value: unknown; $description?: string }>).primary;
    expect(leaf.$value).toBe("#ff6600");
    expect(leaf.$description).toBe(ROLE);
  });

  it("lets an explicit new role overwrite the old one", () => {
    let doc = write({}, {
      "color.primary": { $type: "color", $value: "#4f46e5", $description: ROLE },
    });
    doc = write(doc, {
      "color.primary": { $type: "color", $value: "#4f46e5", $description: "Buttons only" },
    });
    expect((doc.color as Record<string, { $description?: string }>).primary.$description).toBe(
      "Buttons only",
    );
  });

  it("maps roles onto the CSS var names module CSS actually references", () => {
    const doc = write({}, {
      "color.primary": { $type: "color", $value: "#4f46e5", $description: ROLE },
      "color.border": "#e5e5e5",
    });
    const roles = listTokenRoles(doc);
    expect(roles["--color-primary"]).toBe(ROLE);
    // A token with no recorded role contributes nothing — no invented text.
    expect(roles["--color-border"]).toBeUndefined();
  });

  it("gives every var a typography composite emits the same role", () => {
    const doc = write({}, {
      "typography.heading": {
        $type: "typography",
        $value: { fontFamily: "Poppins, sans-serif", fontSize: "2rem" },
        $description: "Section headings only",
      },
    });
    const roles = listTokenRoles(doc);
    expect(roles["--font-heading"]).toBe("Section headings only");
    expect(roles["--text-heading"]).toBe("Section headings only");
  });

  it("ignores a blank role rather than storing an empty string", () => {
    const n = normalizeTokens({
      "color.primary": { $type: "color", $value: "#4f46e5", $description: "   " },
    });
    expect(n.descriptions["color.primary"]).toBeUndefined();
  });
});
