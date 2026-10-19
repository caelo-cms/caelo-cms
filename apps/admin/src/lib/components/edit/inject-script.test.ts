// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { EDIT_OVERLAY_COLOR, EDIT_OVERLAY_CSS, INJECT_SCRIPT } from "./inject-script.js";

describe("edit-mode overlay stylesheet", () => {
  it("paints outline, label and banner in Caelo blue", () => {
    expect(EDIT_OVERLAY_COLOR).toBe("#2a64b8");
    expect(EDIT_OVERLAY_CSS).toContain("outline:2px solid #2a64b8");
    // Label + banner backgrounds.
    expect(EDIT_OVERLAY_CSS.match(/background:#2a64b8/g)).toHaveLength(2);
    expect(EDIT_OVERLAY_CSS).not.toContain("#3b82f6");
  });

  it("labels the hovered module 'Edit' in a mono stack, without an emoji", () => {
    expect(EDIT_OVERLAY_CSS).toContain("content:'Edit';");
    expect(EDIT_OVERLAY_CSS).toContain(
      'font:500 11px/1 "IBM Plex Mono", Menlo, Consolas, monospace;',
    );
    expect(EDIT_OVERLAY_CSS).not.toMatch(/\\u270F|✏|️/);
  });

  it("stays self-contained: no admin CSS variables leak into the operator's site", () => {
    expect(EDIT_OVERLAY_CSS).not.toContain("var(");
  });

  it("is spliced into the injected runtime as a valid JS string literal", () => {
    expect(INJECT_SCRIPT).toContain(`s.textContent = ${JSON.stringify(EDIT_OVERLAY_CSS)};`);
    // The runtime must still parse after the splice.
    expect(() => new Function(INJECT_SCRIPT)).not.toThrow();
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
