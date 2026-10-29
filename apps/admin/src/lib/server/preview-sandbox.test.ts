// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #946 — preview content never runs script in the admin origin.
 *
 * Unit-level guards for the pieces (sandbox headers, font inlining, the
 * read-only media grant and the asset-route guard) plus source-level
 * regression checks that would have caught the original bug: an admin
 * iframe framing preview HTML with `allow-scripts allow-same-origin` (or
 * no sandbox), and a preview route answering without a CSP sandbox.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { mintPreviewScreenshotToken, PREVIEW_SCREENSHOT_TOKEN_HEADER } from "@caelo-cms/admin-core";
import type { Cookies } from "@sveltejs/kit";
import { isHttpError, isRedirect } from "@sveltejs/kit";
import { PREVIEW_COOKIE_JAR } from "../components/edit/preview-cookie-jar.js";
import {
  mintPreviewAssetGrant,
  PREVIEW_ASSET_GRANT_COOKIE,
  PREVIEW_ASSET_GRANT_TTL_MS,
  setPreviewAssetGrant,
  verifyPreviewAssetGrant,
} from "./preview-asset-grant.js";
import {
  fontCacheFile,
  inlinePreviewFonts,
  PREVIEW_DOCUMENT_CSP,
  previewDocumentHeaders,
  previewDocumentResponse,
} from "./preview-sandbox.js";
import { requirePreviewAssetAccess } from "./preview-screenshot-auth.js";

beforeAll(() => {
  // The grant key derives from the KEK; any 32-byte hex KEK will do here.
  process.env.CAELO_SECRET_KEK ??= "11".repeat(32);
});

/** A `Cookies` stand-in that records what was set. */
function fakeCookies(initial: Record<string, string> = {}): Cookies & {
  sets: { name: string; value: string; opts: Record<string, unknown> }[];
} {
  const jar = new Map(Object.entries(initial));
  const sets: { name: string; value: string; opts: Record<string, unknown> }[] = [];
  return {
    sets,
    get: (name: string) => jar.get(name),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, opts: Record<string, unknown>) => {
      jar.set(name, value);
      sets.push({ name, value, opts });
    },
    delete: (name: string) => {
      jar.delete(name);
    },
    serialize: () => "",
  } as unknown as Cookies & { sets: typeof sets };
}

describe("preview document headers", () => {
  it("sandboxes the document into an opaque origin, scripts allowed", () => {
    const h = previewDocumentHeaders();
    expect(h["content-security-policy"]).toBe(PREVIEW_DOCUMENT_CSP);
    expect(PREVIEW_DOCUMENT_CSP).toMatch(/^sandbox\b/);
    expect(PREVIEW_DOCUMENT_CSP).toContain("allow-scripts");
    // The one flag that would hand the module scripts the admin origin.
    expect(PREVIEW_DOCUMENT_CSP).not.toContain("allow-same-origin");
    // Nor may they escape into an unsandboxed window or submit forms.
    expect(PREVIEW_DOCUMENT_CSP).not.toContain("allow-popups-to-escape-sandbox");
    expect(PREVIEW_DOCUMENT_CSP).not.toContain("allow-top-navigation");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["x-frame-options"]).toBe("SAMEORIGIN");
    expect(h["cache-control"]).toBe("no-store");
  });

  it("previewDocumentResponse sets the headers and refreshes the media grant", async () => {
    const cookies = fakeCookies();
    const res = await previewDocumentResponse("<p>x</p>", { cookies, userId: "u1" });
    expect(res.headers.get("content-security-policy")).toBe(PREVIEW_DOCUMENT_CSP);
    const body = await res.text();
    expect(body.endsWith("<p>x</p>")).toBe(true);
    expect(body).toContain("data-caelo-preview-cookies");
    expect(cookies.sets.map((s) => s.name)).toEqual([PREVIEW_ASSET_GRANT_COOKIE]);
    const none = fakeCookies();
    const capture = await previewDocumentResponse("<p>x</p>", null);
    expect(none.sets).toEqual([]);
    // A screenshot capture starts without the operator's preview cookies.
    expect(await capture.text()).toBe("<p>x</p>");
  });

  it("restores the operator's preview cookies (a consent decision survives a reload)", async () => {
    const cookies = fakeCookies({ [PREVIEW_COOKIE_JAR]: JSON.stringify({ caelo_consent: "v" }) });
    const res = await previewDocumentResponse("<head></head><p>x</p>", { cookies, userId: "u1" });
    expect(await res.text()).toContain('var jar = {"caelo_consent":"v"};');
  });
});

describe("inlinePreviewFonts", () => {
  const FILE = "0123456789abcdef.woff2";
  it("embeds cached faces as data: URIs (an opaque origin's font loads carry no credentials)", async () => {
    const html = `<style>@font-face{src:url(/_caelo/fonts/inter/${FILE}) format("woff2")}</style><link href="/_caelo/fonts/inter/${FILE}">`;
    const read = async (path: string) => {
      expect(path.endsWith(join("inter", FILE))).toBe(true);
      return new Uint8Array([1, 2, 3]);
    };
    const out = await inlinePreviewFonts(html, read);
    expect(out).not.toContain("/_caelo/fonts/");
    expect(out.match(/data:font\/woff2;base64,AQID/g)).toHaveLength(2);
  });

  it("leaves uncached or malformed references as they are", async () => {
    const html = "url(/_caelo/fonts/inter/ffffffffffffffff.woff2) url(/_caelo/fonts/inter/x.ttf)";
    const out = await inlinePreviewFonts(html, async () => {
      throw new Error("ENOENT");
    });
    expect(out).toBe(html);
  });

  it("only names cache files (no traversal)", () => {
    expect(fontCacheFile("inter", FILE)).not.toBeNull();
    expect(fontCacheFile("..", FILE)).toBeNull();
    expect(fontCacheFile("inter", "../../etc/passwd")).toBeNull();
    expect(fontCacheFile("Inter", FILE)).toBeNull();
  });
});

