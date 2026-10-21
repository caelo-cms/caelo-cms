// SPDX-License-Identifier: MPL-2.0

/**
 * PR #863 (M-08) — the live-edit preview splices the overlay runtime into
 * the composed page on the ADMIN origin. Page context must not break out of
 * the inline `<script>`, the splice must not expand `$` replacement
 * patterns, and the runtime must only obey its embedding editor.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INJECT_SCRIPT } from "../components/edit/inject-script.js";
import { injectEditOverlay, overlayContextScript } from "./edit-overlay.js";

const PAGE = "<html><body><main>page</main></body></html>";

describe("injectEditOverlay", () => {
  it("inserts the runtime right before </body>, or appends it", () => {
    const html = injectEditOverlay(PAGE);
    expect(html.indexOf("<script data-caelo-edit-overlay>")).toBeLessThan(html.indexOf("</body>"));
    expect(html.endsWith("</body></html>")).toBe(true);
    expect(
      injectEditOverlay("<p>x</p>").startsWith("<p>x</p><script data-caelo-edit-overlay>"),
    ).toBe(true);
  });

  it("keeps a page path from closing the overlay <script>", () => {
    const path = "/a</script><script>alert(1)</script>";
    const html = injectEditOverlay(PAGE, { pageId: "p", slug: "s", path });
    expect(html).not.toContain("</script><script>alert(1)");
    // Still the same value once the JS engine reads the string literal.
    const json = overlayContextScript({ pageId: "p", slug: "s", path })
      .replace(/^window\.__caelo=/, "")
      .replace(/;$/, "");
    expect(JSON.parse(json).path).toBe(path);
  });

  it("escapes U+2028 / U+2029 in the context", () => {
    const stmt = overlayContextScript({ pageId: "p", slug: "a\u2028b\u2029c", path: "/" });
    expect(stmt).not.toMatch(/[\u2028\u2029]/);
    expect(stmt).toContain("a\\u2028b\\u2029c");
  });

  it("does not expand $-replacement patterns from page data", () => {
    const slug = "x$&y$`z$'w";
    const html = injectEditOverlay(PAGE, { pageId: "p", slug, path: "/" });
    expect(html).toContain(JSON.stringify(slug));
    expect(html.match(/<main>page<\/main>/g)).toHaveLength(1);
  });

  it("is what both preview routes serve (read as source: bun cannot resolve #lib)", () => {
    for (const route of ["preview/[pageId]/+server.ts", "preview-by-path/[...path]/+server.ts"]) {
      const src = readFileSync(
        resolve(import.meta.dir, "../../routes/(authed)/edit", route),
        "utf8",
      );
      expect(src).toContain("injectEditOverlay(");
      expect(src).not.toContain("INJECT_SCRIPT");
    }
  });
});

const CHANNEL = "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7";

/** Run INJECT_SCRIPT against a minimal window and capture its message handler. */
function bootRuntime(search = `?branch=b1&channel=${CHANNEL}`): {
  handler: (ev: { source: unknown; origin: string; data: unknown }) => void;
  parentWindow: object;
  posted: () => { msg: Record<string, unknown>; target: string }[];
} {
  const listeners: Record<string, (ev: never) => void> = {};
  const posted: { msg: Record<string, unknown>; target: string }[] = [];
  // #946 — the parent is cross-origin to the sandboxed preview: reading its
  // location throws, exactly as in a browser.
  const parentWindow = {
    postMessage: (msg: Record<string, unknown>, target: string) => posted.push({ msg, target }),
    get location(): never {
      throw new Error("SecurityError: cross-origin");
    },
  };
  const win: Record<string, unknown> = {
    addEventListener: (type: string, fn: (ev: never) => void) => {
      listeners[type] = fn;
    },
    parent: parentWindow,
    scrollY: 0,
  };
  const doc = {
    readyState: "loading",
    head: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => ({}),
    addEventListener: () => {},
  };
  const location = {
    origin: "https://admin.test",
    href: `https://admin.test/edit/preview-by-path/about${search}`,
    search,
    reload: () => {
      throw new Error("the preview must not reload itself (#946)");
    },
  };
  new Function("window", "document", "location", "parent", "setTimeout", INJECT_SCRIPT)(
    win,
    doc,
    location,
    parentWindow,
    () => {},
  );
  const message = listeners.message;
  if (!message) throw new Error("INJECT_SCRIPT registered no message listener");
  return {
    handler: message as unknown as (ev: { source: unknown; origin: string; data: unknown }) => void,
    parentWindow,
    posted: () => posted,
  };
}

describe("INJECT_SCRIPT message listener", () => {
  it("answers the embedding editor's reload with a navigate request to the same page", () => {
    const rt = bootRuntime();
    rt.handler({
      source: rt.parentWindow,
      origin: "https://admin.test",
      // The editor never sends its channel (#946, iframe-protocol.ts).
      data: { kind: "caelo:reload" },
    });
    // #946 — the editor runs the navigation (its own carries the session);
    // the request goes to the admin origin only and carries the channel.
    expect(rt.posted()).toEqual([
      {
        msg: {
          kind: "caelo:navigate",
          href: "/edit/preview-by-path/about?branch=b1",
          channel: CHANNEL,
        },
        target: "https://admin.test",
      },
    ]);
  });

  it("ignores messages from any other window or origin", () => {
    const rt = bootRuntime();
    const reload = { kind: "caelo:reload" };
    // The previewed site's own scripts post from this very window.
    rt.handler({ source: {}, origin: "https://admin.test", data: reload });
    rt.handler({ source: rt.parentWindow, origin: "https://evil.test", data: reload });
    rt.handler({ source: rt.parentWindow, origin: "null", data: reload });
    expect(rt.posted()).toEqual([]);
  });

  it("stays silent without a channel (a frame no editor listens to)", () => {
    const rt = bootRuntime("?branch=b1");
    rt.handler({
      source: rt.parentWindow,
      origin: "https://admin.test",
      data: { kind: "caelo:reload" },
    });
    expect(rt.posted()).toEqual([]);
  });
});
