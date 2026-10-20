// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { chatChipSchema } from "@caelo-cms/shared";
import {
  EDIT_AFFORDANCES_SCRIPT,
  EDIT_OVERLAY_COLOR,
  EDIT_UI_CSS,
  REFERENCE_LIMITS,
} from "./edit-affordances-script.js";
import { INJECT_SCRIPT } from "./inject-script.js";

describe("edit affordance UI (#916)", () => {
  it("paints in Caelo blue and stays self-contained", () => {
    expect(EDIT_OVERLAY_COLOR).toBe("#2a64b8");
    expect(EDIT_UI_CSS).toContain("outline:2px solid #2a64b8");
    // No admin tokens: the stylesheet lives inside the operator's site.
    expect(EDIT_UI_CSS).not.toContain("var(");
  });

  it("never styles the site's own elements", () => {
    // The old edit mode forced position:relative on the hovered module and
    // drew a pill + banner over the site's navigation. Everything now sits
    // in a shadow root; no selector may reach module roots or body.
    expect(INJECT_SCRIPT).not.toContain("caelo-edit-mode");
    expect(INJECT_SCRIPT).not.toContain("[data-caelo-module-id]{");
    expect(EDIT_AFFORDANCES_SCRIPT).toContain('attachShadow({ mode: "open" })');
    expect(EDIT_UI_CSS).not.toContain("position:relative");
  });

  it("never carries an AI instruction out of the preview", () => {
    // The preview runs the site's module scripts, which can post the same
    // messages as this runtime. Ask AI therefore only flags the reference
    // (`ask`); the instruction is typed and sent in the editor's composer.
    expect(EDIT_AFFORDANCES_SCRIPT).toContain("msg.ask = true");
    expect(EDIT_AFFORDANCES_SCRIPT).not.toContain("prompt");
    expect(EDIT_AFFORDANCES_SCRIPT).not.toContain('createElement("input")');
  });

  it("is spliced into the injected runtime, which still parses", () => {
    expect(INJECT_SCRIPT).toContain(EDIT_AFFORDANCES_SCRIPT);
    expect(() => new Function(INJECT_SCRIPT)).not.toThrow();
  });

  it("clips references to exactly what the chat endpoint accepts", () => {
    const at = (n: number) => "a".repeat(n);
    const chip = (over: Record<string, string>) =>
      chatChipSchema.safeParse({
        moduleId: "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7",
        selector: "h1",
        label: "h1",
        ...over,
      }).success;
    for (const key of ["label", "selector", "selectedText", "context"] as const) {
      expect(chip({ [key]: at(REFERENCE_LIMITS[key]) })).toBe(true);
      expect(chip({ [key]: at(REFERENCE_LIMITS[key] + 1) })).toBe(false);
    }
  });
});

/**
 * Runs the injected runtime against a minimal fake DOM and returns the
 * browse-mode click handler plus what it did (navigations).
 */
function bootRuntime(): {
  click: (href: string) => { defaultPrevented: boolean; assigned: string[] };
} {
  const listeners = new Map<string, (ev: unknown) => void>();
  const assigned: string[] = [];
  const document = {
    readyState: "loading",
    addEventListener: (kind: string, fn: (ev: unknown) => void) => listeners.set(kind, fn),
    getElementById: () => null,
    createElement: () => ({}),
    head: { appendChild: () => undefined },
    body: { classList: { contains: () => false, add: () => undefined, remove: () => undefined } },
  };
  const location = {
    href: "https://admin.example/edit/preview-by-path/about",
    origin: "https://admin.example",
    search: "",
    assign: (u: string) => assigned.push(u),
    reload: () => undefined,
  };
  const win: Record<string, unknown> = { addEventListener: () => undefined };
  const parent = { postMessage: () => undefined, location };
  new Function("window", "document", "location", "parent", INJECT_SCRIPT)(
    win,
    document,
    location,
    parent,
  );
  const handler = listeners.get("click");
  if (!handler) throw new Error("runtime registered no click handler");
  return {
    click(href) {
      const a = { nodeType: 1, tagName: "A", target: "", getAttribute: () => href };
      let defaultPrevented = false;
      handler({
        target: a,
        preventDefault: () => {
          defaultPrevented = true;
        },
      });
      return { defaultPrevented, assigned: [...assigned] };
    },
  };
}

describe("browse-mode link clicks (#724)", () => {
  it("swallows a click on an unresolved caelo: reference instead of navigating", () => {
    const r = bootRuntime().click("caelo:page/33333333-3333-4333-8333-333333333333");
    expect(r.defaultPrevented).toBe(true);
    expect(r.assigned).toEqual([]);
  });

  it("still routes a resolved internal path through preview-by-path", () => {
    const r = bootRuntime().click("/pricing/");
    expect(r.defaultPrevented).toBe(true);
    expect(r.assigned).toEqual(["/edit/preview-by-path/pricing/"]);
  });
});
