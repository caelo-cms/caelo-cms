// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: "Publish live" on gcp-firebase must not ship staging's
 * robots semantics. The live release is a copy of the staging Hosting
 * version, so everything env-level that lives in the version — the
 * robots.txt file and the version-config response headers — has to be
 * rewritten for the destination target, and staging has to stay
 * non-indexable through exactly those artefacts (its page HTML no
 * longer carries an env-level noindex meta).
 *
 * Runs the real publisher against an in-memory fake of the Firebase
 * Hosting REST surface it calls (versions, populateFiles, upload,
 * channels, releases) — no network, no credentials.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { DeployTarget } from "@caelo-cms/static-generator";
// Snapshot the real module so afterAll can undo the process-global
// mock.module below (issue #305 — same pattern as the GCS test).
import * as realGoogleAuth from "google-auth-library";

const realGoogleAuthExports = { ...realGoogleAuth };

mock.module("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: async () => ({ token: "test-token" }) };
    }
  },
}));

afterAll(() => {
  mock.module("google-auth-library", () => realGoogleAuthExports);
});

const API = "https://firebasehosting.googleapis.com/v1beta1/";
const UPLOAD = "https://upload.test/";
const SITE = "test-site";
const SITE_BASE_URL = "https://www.example.com";

interface HeaderEntry {
  glob?: string;
  regex?: string;
  headers: Record<string, string>;
}
interface VersionConfig {
  headers?: HeaderEntry[];
  rewrites?: unknown[];
  redirects?: unknown[];
}
interface FakeVersion {
  config: VersionConfig;
  files: Record<string, string>;
  status: string;
}

/** In-memory Firebase Hosting: just enough of the REST API. */
class FakeFirebase {
  versions = new Map<string, FakeVersion>();
  channels = new Map<string, string[]>(); // channelId → versionNames (newest first)
  live: string[] = []; // versionNames released on the live channel (newest first)
  blobs = new Map<string, Buffer>(); // sha256 → gzipped body
  private seq = 0;

  versionName(id: string): string {
    return `sites/${SITE}/versions/${id}`;
  }

  liveVersion(): FakeVersion {
    const name = this.live[0];
    if (!name) throw new Error("nothing released live");
    const v = this.versions.get(name.split("/").pop() ?? "");
    if (!v) throw new Error(`unknown live version ${name}`);
    return v;
  }

  fileBody(v: FakeVersion, path: string): string {
    const hash = v.files[path];
    const gz = hash ? this.blobs.get(hash) : undefined;
    if (!gz) throw new Error(`no uploaded body for ${path}`);
    return gunzipSync(gz).toString("utf8");
  }

  /** Seed a staging version the way a pre-fix publisher created it. */
  seedVersion(channelId: string, config: VersionConfig, files: Record<string, string>): void {
    const id = `seed${++this.seq}`;
    this.versions.set(id, { config, files, status: "FINALIZED" });
    this.channels.set(channelId, [this.versionName(id)]);
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const parsed = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};

    if (url.startsWith(UPLOAD)) {
      const sha = url.split("/").pop() ?? "";
      this.blobs.set(sha, Buffer.from(init?.body as Uint8Array));
      return json({});
    }
    if (!url.startsWith(API)) throw new Error(`unexpected fetch ${url}`);
    const path = url.slice(API.length);
    const [route = "", query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    const populate = route.match(/^sites\/[^/]+\/versions\/([^/:]+):populateFiles$/);
    const files = route.match(/^sites\/[^/]+\/versions\/([^/:]+)\/files$/);
    const version = route.match(/^sites\/[^/]+\/versions\/([^/:]+)$/);
    const channelReleases = route.match(/^sites\/[^/]+\/channels\/([^/]+)\/releases$/);

    if (method === "POST" && route === `sites/${SITE}/versions`) {
      const id = `v${++this.seq}`;
      this.versions.set(id, { config: parsed.config ?? {}, files: {}, status: "CREATED" });
      return json({ name: this.versionName(id) });
    }
    if (populate) {
      const m = populate;
      const v = this.versions.get(m[1]!);
      if (!v) throw new Error("populate on unknown version");
      v.files = parsed.files;
      const required = [...new Set(Object.values(v.files))].filter((h) => !this.blobs.has(h));
      return json({ uploadRequiredHashes: required, uploadUrl: `${UPLOAD}${m[1]}` });
    }
    if (files) {
      const m = files;
      const v = this.versions.get(m[1]!);
      if (!v) throw new Error("files of unknown version");
      return json({
        files: Object.entries(v.files).map(([p, hash]) => ({ path: p, hash, status: "ACTIVE" })),
      });
    }
    if (version) {
      const m = version;
      const v = this.versions.get(m[1]!);
      if (!v) throw new Error("unknown version");
      if (method === "PATCH") {
        v.status = parsed.status;
        return json({});
      }
      return json({ name: this.versionName(m[1]!), config: v.config });
    }
    if (method === "POST" && route === `sites/${SITE}/channels`) {
      const channelId = params.get("channelId") ?? "";
      this.channels.set(channelId, []);
      return json({
        name: `sites/${SITE}/channels/${channelId}`,
        url: `https://${SITE}--${channelId}.web.app`,
      });
    }
    if (channelReleases) {
      const m = channelReleases;
      const releases = this.channels.get(m[1]!) ?? [];
      if (method === "POST") {
        releases.unshift(params.get("versionName") ?? "");
        this.channels.set(m[1]!, releases);
        return json({});
      }
      return json({ releases: releases.map((name) => ({ name: "r", version: { name } })) });
    }
    if (method === "POST" && route === `sites/${SITE}/releases`) {
      this.live.unshift(params.get("versionName") ?? "");
      return json({});
    }
    throw new Error(`unhandled ${method} ${url}`);
  };
}

