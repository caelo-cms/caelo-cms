// SPDX-License-Identifier: MPL-2.0

/**
 * #1330 — the staging gateway serves the staged build behind the gate, on
 * every host. Unit level: an in-memory staging storage, the real gate.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  clientAddress,
  DEFAULT_STAGING_HEADER_NAME,
  deriveStagingCredential,
  type RedirectTableRow,
  SESSION_ENTRY,
  STAGING_ACCESS_PATH,
  STAGING_CHECK_PATH,
  STAGING_RUN_TOKEN_HEADER,
  type StagedManifest,
  type StagingAccessSettings,
  sessionCookieValue,
  signStagingRunToken,
  signStagingToken,
  stagedFileKey,
  stagedManifestKey,
} from "@caelo-cms/shared";
import {
  gateFailureLimiter,
  handleStagingSiteRequest,
  ManifestCache,
  type StagingSiteDeps,
  type StagingSiteState,
} from "./site.js";
import { directoryStagingStorage, type StagingStorage } from "./storage.js";

const SECRET = "gate-secret-0123456789abcdef0123456789";
const NOW = 1_900_000_000;
const RUN = "0b7c0d6e-1111-4111-8111-111111111111";
const LOCATION = "_slots/a";

const SETTINGS: StagingAccessSettings = {
  cookieEnabled: true,
  basicAuthEnabled: false,
  basicAuthUser: "crawler",
  basicAuthNonce: "nonce-basic",
  headerEnabled: true,
  headerName: DEFAULT_STAGING_HEADER_NAME,
  headerNonce: "nonce-header",
  ipAllowlist: ["203.0.113.0/24"],
};

const STATE: StagingSiteState = {
  host: "staging.example.com",
  settings: SETTINGS,
  gateSecret: SECRET,
  served: { runId: RUN, location: LOCATION, buildOrigin: "https://example.com" },
};

const MANIFEST: StagedManifest = {
  version: 1,
  runId: RUN,
  pageUrlStyle: "directory",
  files: {
    "index.html": { type: "text/html; charset=utf-8", hash: "h1" },
    "about/index.html": { type: "text/html; charset=utf-8", hash: "h2" },
    "404.html": { type: "text/html; charset=utf-8", hash: "h3" },
    "_assets/logo.png": { type: "image/png", hash: "h4" },
    "sitemap.xml": { type: "application/xml; charset=utf-8", hash: "h5" },
  },
};

const FILES: Record<string, string> = {
  [stagedManifestKey(LOCATION)]: JSON.stringify(MANIFEST),
  [stagedFileKey(LOCATION, "index.html")]:
    '<a href="https://example.com/about/">About</a><link rel="canonical" href="https://example.com/">',
  [stagedFileKey(LOCATION, "about/index.html")]: "<h1>About</h1>",
  [stagedFileKey(LOCATION, "404.html")]: "<h1>Not here</h1>",
  [stagedFileKey(LOCATION, "_assets/logo.png")]: "PNG https://example.com bytes",
  [stagedFileKey(LOCATION, "sitemap.xml")]: "<loc>https://example.com/about/</loc>",
  // Not in the manifest: must never be served.
  [stagedFileKey(LOCATION, "secret.txt")]: "never",
  [stagedFileKey("_slots/b", "index.html")]: "the other slot",
};

/** Storage keys every test may read, recorded so a test can assert none was touched. */
function memoryStorage(files: Record<string, string> = FILES): StagingStorage & {
  readonly reads: string[];
} {
  const reads: string[] = [];
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
  return {
    reads,
    describe: "memory",
    async readText(key) {
      reads.push(key);
      return files[key] ?? null;
    },
    async open(key) {
      reads.push(key);
      const text = files[key];
      return text === undefined ? null : { body: stream(text), size: text.length };
    },
  };
}

