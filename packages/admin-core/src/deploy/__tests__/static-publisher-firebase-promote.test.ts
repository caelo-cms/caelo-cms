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
import {
  FakeChannelLifetimes,
  FIREBASE_EXPIRE_TIME_CLEAR_REFUSED,
} from "../../__tests__/fixtures/firebase-channel-lifetime.js";

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
const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_ORIGIN = `https://${SITE}.web.app/`;

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
  deletedChannels: string[] = [];
  /** When each channel expires, as the live API keeps it (#969). */
  lifetimes = new FakeChannelLifetimes();
  /** Channels whose DELETE answers 503, as a transient API failure would. */
  failDelete = new Set<string>();
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
    this.lifetimes.create(channelId, "604800s");
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const parsed = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};

    // #1155 — the live channel serves the live version's files.
    if (url.startsWith(LIVE_ORIGIN)) {
      const key = `/${url.slice(LIVE_ORIGIN.length)}`;
      const name = this.live[0];
      const v = name ? this.versions.get(name.split("/").pop() ?? "") : undefined;
      const hash = v?.files[key];
      const gz = hash ? this.blobs.get(hash) : undefined;
      return gz ? new Response(gunzipSync(gz)) : new Response("", { status: 404 });
    }
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
    if (method === "GET" && route === `sites/${SITE}/channels`) {
      // Two pages, so pruning has to follow nextPageToken.
      const all = [...this.channels.keys(), "live"];
      const page = params.get("pageToken") === "p2" ? all.slice(1) : all.slice(0, 1);
      return json({
        channels: page.map((id) => ({
          name: `sites/${SITE}/channels/${id}`,
          expireTime: this.lifetimes.expireTime(id),
        })),
        ...(params.get("pageToken") === "p2" ? {} : { nextPageToken: "p2" }),
      });
    }
    const channel = route.match(/^sites\/[^/]+\/channels\/([^/]+)$/);
    if (method === "DELETE" && channel) {
      if (channel[1] === "live") throw new Error("must never delete the live channel");
      if (this.failDelete.has(channel[1]!)) {
        return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
      }
      if (!this.channels.delete(channel[1]!)) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      this.deletedChannels.push(channel[1]!);
      this.lifetimes.forget(channel[1]!);
      return new Response("", { status: 200 });
    }
    if (method === "GET" && channel?.[1] === "live") {
      return json({ name: `sites/${SITE}/channels/live`, url: LIVE_ORIGIN.slice(0, -1) });
    }
    if (method === "GET" && channel) {
      if (!this.channels.has(channel[1]!)) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      return json({
        name: `sites/${SITE}/channels/${channel[1]}`,
        expireTime: this.lifetimes.expireTime(channel[1]!),
      });
    }
    if (method === "PATCH" && channel) {
      // The live API would implicitly create a missing channel; Caelo must
      // never rely on that (staging would serve an empty channel).
      if (!this.channels.has(channel[1]!)) throw new Error("patch on unknown channel");
      return this.lifetimes.patch(SITE, channel[1]!, params.get("updateMask"), parsed);
    }
    if (method === "POST" && route === `sites/${SITE}/channels`) {
      const channelId = params.get("channelId") ?? "";
      this.channels.set(channelId, []);
      this.lifetimes.create(channelId, parsed.ttl);
      return json({
        name: `sites/${SITE}/channels/${channelId}`,
        url: `https://${SITE}--${channelId}.web.app`,
      });
    }
    if (method === "GET" && channelReleases?.[1] === "live") {
      return json({ releases: this.live.map((name) => ({ name: "r", version: { name } })) });
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
    const staged = await firebaseHostingPublisher.publishStaging({
      buildDir,
      runId: "run-2",
      target: STAGING,
    });
    // #650 — the run's preview channel may be gone by now (a later Stage
    // retired it); rollback uses the Hosting version the run recorded.
    await firebaseHostingPublisher.selectStagingPreview!({ servedRunId: null });
    await firebaseHostingPublisher.rollback({
      targetBuildId: "run-2",
      sourceBuildDir: buildDir,
      target: PRODUCTION,
      siteBaseUrl: SITE_BASE_URL,
      sourceLocation: staged.location,
    });
    const live = fake.liveVersion();
    expect(robotsHeaders(live.config)).toEqual([]);
    const { VERSION_CONFIG_HEADERS } = await import("../static-publisher-firebase.js");
    expect(live.config.headers).toEqual([...VERSION_CONFIG_HEADERS]);
    expect(fake.fileBody(live, "/robots.txt")).toContain("Allow: /");
    expect(fake.fileBody(live, "/robots.txt")).toContain("Sitemap:");
  });
});

