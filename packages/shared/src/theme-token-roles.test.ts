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
import { normalizeTokens } from "./theme-normalize.js";
import { listTokenRoles } from "./theme-render.js";
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
    const doc = write(
      {},
      {
        "color.primary": { $type: "color", $value: "#4f46e5", $description: ROLE },
      },
    );
    expect((doc.color as Record<string, { $description?: string }>).primary.$description).toBe(
      ROLE,
    );
    expect(() => validateThemeTokens(doc)).not.toThrow();
  });

  it("PRESERVES the role across a later value-only edit", () => {
    let doc = write(
      {},
      {
        "color.primary": { $type: "color", $value: "#4f46e5", $description: ROLE },
      },
    );
    doc = write(doc, { primaryColor: "#ff6600" });
    const leaf = (doc.color as Record<string, { $value: unknown; $description?: string }>).primary;
    expect(leaf.$value).toBe("#ff6600");
    expect(leaf.$description).toBe(ROLE);
  });

  it("lets an explicit new role overwrite the old one", () => {
    let doc = write(
      {},
      {
        "color.primary": { $type: "color", $value: "#4f46e5", $description: ROLE },
      },
    );
    doc = write(doc, {
      "color.primary": { $type: "color", $value: "#4f46e5", $description: "Buttons only" },
    });
    expect((doc.color as Record<string, { $description?: string }>).primary.$description).toBe(
      "Buttons only",
    );
  });

  it("maps roles onto the CSS var names module CSS actually references", () => {
    const doc = write(
      {},
      {
        "color.primary": { $type: "color", $value: "#4f46e5", $description: ROLE },
        "color.border": "#e5e5e5",
      },
    );
    const roles = listTokenRoles(doc);
    expect(roles["--color-primary"]).toBe(ROLE);
    // A token with no recorded role contributes nothing — no invented text.
    expect(roles["--color-border"]).toBeUndefined();
  });

  it("gives every var a typography composite emits the same role", () => {
    const doc = write(
      {},
      {
        "typography.heading": {
          $type: "typography",
          $value: { fontFamily: "Poppins, sans-serif", fontSize: "2rem" },
          $description: "Section headings only",
        },
      },
    );
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

/**
 * The anchor-page design review annotates tokens whose values are already
 * settled. Restating each value just to attach a role is both a round-trip
 * (read the document first) and a chance to drift one, so a `$value`-less
 * envelope patches the metadata alone.
 */
describe("role-only patches (issue #430)", () => {
  const DOC: ThemeDocument = {
    color: { primary: { $type: "color", $value: "#4f46e5" } },
    typography: {
      heading: { $type: "typography", $value: { fontFamily: "Poppins, sans-serif" } },
    },
  };

  it("sets the role and leaves $value and $type untouched", () => {
    const doc = write(DOC, { "color.primary": { $description: ROLE } });
    const leaf = (doc.color as Record<string, Record<string, unknown>>).primary;
    expect(leaf.$value).toBe("#4f46e5");
    expect(leaf.$type).toBe("color");
    expect(leaf.$description).toBe(ROLE);
  });

  it("accepts the CSS-var form the AI reads off module CSS", () => {
    const doc = write(DOC, { "--color-primary": { $description: ROLE } });
    expect((doc.color as Record<string, Record<string, unknown>>).primary.$description).toBe(ROLE);
  });

  it("maps --font-<name> onto the typography composite", () => {
    const doc = write(DOC, { "--font-heading": { $description: "Section headings only" } });
    const leaf = (doc.typography as Record<string, Record<string, unknown>>).heading;
    expect(leaf.$description).toBe("Section headings only");
    expect(leaf.$value).toEqual({ fontFamily: "Poppins, sans-serif" });
  });

  it("annotates several tokens in ONE call", () => {
    const doc = write(DOC, {
      "color.primary": { $description: ROLE },
      "typography.heading": { $description: "Section headings only" },
    });
    expect((doc.color as Record<string, Record<string, unknown>>).primary.$description).toBe(ROLE);
    expect((doc.typography as Record<string, Record<string, unknown>>).heading.$description).toBe(
      "Section headings only",
    );
  });

  it("rejects a loose name — category is unresolvable without a value", () => {
    expect(() => write(DOC, { primaryColor: { $description: ROLE } })).toThrow(/UnknownTokenName/);
  });

  it("rejects annotating a token that does not exist", () => {
    expect(() => write(DOC, { "color.nonexistent": { $description: ROLE } })).toThrow(
      /UnknownTokenName/,
    );
  });

  it("a blank role-only patch writes nothing", () => {
    const n = normalizeTokens({ "color.primary": { $description: "  " } });
    expect(n.canonicalPaths).toHaveLength(0);
    expect(n.descriptions).toEqual({});
  });

  it("still validates as a DTCG document afterwards", () => {
    expect(() =>
      validateThemeTokens(write(DOC, { "color.primary": { $description: ROLE } })),
    ).not.toThrow();
  });
});