const STAGING: DeployTarget = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "staging",
  env: "staging",
  outDir: "output/staging",
  baseUrl: "",
  robotsDefault: "noindex",
  isDefault: false,
};
const PRODUCTION: DeployTarget = {
  ...STAGING,
  id: "00000000-0000-0000-0000-000000000002",
  name: "production",
  env: "production",
  robotsDefault: "index",
  isDefault: true,
};

const PAGE_HTML = "<html><head><title>About</title></head><body>about</body></html>";

let fake: FakeFirebase;
let buildDir: string;
const realFetch = globalThis.fetch;
const ENV_KEYS = ["CAELO_FIREBASE_SITE", "CAELO_GATEWAY_SERVICE", "CAELO_GATEWAY_REGION"] as const;
const savedEnv: Record<string, string | undefined> = {};

function robotsHeaders(config: VersionConfig): HeaderEntry[] {
  return (config.headers ?? []).filter((e) =>
    Object.keys(e.headers).some((k) => k.toLowerCase() === "x-robots-tag"),
  );
}

beforeEach(async () => {
  fake = new FakeFirebase();
  globalThis.fetch = fake.fetch as typeof fetch;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CAELO_FIREBASE_SITE = SITE;
  process.env.CAELO_GATEWAY_SERVICE = "gateway";
  process.env.CAELO_GATEWAY_REGION = "europe-west1";
  // A staging build as the generator writes it: env-independent page
  // HTML + sitemap, staging robots.txt, manifest with the promote flag.
  buildDir = await mkdtemp(join(tmpdir(), "caelo-fb-"));
  await mkdir(join(buildDir, "about"), { recursive: true });
  await writeFile(join(buildDir, "about", "index.html"), PAGE_HTML, "utf8");
  await writeFile(join(buildDir, "index.html"), PAGE_HTML, "utf8");
  await writeFile(join(buildDir, "sitemap.xml"), "<urlset></urlset>", "utf8");
  await writeFile(join(buildDir, "robots.txt"), "User-agent: *\nDisallow: /\n", "utf8");
  await writeFile(join(buildDir, "_redirects"), "# generated\n/de / 301\n", "utf8");
  await writeFile(
    join(buildDir, "routing-manifest.json"),
    JSON.stringify({ env: "staging", envNoindexInHtml: false }),
    "utf8",
  );
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(buildDir, { recursive: true, force: true });
});

