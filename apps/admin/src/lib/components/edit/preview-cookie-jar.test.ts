// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: the consent banner in the editor preview asked again after
 * every reload, because the opaque-origin sandbox (#946) cannot store
 * cookies and the decision lived only in memory.
 */

import { describe, expect, it } from "bun:test";
import { iframeToParentSchema } from "./iframe-protocol.js";
import {
  injectPreviewCookieShim,
  PREVIEW_COOKIE_JAR,
  PREVIEW_COOKIE_JAR_MAX_BYTES,
  type PreviewCookieJar,
  persistPreviewCookies,
  previewCookieShimScript,
  readPreviewCookieJar,
} from "./preview-cookie-jar.js";

const CHANNEL = "0b5c1c8e-2f0a-4c55-9a43-6f7a1e2d3c4b";

/**
 * Run the shim against a stand-in of the sandboxed preview: a document
 * whose native cookie accessor throws, inside an editor frame.
 */
function runShim(jar: PreviewCookieJar, opts: { nativeThrows?: boolean } = {}) {
  const posts: { msg: Record<string, unknown>; target: string }[] = [];
  const doc: Record<string, unknown> = {};
  let native = "native=1";
  Object.defineProperty(doc, "cookie", {
    configurable: true,
    get() {
      if (opts.nativeThrows !== false) throw new DOMException("sandboxed", "SecurityError");
      return native;
    },
    set(v: string) {
      native = v;
    },
  });
  const parent = {
    postMessage: (msg: Record<string, unknown>, target: string) => posts.push({ msg, target }),
  };
  const win = { parent };
  const location = { search: `?channel=${CHANNEL}`, origin: "https://admin.example" };
  const tag = previewCookieShimScript(jar);
  const body = tag.slice(tag.indexOf(">") + 1, tag.lastIndexOf("<"));
  new Function("document", "window", "parent", "location", body)(doc, win, parent, location);
  return { doc: doc as { cookie: string }, posts };
}

describe("preview cookie shim", () => {
  it("restores the stored jar and hands every change to the editor", () => {
    const { doc, posts } = runShim({ caelo_consent: "%7B%22granted%22%3A%5B%5D%7D" });
    expect(doc.cookie).toBe("caelo_consent=%7B%22granted%22%3A%5B%5D%7D");

    doc.cookie = "a=1;path=/;max-age=31536000;samesite=lax;secure";
    expect(doc.cookie).toBe("caelo_consent=%7B%22granted%22%3A%5B%5D%7D; a=1");
    expect(posts.at(-1)).toEqual({
      msg: {
        kind: "caelo:cookies",
        channel: CHANNEL,
        cookies: { caelo_consent: "%7B%22granted%22%3A%5B%5D%7D", a: "1" },
      },
      target: "https://admin.example",
    });
    // What it posts is a message the editor accepts.
    expect(iframeToParentSchema.safeParse(posts.at(-1)?.msg).success).toBe(true);
  });

  it("deletes on max-age<=0 or a past expiry", () => {
    const { doc, posts } = runShim({ a: "1", b: "2" });
    doc.cookie = "a=;path=/;max-age=0";
    doc.cookie = "b=x; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    expect(doc.cookie).toBe("");
    expect(posts.at(-1)?.msg.cookies).toEqual({});
  });

  it("drops a cookie out of bounds, so every jar it posts is one the editor accepts", () => {
    const { doc, posts } = runShim({ consent: "yes" });
    doc.cookie = `big=${"x".repeat(PREVIEW_COOKIE_JAR_MAX_BYTES + 1)}`;
    doc.cookie = "a,b=1";
    for (let i = 0; i < 60; i++) doc.cookie = `c${i}=1`;
    expect(doc.cookie).not.toContain("big=");
    expect(doc.cookie).not.toContain("c49=");
    // A later change (withdrawing consent) still reaches the editor.
    doc.cookie = "consent=no";
    const last = posts.at(-1)?.msg;
    expect(iframeToParentSchema.safeParse(last).success).toBe(true);
    const cookies = (last?.cookies ?? {}) as PreviewCookieJar;
    expect(cookies.consent).toBe("no");
    expect(Object.keys(cookies)).toHaveLength(50);
  });

  it("leaves a working native document.cookie alone", () => {
    const { doc, posts } = runShim({ a: "1" }, { nativeThrows: false });
    expect(doc.cookie).toBe("native=1");
    expect(posts).toEqual([]);
  });

  it("cannot be broken out of by a stored value", () => {
    const script = previewCookieShimScript({ x: "</script><script>alert(1)</script>" });
    expect(script.match(/<\/script>/g)).toHaveLength(1);
  });

  it("runs first in <head>, before the page's own scripts", () => {
    const html = injectPreviewCookieShim(
      '<html><head lang="x"><script>consent()</script></head><body></body></html>',
      {},
    );
    expect(html.indexOf("data-caelo-preview-cookies")).toBeGreaterThan(html.indexOf("<head"));
    expect(html.indexOf("data-caelo-preview-cookies")).toBeLessThan(html.indexOf("consent()"));
    expect(injectPreviewCookieShim("<p>x</p>", {}).endsWith("<p>x</p>")).toBe(true);
  });
});

describe("readPreviewCookieJar", () => {
  it("reads a stored jar and starts empty without one", () => {
    expect(readPreviewCookieJar(JSON.stringify({ a: "1" }))).toEqual({ a: "1" });
    expect(readPreviewCookieJar(undefined)).toEqual({});
  });

  it("ignores a jar that is not one (its content comes from the preview's scripts)", () => {
    expect(readPreviewCookieJar("{not json")).toEqual({});
    expect(readPreviewCookieJar(JSON.stringify({ "a;b": "1" }))).toEqual({});
    expect(
      readPreviewCookieJar(JSON.stringify({ a: "x".repeat(PREVIEW_COOKIE_JAR_MAX_BYTES + 1) })),
    ).toEqual({});
    expect(readPreviewCookieJar(JSON.stringify(["a"]))).toEqual({});
  });
});

describe("persistPreviewCookies", () => {
  function capture(jar: PreviewCookieJar): string {
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, location: g.location };
    let written = "";
    g.document = {
      set cookie(v: string) {
        written = v;
      },
    };
    g.location = { protocol: "https:" };
    try {
      persistPreviewCookies(jar);
    } finally {
      g.document = saved.document;
      g.location = saved.location;
    }
    return written;
  }

  it("stores the jar for the preview routes only, readable back by the server", () => {
    const written = capture({ caelo_consent: "v" });
    expect(written).toContain(";path=/edit/;samesite=strict;secure;max-age=31536000");
    const value = written.slice(`${PREVIEW_COOKIE_JAR}=`.length, written.indexOf(";"));
    expect(readPreviewCookieJar(decodeURIComponent(value))).toEqual({ caelo_consent: "v" });
  });

  it("clears the stored jar when it is empty or too large", () => {
    expect(capture({})).toBe(`${PREVIEW_COOKIE_JAR}=;path=/edit/;samesite=strict;secure;max-age=0`);
    const big: PreviewCookieJar = {};
    for (let i = 0; i < 10; i++) big[`c${i}`] = "x".repeat(400);
    expect(capture(big)).toEndWith(";max-age=0");
  });
});