function deps(over: Partial<StagingSiteDeps> = {}): StagingSiteDeps {
  return {
    state: STATE,
    clientIp: "198.51.100.7",
    clientKey: "198.51.100.7",
    provider: "gcp",
    storage: memoryStorage(),
    manifests: new ManifestCache(),
    redirects: async () => [],
    failures: gateFailureLimiter(),
    api: async () =>
      new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
    secure: true,
    nowSeconds: () => NOW,
    ...over,
  };
}

async function sessionCookie(): Promise<string> {
  const token = await signStagingToken(SECRET, "session", NOW + 3600);
  return `__session=${sessionCookieValue(new Map([[SESSION_ENTRY.staging, { value: token, expiresAt: NOW + 3600 }]]))}`;
}

const get = (path: string, headers: Record<string, string> = {}, host = "staging.example.com") =>
  new Request(`https://${host}${path}`, { headers });

describe("#1330 staging gateway: the gate in front of everything", () => {
  it("serves nothing without the gate, on the staging host, run.app and any other host", async () => {
    for (const host of [
      "staging.example.com",
      "caelo-production-staging-gateway-abc-ew.a.run.app",
      "example.com",
    ]) {
      const storage = memoryStorage();
      for (const path of [
        "/",
        "/about/",
        "/_assets/logo.png",
        "/sitemap.xml",
        "/api/plugin/comments/list",
      ]) {
        const res = await handleStagingSiteRequest(get(path, {}, host), deps({ storage }));
        expect(res.status).toBe(403);
        expect(res.headers.get("x-robots-tag")).toBe("noindex");
        expect(await res.text()).not.toContain("About");
      }
      // Not one byte of staging storage was read for a refused request.
      expect(storage.reads).toEqual([]);
    }
  });

  it("answers 401 with a Basic challenge when basic auth is on", async () => {
    const res = await handleStagingSiteRequest(
      get("/"),
      deps({ state: { ...STATE, settings: { ...SETTINGS, basicAuthEnabled: true } } }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("admits the session entry, the secret header and a per-run token", async () => {
    const header = await deriveStagingCredential(SECRET, "header", "nonce-header");
    const run = await signStagingRunToken(SECRET, "capture", RUN, NOW + 300, NOW);
    for (const h of [
      { cookie: await sessionCookie() },
      { [DEFAULT_STAGING_HEADER_NAME]: header },
      { [STAGING_RUN_TOKEN_HEADER]: run },
    ]) {
      const res = await handleStagingSiteRequest(get("/about/", h), deps());
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<h1>About</h1>");
    }
  });

  it("refuses the IP allowlist on gcp-firebase, where no client address can be trusted", async () => {
    const inList = deps({ clientIp: "203.0.113.9", clientKey: "203.0.113.9" });
    expect((await handleStagingSiteRequest(get("/"), inList)).status).toBe(200);
    const firebase = deps({
      clientIp: "203.0.113.9",
      clientKey: "203.0.113.9",
      provider: "gcp-firebase",
    });
    expect((await handleStagingSiteRequest(get("/"), firebase)).status).toBe(403);
  });

  it("a forged X-Forwarded-For entry cannot satisfy the IP allowlist", async () => {
    // gcp: the load balancer appends `<client>, <lb>` (2 trusted hops). The
    // client puts an allowlisted address in front of its own.
    const forged = new Request("https://staging.example.com/", {
      headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7, 35.191.0.1" },
    });
    const ip = clientAddress(forged, 2, null);
    expect(ip).toBe("198.51.100.7");
    const res = await handleStagingSiteRequest(forged, deps({ clientIp: ip, clientKey: ip }));
    expect(res.status).toBe(403);
  });

  it("throttles a client after its failure budget, before any HMAC", async () => {
    const d = deps();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await handleStagingSiteRequest(get("/"), d)).status;
    expect(last).toBe(429);
    // Even a valid credential waits out the budget (DoS only, by design).
    const res = await handleStagingSiteRequest(get("/", { cookie: await sessionCookie() }), d);
    expect(res.status).toBe(429);
  });

  it("exchanges an Open-staging token for the __session staging entry, keeping other entries", async () => {
    const open = await signStagingToken(SECRET, "open", NOW + 60);
    const visitor = sessionCookieValue(
      new Map([[SESSION_ENTRY.visitorId, { value: "vid.sig", expiresAt: NOW + 999 }]]),
    );
    const res = await handleStagingSiteRequest(
      get(`${STAGING_ACCESS_PATH}?t=${encodeURIComponent(open)}&next=/about/`, {
        cookie: `__session=${visitor}`,
      }),
      deps(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/about/");
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toStartWith("__session=");
    const value = decodeURIComponent(set.split(";")[0]?.slice("__session=".length) ?? "");
    expect(value).toContain("staging=");
    expect(value).toContain("vid=");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
  });

  it("leaves only /healthz to the caller (the server routes it before the gate)", async () => {
    const res = await handleStagingSiteRequest(get("/healthz"), deps());
    expect(res.status).toBe(403);
  });
});

describe("#1330 staging gateway: serving the staged build", () => {
  const admitted = async (path: string, over: Partial<StagingSiteDeps> = {}) =>
    handleStagingSiteRequest(get(path, { cookie: await sessionCookie() }), deps(over));

  it("rewrites the live origin to the staging host in pages and sitemaps, not in binary files", async () => {
    const page = await admitted("/");
    expect(await page.text()).toBe(
      '<a href="https://staging.example.com/about/">About</a><link rel="canonical" href="https://staging.example.com/">',
    );
    expect(page.headers.get("content-length")).toBeNull();
    expect(await (await admitted("/sitemap.xml")).text()).toBe(
      "<loc>https://staging.example.com/about/</loc>",
    );
    const png = await admitted("/_assets/logo.png");
    expect(await png.text()).toBe("PNG https://example.com bytes");
    expect(png.headers.get("content-type")).toBe("image/png");
  });

  it("sends the build's page headers on documents only (#1454)", async () => {
    const securityHeaders = { "Referrer-Policy": "no-referrer", "X-Frame-Options": "SAMEORIGIN" };
    const storage = memoryStorage({
      ...FILES,
      [stagedManifestKey(LOCATION)]: JSON.stringify({ ...MANIFEST, securityHeaders }),
    });
    const cookie = await sessionCookie();
    const page = await handleStagingSiteRequest(
      get("/", { cookie }),
      deps({ storage, manifests: new ManifestCache() }),
    );
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const file = await handleStagingSiteRequest(
      get("/_assets/logo.png", { cookie }),
      deps({ storage, manifests: new ManifestCache() }),
    );
    expect(file.headers.get("referrer-policy")).toBeNull();
  });

  it("hashes an inline script holding the build's origin again for the staging host (#1454)", async () => {
    const script = 'fetch("https://example.com/api/x")';
    const served = 'fetch("https://staging.example.com/api/x")';
    const securityHeaders = {
      "Content-Security-Policy-Report-Only": "default-src 'self'; script-src 'self' 'sha256-build'",
    };
    const storage = memoryStorage({
      ...FILES,
      [stagedManifestKey(LOCATION)]: JSON.stringify({
        ...MANIFEST,
        securityHeaders,
        originBoundScripts: [script],
      }),
    });
    const page = await handleStagingSiteRequest(
      get("/", { cookie: await sessionCookie() }),
      deps({ storage, manifests: new ManifestCache() }),
    );
    const digest = createHash("sha256").update(served, "utf8").digest("base64");
    expect(page.headers.get("content-security-policy-report-only")).toBe(
      `default-src 'self'; script-src 'self' 'sha256-${digest}' 'sha256-build'`,
    );
  });

  it("marks every answer noindex and uncacheable by shared caches", async () => {
    const res = await admitted("/about/");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves only what the manifest lists, prefix-bound, traversal refused", async () => {
    const storage = memoryStorage();
    expect((await admitted("/secret.txt", { storage })).status).toBe(404);
    expect((await admitted("/../_slots/b/index.html", { storage })).status).toBe(404);
    // The URL parser resolves an encoded `..` before the gateway sees it:
    // still only a manifest path of the served slot.
    expect((await admitted("/%2e%2e/_slots/b/index.html", { storage })).status).toBe(404);
    for (const key of storage.reads) {
      expect(key.startsWith(`${LOCATION}/`) || key === stagedManifestKey(LOCATION)).toBe(true);
    }
    expect(storage.reads).not.toContain(stagedFileKey(LOCATION, "secret.txt"));
  });

  it("answers a missing page with the build's 404 page", async () => {
    const res = await admitted("/nope/");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Not here</h1>");
  });

  it("answers the published redirects; the live page wins; gone rows follow the provider", async () => {
    const rows: RedirectTableRow[] = [
      { fromPath: "/old", toPath: "/about", statusCode: 301 },
      { fromPath: "/about", toPath: "/elsewhere", statusCode: 301 },
      { fromPath: "/gone", toPath: "/", statusCode: 410 },
    ];
    const redirect = await admitted("/old/?x=1", { redirects: async () => rows });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/about/?x=1");
    // A file of the build shadows its row.
    expect((await admitted("/about/", { redirects: async () => rows })).status).toBe(200);
    expect(
      (await admitted("/gone", { redirects: async () => rows, provider: "self-hosted" })).status,
    ).toBe(410);
    expect(
      (await admitted("/gone", { redirects: async () => rows, provider: "gcp-firebase" })).status,
    ).toBe(404);
  });

  it("answers an approved external target with its address (#1358)", async () => {
    const rows: RedirectTableRow[] = [
      { fromPath: "/termin", toPath: "https://calendar.example/book", statusCode: 302 },
    ];
    const res = await admitted("/termin?x=1", { redirects: async () => rows });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://calendar.example/book?x=1");
  });

  it("says so when nothing is staged yet, or the served slot holds another run", async () => {
    const empty = await handleStagingSiteRequest(
      get("/", {}),
      deps({ state: { ...STATE, served: null } }),
    );
    expect(empty.status).toBe(403);
    const cookie = await sessionCookie();
    const nothing = await handleStagingSiteRequest(
      get("/", { cookie }),
      deps({ state: { ...STATE, served: null } }),
    );
    expect(nothing.status).toBe(503);
    const other = await handleStagingSiteRequest(
      get("/", { cookie }),
      deps({
        state: {
          ...STATE,
          served: { ...STATE.served!, runId: "0b7c0d6e-2222-4222-8222-222222222222" },
        },
      }),
    );
    expect(other.status).toBe(503);
  });

  it("passes admitted /api/* to the visitor routes of this gateway", async () => {
    const seen: string[] = [];
    const res = await admitted("/api/plugin/comments/list", {
      api: async (req) => {
        seen.push(new URL(req.url).pathname);
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["/api/plugin/comments/list"]);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("refuses everything but GET and HEAD for files", async () => {
    const res = await handleStagingSiteRequest(
      new Request("https://staging.example.com/", {
        method: "POST",
        headers: { cookie: await sessionCookie() },
      }),
      deps(),
    );
    expect(res.status).toBe(405);
  });

  it("is 503 until a process holding the gate key published it", async () => {
    const res = await handleStagingSiteRequest(
      get("/", { cookie: await sessionCookie() }),
      deps({ state: { ...STATE, gateSecret: null } }),
    );
    expect(res.status).toBe(503);
  });
});

describe("#1330 staging gateway: the admin's serve check", () => {
  it("answers the run a location holds, with a check token only", async () => {
    const check = await signStagingRunToken(SECRET, "check", RUN, NOW + 60, NOW);
    const ok = await handleStagingSiteRequest(
      get(`${STAGING_CHECK_PATH}?location=${LOCATION}`, { [STAGING_RUN_TOKEN_HEADER]: check }),
      deps(),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, runId: RUN, files: 5 });
    const capture = await signStagingRunToken(SECRET, "capture", RUN, NOW + 60, NOW);
    for (const h of [
      {},
      { [STAGING_RUN_TOKEN_HEADER]: capture },
      { cookie: await sessionCookie() },
    ]) {
      const res = await handleStagingSiteRequest(
        get(`${STAGING_CHECK_PATH}?location=${LOCATION}`, h),
        deps(),
      );
      expect(res.status).toBe(403);
    }
    const bad = await handleStagingSiteRequest(
      get(`${STAGING_CHECK_PATH}?location=../etc`, { [STAGING_RUN_TOKEN_HEADER]: check }),
      deps(),
    );
    expect(bad.status).toBe(400);
  });
});

describe("#1330 staging storage: a directory", () => {
  it("refuses keys that leave the root", async () => {
    const { mkdtemp, mkdir, writeFile, symlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "caelo-staging-"));
    const outside = await mkdtemp(join(tmpdir(), "caelo-outside-"));
    await writeFile(join(outside, "secret"), "x");
    await mkdir(join(root, "builds"), { recursive: true });
    await writeFile(join(root, "builds", "a.html"), "page");
    await symlink(join(outside, "secret"), join(root, "builds", "link"));
    const storage = directoryStagingStorage(root);
    expect(await storage.readText("builds/a.html")).toBe("page");
    expect(await storage.readText("builds/link")).toBeNull();
    await expect(storage.readText("../x")).rejects.toThrow(/refused key/);
    expect(await storage.readText("builds/missing")).toBeNull();
  });
});

describe("#1330 staging gateway: review hardening", () => {
  it("a serve-check token opens nothing but the serve check", async () => {
    const check = await signStagingRunToken(SECRET, "check", RUN, NOW + 60, NOW);
    const res = await handleStagingSiteRequest(
      get("/about/", { [STAGING_RUN_TOKEN_HEADER]: check }),
      deps(),
    );
    expect(res.status).toBe(403);
  });

  it("an exhausted failure budget stops the token exchange and the serve check too", async () => {
    const d = deps();
    for (let i = 0; i < 31; i++) await handleStagingSiteRequest(get("/"), d);
    const open = await signStagingToken(SECRET, "open", NOW + 60);
    const check = await signStagingRunToken(SECRET, "check", RUN, NOW + 60, NOW);
    expect(
      (
        await handleStagingSiteRequest(
          get(`${STAGING_ACCESS_PATH}?t=${encodeURIComponent(open)}`),
          d,
        )
      ).status,
    ).toBe(429);
    expect(
      (
        await handleStagingSiteRequest(
          get(`${STAGING_CHECK_PATH}?location=${LOCATION}`, { [STAGING_RUN_TOKEN_HEADER]: check }),
          d,
        )
      ).status,
    ).toBe(429);
  });

  it("marks admitted /api/* answers private and uncacheable", async () => {
    const res = await handleStagingSiteRequest(
      get("/api/captcha/challenge", { cookie: await sessionCookie() }),
      deps({ api: async () => new Response(null, { status: 204 }) }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("a file that started in time streams to its end, whatever its length", async () => {
    let pull = 0;
    const slow: StagingStorage = {
      describe: "slow",
      readText: async (key) => FILES[key] ?? null,
      open: async () => ({
        size: null,
        body: new ReadableStream<Uint8Array>({
          async pull(c) {
            pull += 1;
            if (pull > 3) {
              c.close();
              return;
            }
            await Bun.sleep(40);
            c.enqueue(new TextEncoder().encode(`chunk${pull} `));
          },
        }),
      }),
    };
    const res = await handleStagingSiteRequest(
      get("/_assets/logo.png", { cookie: await sessionCookie() }),
      deps({ storage: slow, firstByteBudgetMs: 50 }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("chunk1 chunk2 chunk3 ");
  });
});