describe("preview asset grant", () => {
  it("round-trips and expires", async () => {
    const now = Date.now();
    const token = await mintPreviewAssetGrant("u1", now);
    expect(await verifyPreviewAssetGrant(token, now)).toEqual({ ok: true, userId: "u1" });
    expect(await verifyPreviewAssetGrant(token, now + PREVIEW_ASSET_GRANT_TTL_MS)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects tampering and garbage", async () => {
    const token = await mintPreviewAssetGrant("u1");
    const [v, payload, sig] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ u: "u2", e: Date.now() + 1e9 })).toString(
      "base64url",
    );
    expect((await verifyPreviewAssetGrant(`${v}.${forged}.${sig}`)).ok).toBe(false);
    expect((await verifyPreviewAssetGrant(`${v}.${payload}.${sig.slice(1)}x`)).ok).toBe(false);
    expect(await verifyPreviewAssetGrant("nope")).toEqual({ ok: false, reason: "malformed" });
    // A screenshot capture token is a different credential, not a grant.
    const capture = mintPreviewScreenshotToken({ pageId: "p" });
    expect((await verifyPreviewAssetGrant(capture)).ok).toBe(false);
  });

  it("is a SameSite=None, HttpOnly, Secure cookie scoped to /_caelo/", async () => {
    const cookies = fakeCookies();
    await setPreviewAssetGrant(cookies, "u1");
    const [set] = cookies.sets;
    expect(set?.name).toBe(PREVIEW_ASSET_GRANT_COOKIE);
    expect(set?.opts).toMatchObject({
      path: "/_caelo/",
      httpOnly: true,
      sameSite: "none",
      secure: true,
    });
  });
});

describe("requirePreviewAssetAccess", () => {
  const anon = { user: null, ctx: {} } as unknown as App.Locals;
  const req = (headers: Record<string, string> = {}) =>
    new Request("http://admin.test/_caelo/media/x", { headers });

  it("accepts the session, a capture token, or a valid grant", async () => {
    const human = { user: { id: "u1" }, ctx: { actorId: "u1", actorKind: "human" } };
    expect(
      await requirePreviewAssetAccess(human as unknown as App.Locals, req(), fakeCookies()),
    ).toBe(human.ctx as never);
    const token = mintPreviewScreenshotToken({ pageId: "p" });
    const viaToken = await requirePreviewAssetAccess(
      anon,
      req({ [PREVIEW_SCREENSHOT_TOKEN_HEADER]: token }),
      fakeCookies(),
    );
    expect(viaToken.actorKind).toBe("system");
    const grant = await mintPreviewAssetGrant("u1");
    const viaGrant = await requirePreviewAssetAccess(
      anon,
      req(),
      fakeCookies({ [PREVIEW_ASSET_GRANT_COOKIE]: grant }),
    );
    expect(viaGrant.actorKind).toBe("system");
  });

  it("refuses a bad grant loudly and sends the anonymous to login", async () => {
    try {
      await requirePreviewAssetAccess(
        anon,
        req(),
        fakeCookies({ [PREVIEW_ASSET_GRANT_COOKIE]: "v1.x.y" }),
      );
      throw new Error("expected a 401");
    } catch (e) {
      expect(isHttpError(e) && e.status).toBe(401);
    }
    try {
      await requirePreviewAssetAccess(anon, req(), fakeCookies());
      throw new Error("expected a redirect");
    } catch (e) {
      expect(isRedirect(e) && e.location).toBe("/login");
    }
  });
});

// --- source-level regression guards ---------------------------------------

const SRC = resolve(import.meta.dir, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(svelte|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

describe("regression: no admin iframe runs preview scripts in the admin origin (#946)", () => {
  it("no iframe combines allow-scripts with allow-same-origin", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/sandbox(?:=|",\s*)"([^"]*)"/g)) {
        const flags = (m[1] ?? "").split(/\s+/);
        if (flags.includes("allow-scripts") && flags.includes("allow-same-origin")) {
          offenders.push(`${file.slice(SRC.length)}: sandbox="${m[1]}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every iframe that frames a page preview is sandboxed", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<iframe\b[^>]*>/g)) {
        const tag = m[0];
        const framesPreview = /data-caelo-live-preview|previewSrc|leftSrc|rightSrc|preview/i.test(
          tag,
        );
        if (framesPreview && !/\bsandbox=/.test(tag))
          offenders.push(`${file.slice(SRC.length)}: ${tag}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every page-preview route answers through previewDocumentResponse", () => {
    for (const route of [
      "routes/(authed)/edit/preview/[pageId]/+server.ts",
      "routes/(authed)/edit/preview-by-path/[...path]/+server.ts",
      "routes/(authed)/content/pages/[id]/preview/+server.ts",
      "routes/_caelo/preview-screenshot/[pageId]/+server.ts",
    ]) {
      const src = readFileSync(join(SRC, route), "utf8");
      expect(src).toContain("previewDocumentResponse(");
      expect(src).not.toContain("new Response(");
    }
  });
});