describe("firebaseHostingPublisher — env-level robots per target", () => {
  it("staging versions send X-Robots-Tag: noindex; production versions do not", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-a", target: STAGING });
    const staged = fake.versions.get("v1");
    const { VERSION_CONFIG_HEADERS } = await import("../static-publisher-firebase.js");
    // #555's cache entries + the staging-only robots entry, nothing else.
    expect(staged!.config.headers).toEqual([
      ...VERSION_CONFIG_HEADERS,
      { glob: "**", headers: { "X-Robots-Tag": "noindex" } },
    ]);

    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-b", target: PRODUCTION });
    const direct = [...fake.versions.values()].at(-1);
    expect(direct!.config.headers).toEqual([...VERSION_CONFIG_HEADERS]);
  });

  it("Publish live drops the noindex header, keeps content, and serves production robots + sitemap", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-1", target: STAGING });
    const staged = fake.versions.get("v1")!;

    const summary = await firebaseHostingPublisher.promoteToProduction({
      sourceRunId: "run-1",
      sourceBuildDir: buildDir,
      fromTarget: STAGING,
      toTarget: PRODUCTION,
      siteBaseUrl: SITE_BASE_URL,
    });
    const live = fake.liveVersion();
    expect(summary.location).toBe(fake.live[0]!);
    expect(live.status).toBe("FINALIZED");

    // No staging noindex header reaches the live release; the rest of
    // the config (gateway rewrite, cache headers) carries over.
    expect(robotsHeaders(live.config)).toEqual([]);
    expect(live.config.rewrites).toEqual(staged.config.rewrites);
    // The redirects table ships as Hosting redirect rules and survives
    // the promote (gcp-firebase serves no `_redirects` file).
    expect(staged.config.redirects).toEqual([{ regex: "^/de/?$", location: "/", statusCode: 301 }]);
    expect(live.config.redirects).toEqual(staged.config.redirects);
    // #555 — the live release keeps exactly the immutable (content-hashed)
    // and short-cache (pages, robots, sitemap) entries.
    const { VERSION_CONFIG_HEADERS } = await import("../static-publisher-firebase.js");
    expect(live.config.headers).toEqual([...VERSION_CONFIG_HEADERS]);

    // What staging shows is what production gets: every file but
    // robots.txt is the very same content hash.
    for (const [path, hash] of Object.entries(staged.files)) {
      if (path === "/robots.txt") continue;
      expect(live.files[path]).toBe(hash);
    }
    expect(fake.fileBody(live, "/about/index.html")).not.toContain('name="robots"');
    expect(live.files["/sitemap.xml"]).toBeDefined();
    expect(fake.fileBody(live, "/robots.txt")).toBe(
      `User-agent: *\nAllow: /\n\nSitemap: ${SITE_BASE_URL}/sitemap.xml\n`,
    );
    // Staging itself is untouched — still Disallow + noindex header.
    expect(fake.fileBody(staged, "/robots.txt")).toContain("Disallow: /");
    expect(robotsHeaders(staged.config).length).toBe(1);
  });

  it("refuses to promote a legacy staging version (env noindex baked into its HTML)", async () => {
    // Pre-fix staging versions carried no robots header in their config
    // — their pages carried `<meta name="robots" content="noindex">`.
    fake.seedVersion("runid-legacy", { headers: [] }, { "/index.html": "abc" });
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await expect(
      firebaseHostingPublisher.promoteToProduction({
        sourceRunId: "legacy",
        sourceBuildDir: buildDir,
        fromTarget: STAGING,
        toTarget: PRODUCTION,
        siteBaseUrl: SITE_BASE_URL,
      }),
    ).rejects.toThrow("run Stage again");
    expect(fake.live).toEqual([]);
  });

  it("rollback to a promoted build re-derives the production release instead of re-releasing staging", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-2", target: STAGING });
    await firebaseHostingPublisher.rollback({
      targetBuildId: "run-2",
      sourceBuildDir: buildDir,
      target: PRODUCTION,
      siteBaseUrl: SITE_BASE_URL,
    });
    const live = fake.liveVersion();
    expect(robotsHeaders(live.config)).toEqual([]);
    const { VERSION_CONFIG_HEADERS } = await import("../static-publisher-firebase.js");
    expect(live.config.headers).toEqual([...VERSION_CONFIG_HEADERS]);
    expect(fake.fileBody(live, "/robots.txt")).toContain("Allow: /");
    expect(fake.fileBody(live, "/robots.txt")).toContain("Sitemap:");
  });
});

describe("withTargetRobotsHeader", () => {
  it("replaces any X-Robots-Tag entry (case-insensitive) and leaves the rest alone", async () => {
    const { withTargetRobotsHeader } = await import("../static-publisher-firebase.js");
    const config = {
      rewrites: [{ glob: "/api/**" }],
      headers: [
        { glob: "/**/*.html", headers: { "Cache-Control": "public, max-age=60" } },
        { glob: "**", headers: { "x-robots-tag": "noindex, nofollow" } },
      ],
    };
    expect(withTargetRobotsHeader(config, "index")).toEqual({
      rewrites: [{ glob: "/api/**" }],
      headers: [{ glob: "/**/*.html", headers: { "Cache-Control": "public, max-age=60" } }],
    });
    expect(withTargetRobotsHeader(config, "noindex").headers).toEqual([
      { glob: "/**/*.html", headers: { "Cache-Control": "public, max-age=60" } },
      { glob: "**", headers: { "X-Robots-Tag": "noindex" } },
    ]);
  });
});
