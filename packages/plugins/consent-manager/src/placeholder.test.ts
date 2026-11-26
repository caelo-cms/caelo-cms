// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { placeholderSlots } from "@caelo-cms/plugin-sdk";
import { DEFERRAL_PLACEHOLDERS, defaultPlaceholder, editorNotice } from "./placeholder.js";

describe("defaultPlaceholder", () => {
  it("offers a one-category grant for a known category", () => {
    expect(defaultPlaceholder("marketing", "Marketing")).toEqual({
      name: "consent",
      values: { category: "marketing", category_label: "Marketing" },
    });
    const html = DEFERRAL_PLACEHOLDERS.consent?.html ?? "";
    expect(html).toContain('data-consent-grant="{{category}}"');
    expect(html).toContain("{{category_label}}");
  });

  it("hands over text only: the operator's label is a value, never markup", () => {
    // Core escapes every value (plugin-host deferrals.ts, declaredPlaceholder).
    const ref = defaultPlaceholder("marketing", '<img src=x onerror="a()">');
    expect(ref.values?.category_label).toBe('<img src=x onerror="a()">');
  });
});

describe("editorNotice", () => {
  it("names every host the module loads from and offers the chat", () => {
    expect(editorNotice(["cdn.example.com", "fonts.example.net"])).toEqual({
      name: "unreviewed",
      values: { hosts: "cdn.example.com, fonts.example.net" },
    });
    const html = DEFERRAL_PLACEHOLDERS.unreviewed?.html ?? "";
    expect(html).toContain("Hidden from visitors");
    expect(html).toContain("data-caelo-ask-ai");
    // Nothing a visitor could press: the notice never reaches one, and
    // a grant for an unclassified vendor would be a dead end anyway.
    expect(html).not.toContain("data-consent-grant");
  });

  it("fills exactly the slots each placeholder declares", () => {
    expect(placeholderSlots(DEFERRAL_PLACEHOLDERS.consent?.html ?? "").sort()).toEqual(
      Object.keys(defaultPlaceholder("a", "b").values ?? {}).sort(),
    );
    expect(placeholderSlots(DEFERRAL_PLACEHOLDERS.unreviewed?.html ?? "")).toEqual(
      Object.keys(editorNotice(["h"]).values ?? {}),
    );
  });
});