describe("firebaseHostingPublisher — protected staging domain (#650)", () => {
  it("rollback without a recorded Hosting version fails loudly", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await expect(
      firebaseHostingPublisher.rollback({
        targetBuildId: "run-x",
        sourceBuildDir: buildDir,
        target: PRODUCTION,
        siteBaseUrl: SITE_BASE_URL,
        sourceLocation: null,
      }),
    ).rejects.toThrow("no recorded Hosting version");
    expect(fake.live).toEqual([]);
  });

  it("publishLiveBuild releases the rebuilt tree itself on the live channel, without noindex", async () => {
    const { firebaseHostingPublisher, VERSION_CONFIG_HEADERS } = await import(
      "../static-publisher-firebase.js"
    );
    await writeFile(
      join(buildDir, "robots.txt"),
      `User-agent: *\nAllow: /\n\nSitemap: ${SITE_BASE_URL}/sitemap.xml\n`,
      "utf8",
    );
    const summary = await firebaseHostingPublisher.publishLiveBuild!({
      buildDir,
      runId: "prod-run",
      target: PRODUCTION,
      sourceRunId: "stage-run",
    });
    const live = fake.liveVersion();
    expect(summary.location).toBe(fake.live[0]!);
    expect(summary.destinationBuildId).toBe("stage-run");
    expect(live.status).toBe("FINALIZED");
    expect(live.config.headers).toEqual([...VERSION_CONFIG_HEADERS]);
    expect(fake.fileBody(live, "/about/index.html")).toBe(PAGE_HTML);
    expect(fake.fileBody(live, "/robots.txt")).toContain("Allow: /");
    // No preview channel for a live build.
    expect(fake.channels.size).toBe(0);
  });

  it("#1003 publishStaging and publishLiveBuild report their steps in order", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    const staged = await firebaseHostingPublisher.publishStaging({
      buildDir,
      runId: "run-timed",
      target: STAGING,
    });
    expect(staged.phases?.map((p) => p.phase)).toEqual([
      "auth",
      "hash",
      "create-version",
      "populate",
      "upload",
      "finalize",
      "channel",
      "release",
    ]);
    const live = await firebaseHostingPublisher.publishLiveBuild!({
      buildDir,
      runId: "run-timed-live",
      target: PRODUCTION,
      sourceRunId: "run-timed",
    });
    expect(live.phases?.map((p) => p.phase)).toEqual([
      "auth",
      "hash",
      "create-version",
      "populate",
      "upload",
      "finalize",
      "release",
    ]);
    for (const p of [...(staged.phases ?? []), ...(live.phases ?? [])]) {
      expect(p.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("selectStagingPreview deletes every other run channel, keeps the served one and never touches live", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    for (const runId of ["run-old-1", "run-old-2", "run-new"]) {
      await firebaseHostingPublisher.publishStaging({ buildDir, runId, target: STAGING });
    }
    fake.channels.set("someone-elses-channel", []);
    fake.lifetimes.create("someone-elses-channel", "604800s");
    const r = await firebaseHostingPublisher.selectStagingPreview!({ servedRunId: "run-new" });
    expect([...r.retired].sort()).toEqual(["runid-run-old-1", "runid-run-old-2"]);
    expect(r.notRetired).toEqual([]);
    expect([...fake.channels.keys()].sort()).toEqual(["runid-run-new", "someone-elses-channel"]);

    // Nothing served: every run channel goes.
    await firebaseHostingPublisher.selectStagingPreview!({ servedRunId: null });
    expect([...fake.channels.keys()]).toEqual(["someone-elses-channel"]);
  });

  it("#908 publishStaging keeps the finite TTL: a Stage that fails before selection leaves nothing beyond a week", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-dies", target: STAGING });
    expect(fake.channels.get("runid-run-dies")?.length).toBe(1);
    expect(fake.lifetimes.remainingMs("runid-run-dies")).toBeLessThanOrEqual(7 * DAY_MS);
  });

  it("#969 the fake refuses the expireTime clear exactly like the live API", async () => {
    // Guards the fake itself: #909 passed its tests because the fake
    // accepted a request the live API answers with this 400.
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-x", target: STAGING });
    const res = await fake.fetch(`${API}sites/${SITE}/channels/runid-run-x?updateMask=expireTime`, {
      method: "PATCH",
      body: JSON.stringify({ expireTime: null }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(FIREBASE_EXPIRE_TIME_CLEAR_REFUSED);
  });

  it("#969 selection succeeds and refreshes the served channel's TTL to 30 days (no expireTime clear)", async () => {
    const { firebaseHostingPublisher, SERVED_PREVIEW_CHANNEL_TTL } = await import(
      "../static-publisher-firebase.js"
    );
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-idle", target: STAGING });
    const r = await firebaseHostingPublisher.selectStagingPreview!({ servedRunId: "run-idle" });
    expect(SERVED_PREVIEW_CHANNEL_TTL).toBe("2592000s");
    expect(fake.lifetimes.ttlPatches).toEqual([
      { channelId: "runid-run-idle", ttl: SERVED_PREVIEW_CHANNEL_TTL },
    ]);
    expect(r.servedExpiresAt).toBe(fake.lifetimes.expireTime("runid-run-idle"));
    // An idle week (the #969 acceptance) and more cannot expire it.
    expect(fake.lifetimes.remainingMs("runid-run-idle")).toBeGreaterThan(29 * DAY_MS);
  });

  it("#969 selection refreshes the TTL of a served channel staged by an earlier version (7-day TTL)", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    // Staged and recorded by the previous version: served, but on its
    // 7-day TTL with 2 days left. Publish live re-selects it.
    fake.seedVersion("runid-run-legacy", { headers: [] }, { "/index.html": "abc" });
    fake.lifetimes.seed("runid-run-legacy", Date.now() + 2 * DAY_MS);
    await firebaseHostingPublisher.selectStagingPreview!({ servedRunId: "run-legacy" });
    expect(fake.channels.has("runid-run-legacy")).toBe(true);
    expect(fake.lifetimes.remainingMs("runid-run-legacy")).toBeGreaterThan(29 * DAY_MS);
  });

  it("#969 refreshStagingPreview pushes the served channel's expiry out again and touches nothing else", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-old", target: STAGING });
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-a", target: STAGING });
    await firebaseHostingPublisher.selectStagingPreview!({ servedRunId: "run-a" });
    expect(fake.deletedChannels).toEqual(["runid-run-old"]);
    // 20 idle days later the keep-alive ticks.
    const start = Date.now();
    fake.lifetimes.now = () => start + 20 * DAY_MS;
    expect(fake.lifetimes.remainingMs("runid-run-a")).toBeLessThan(11 * DAY_MS);
    const patchesBefore = fake.lifetimes.ttlPatches.length;
    const r = await firebaseHostingPublisher.refreshStagingPreview!({ servedRunId: "run-a" });
    expect(r.expiresAt).toBe(fake.lifetimes.expireTime("runid-run-a"));
    expect(fake.lifetimes.remainingMs("runid-run-a")).toBeGreaterThan(29 * DAY_MS);
    expect(fake.lifetimes.ttlPatches.slice(patchesBefore).map((p) => p.channelId)).toEqual([
      "runid-run-a",
    ]);
    expect(fake.deletedChannels).toEqual(["runid-run-old"]);
  });

  it("#969 refreshStagingPreview fails loudly when the served channel is gone, and never recreates it", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await expect(
      firebaseHostingPublisher.refreshStagingPreview!({ servedRunId: "run-gone" }),
    ).rejects.toThrow("Stage again");
    expect(fake.channels.size).toBe(0);
  });

  it("#969 a TTL refresh Firebase answers without an expireTime fails loudly", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-a", target: STAGING });
    const inner = fake.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH" && String(input).includes("updateMask=ttl")) {
        return new Response(JSON.stringify({ name: "x" }), { status: 200 });
      }
      return inner(input, init);
    }) as typeof fetch;
    await expect(
      firebaseHostingPublisher.selectStagingPreview!({ servedRunId: "run-a" }),
    ).rejects.toThrow("returned no expireTime");
  });

  it("#908 a channel that stops being served gets the short TTL back, so a failed delete still expires within a week", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-a", target: STAGING });
    await firebaseHostingPublisher.selectStagingPreview!({ servedRunId: "run-a" });
    expect(fake.lifetimes.remainingMs("runid-run-a")).toBeGreaterThan(29 * DAY_MS);

    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-b", target: STAGING });
    fake.failDelete.add("runid-run-a");
    const r = await firebaseHostingPublisher.selectStagingPreview!({ servedRunId: "run-b" });
    expect(r.retired).toEqual([]);
    expect(r.notRetired.map((n) => n.preview)).toEqual(["runid-run-a"]);
    expect(fake.channels.has("runid-run-a")).toBe(true);
    expect(fake.lifetimes.remainingMs("runid-run-a")).toBeLessThanOrEqual(7 * DAY_MS);
    expect(fake.lifetimes.remainingMs("runid-run-b")).toBeGreaterThan(29 * DAY_MS);

    // The next selection retires it.
    fake.failDelete.clear();
    const next = await firebaseHostingPublisher.selectStagingPreview!({ servedRunId: "run-b" });
    expect(next.retired).toEqual(["runid-run-a"]);
    expect([...fake.channels.keys()]).toEqual(["runid-run-b"]);
  });

  it("#969 a never-served preview is deleted without a TTL round-trip", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-a", target: STAGING });
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-b", target: STAGING });
    await firebaseHostingPublisher.selectStagingPreview!({ servedRunId: "run-b" });
    expect(fake.lifetimes.ttlPatches.map((p) => p.channelId)).toEqual(["runid-run-b"]);
    expect(fake.deletedChannels).toEqual(["runid-run-a"]);
  });

  it("#908 selecting a served channel that no longer exists fails loudly and retires nothing", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-a", target: STAGING });
    await expect(
      firebaseHostingPublisher.selectStagingPreview!({ servedRunId: "run-gone" }),
    ).rejects.toThrow("Stage again");
    expect([...fake.channels.keys()]).toEqual(["runid-run-a"]);
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

describe("outlivesRetiredPreviewTtl (#969)", () => {
  const NOW = Date.parse("2026-10-21T12:00:00Z");

  it("is false for a preview within the regular 7-day TTL", async () => {
    const { outlivesRetiredPreviewTtl } = await import("../static-publisher-firebase.js");
    expect(outlivesRetiredPreviewTtl("2026-10-28T12:00:00Z", NOW)).toBe(false);
    expect(outlivesRetiredPreviewTtl("2026-10-22T00:00:00Z", NOW)).toBe(false);
  });

  it("is true for a served (30-day) preview and for one without an expiry", async () => {
    const { outlivesRetiredPreviewTtl } = await import("../static-publisher-firebase.js");
    expect(outlivesRetiredPreviewTtl("2026-11-20T12:00:00Z", NOW)).toBe(true);
    expect(outlivesRetiredPreviewTtl("2026-10-28T12:00:01Z", NOW)).toBe(true);
    expect(outlivesRetiredPreviewTtl(null, NOW)).toBe(true);
  });

  it("fails loudly on an expireTime it cannot read", async () => {
    const { outlivesRetiredPreviewTtl } = await import("../static-publisher-firebase.js");
    expect(() => outlivesRetiredPreviewTtl("in 604800s", NOW)).toThrow("unparseable");
  });
});

describe("firebaseHostingPublisher — security headers (#891)", () => {
  it("Publish live of a version staged before #891 goes live with the SVG CSP + nosniff", async () => {
    // A pre-#891 staging version: cache entries + staging robots, no
    // security entries.
    fake.seedVersion(
      "runid-pre-891",
      {
        headers: [
          { regex: "^/_assets/", headers: { "Cache-Control": "public, max-age=3600" } },
          { glob: "**", headers: { "X-Robots-Tag": "noindex" } },
        ],
      },
      { "/index.html": "abc" },
    );
    const { firebaseHostingPublisher, SECURITY_HEADER_ENTRIES } = await import(
      "../static-publisher-firebase.js"
    );
    await firebaseHostingPublisher.promoteToProduction({
      sourceRunId: "pre-891",
      sourceBuildDir: buildDir,
      fromTarget: STAGING,
      toTarget: PRODUCTION,
      siteBaseUrl: SITE_BASE_URL,
    });
    expect(fake.liveVersion().config.headers).toEqual([
      { regex: "^/_assets/", headers: { "Cache-Control": "public, max-age=3600" } },
      ...SECURITY_HEADER_ENTRIES,
    ]);
  });
});

describe("withSecurityHeaders", () => {
  it("replaces stale security entries (case-insensitive) and keeps everything else", async () => {
    const { withSecurityHeaders, SECURITY_HEADER_ENTRIES } = await import(
      "../static-publisher-firebase.js"
    );
    const cache = { glob: "/**/*.html", headers: { "Cache-Control": "public, max-age=60" } };
    const config = {
      rewrites: [{ glob: "/api/**" }],
      headers: [
        cache,
        { glob: "**/*.svg", headers: { "content-security-policy": "default-src *" } },
        { glob: "**", headers: { "x-content-type-options": "nosniff" } },
      ],
    };
    expect(withSecurityHeaders(config)).toEqual({
      rewrites: [{ glob: "/api/**" }],
      headers: [cache, ...SECURITY_HEADER_ENTRIES],
    });
    // Idempotent: a config that already has them is left as it is.
    const once = withSecurityHeaders(config);
    expect(withSecurityHeaders(once)).toEqual(once);
  });
});

describe("firebaseHostingPublisher — plugin-data release (#1155)", () => {
  async function publishLive() {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    await firebaseHostingPublisher.publishStaging({ buildDir, runId: "run-1", target: STAGING });
    const promoted = await firebaseHostingPublisher.promoteToProduction({
      sourceRunId: "run-1",
      sourceBuildDir: buildDir,
      fromTarget: STAGING,
      toTarget: PRODUCTION,
      siteBaseUrl: SITE_BASE_URL,
    });
    const live = { runId: "p1", buildId: "run-1", location: promoted.location, localBuildDir: "" };
    return { publisher: firebaseHostingPublisher, live };
  }

  it("reads the live files and releases the live version with only the given files replaced", async () => {
    const { publisher, live } = await publishLive();
    const before = fake.liveVersion();
    const read = await publisher.readLiveFiles({
      target: PRODUCTION,
      live,
      paths: ["about/index.html", "missing.html"],
    });
    expect(read.get("about/index.html")?.toString("utf8")).toBe(PAGE_HTML);
    expect(read.get("missing.html")).toBeNull();

    const baked = "<html><body>about + a new comment</body></html>";
    const summary = await publisher.publishPluginData({
      target: PRODUCTION,
      live,
      runId: "pd-1",
      files: new Map([["about/index.html", Buffer.from(baked)]]),
    });
    const after = fake.liveVersion();
    expect(summary.location).toBe(fake.live[0]!);
    expect(summary.destinationBuildId).toBe("pd-1");
    expect(summary.uploadedCount).toBe(1);
    expect(after.status).toBe("FINALIZED");
    // Config verbatim: headers, rewrites, redirects.
    expect(after.config).toEqual(before.config);
    // Every file by the same hash, except the replaced one.
    const { "/about/index.html": changed, ...rest } = after.files;
    const { "/about/index.html": was, ...restBefore } = before.files;
    expect(rest).toEqual(restBefore);
    expect(changed).not.toBe(was);
    expect(fake.fileBody(after, "/about/index.html")).toBe(baked);
  });

  it("refuses a file the live version does not have", async () => {
    const { publisher, live } = await publishLive();
    await expect(
      publisher.publishPluginData({
        target: PRODUCTION,
        live,
        runId: "pd-1",
        files: new Map([["new-page/index.html", Buffer.from("x")]]),
      }),
    ).rejects.toThrow(/not a file of the live version/);
  });

  it("refuses when the live channel serves a release no run recorded", async () => {
    const { publisher, live } = await publishLive();
    fake.live.unshift(fake.versionName("released-elsewhere"));
    await expect(
      publisher.publishPluginData({
        target: PRODUCTION,
        live,
        runId: "pd-1",
        files: new Map([["about/index.html", Buffer.from("x")]]),
      }),
    ).rejects.toThrow(/released outside Caelo/);
    await expect(
      publisher.readLiveFiles({ target: PRODUCTION, live, paths: ["about/index.html"] }),
    ).rejects.toThrow(/released outside Caelo/);
  });
});
