// SPDX-License-Identifier: MPL-2.0

/**
 * #1157 — a saved redirect reaches Firebase Hosting without a build: a new
 * version that reuses the served version's files by hash, with only
 * `config.redirects` replaced, released on the channel it was served on.
 *
 * Runs syncFirebaseRedirects against an in-memory fake of the Hosting REST
 * calls it makes — no network, no credentials.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { RedirectTableRow } from "@caelo-cms/shared";
import type { DeployTarget } from "@caelo-cms/static-generator";
import {
  _clearFirebaseFileListCache,
  type FirebaseCall,
  syncFirebaseRedirects,
} from "../firebase-redirect-sync.js";

const SITE = "s";

interface Version {
  config: Record<string, unknown>;
  files: Record<string, string>;
  status: string;
}

/** Just the Hosting calls a redirect sync makes. */
class FakeHosting {
  versions = new Map<string, Version>();
  /** channelId → released version names, newest first. */
  releases = new Map<string, string[]>();
  /** Release bodies, for the release message. */
  releaseBodies: unknown[] = [];
  fileListCalls = 0;
  /** Hashes populateFiles pretends are missing. */
  missing: string[] = [];
  private seq = 0;

  seed(channelId: string, version: Version): string {
    const name = `sites/${SITE}/versions/seed${++this.seq}`;
    this.versions.set(name, version);
    this.releases.set(channelId, [name]);
    return name;
  }

  served(channelId: string): Version {
    const name = this.releases.get(channelId)?.[0];
    const v = name ? this.versions.get(name) : undefined;
    if (!v) throw new Error(`nothing released on ${channelId}`);
    return v;
  }

  call: FirebaseCall = async <T>(path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : {};
    const [route = "", query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    const reply = (v: unknown) => v as T;
    let m = route.match(/^sites\/s\/channels\/([^/]+)\/releases$/);
    if (m && method === "GET") {
      return reply({
        releases: (this.releases.get(m[1]!) ?? []).map((name) => ({ version: { name } })),
      });
    }
    if (m && method === "POST") {
      this.releases.get(m[1]!)?.unshift(params.get("versionName") ?? "");
      this.releaseBodies.push(body);
      return reply({});
    }
    if (route === "sites/s/releases" && method === "POST") {
      this.releases.get("live")?.unshift(params.get("versionName") ?? "");
      this.releaseBodies.push(body);
      return reply({});
    }
    if (route === "sites/s/versions" && method === "POST") {
      const name = `sites/${SITE}/versions/v${++this.seq}`;
      this.versions.set(name, { config: body.config, files: {}, status: "CREATED" });
      return reply({ name });
    }
    m = route.match(/^sites\/s\/versions\/([^/:]+):populateFiles$/);
    if (m) {
      const v = this.versions.get(`sites/${SITE}/versions/${m[1]}`);
      if (!v) throw new Error("populate on unknown version");
      v.files = body.files;
      return reply({ uploadRequiredHashes: this.missing });
    }
    m = route.match(/^sites\/s\/versions\/([^/:]+)\/files$/);
    if (m) {
      this.fileListCalls += 1;
      const v = this.versions.get(`sites/${SITE}/versions/${m[1]}`);
      if (!v) throw new Error("files of unknown version");
      const all = Object.entries(v.files).map(([p, hash]) => ({ path: p, hash }));
      // Two pages, so the sync must follow nextPageToken.
      return params.get("pageToken") === "p2"
        ? reply({ files: all.slice(1) })
        : reply({ files: all.slice(0, 1), nextPageToken: "p2" });
    }
    m = route.match(/^sites\/s\/versions\/([^/:]+)$/);
    if (m) {
      const v = this.versions.get(`sites/${SITE}/versions/${m[1]}`);
      if (!v) throw new Error("unknown version");
      if (method === "PATCH") {
        v.status = body.status;
        return reply({});
      }
      return reply({ config: v.config });
    }
    throw new Error(`unhandled ${method} ${path}`);
  };
}

const PRODUCTION: DeployTarget = {
  id: "00000000-0000-0000-0000-000000000002",
  name: "production",
  env: "production",
  outDir: "output/production",
  baseUrl: "",
  robotsDefault: "index",
  pageUrlStyle: "directory",
};

const LIVE_CONFIG = {
  headers: [{ glob: "**", headers: { "X-Content-Type-Options": "nosniff" } }],
  rewrites: [{ glob: "/api/**", run: { serviceId: "gw", region: "europe-west1" } }],
  redirects: [] as unknown[],
};

const ROWS: RedirectTableRow[] = [
  { fromPath: "/old", toPath: "/about", statusCode: 301 },
  // The live version serves /about: the live page wins.
  { fromPath: "/about", toPath: "/elsewhere", statusCode: 301 },
];

let fake: FakeHosting;

beforeEach(() => {
  _clearFirebaseFileListCache();
  fake = new FakeHosting();
  fake.seed("live", {
    config: LIVE_CONFIG,
    files: { "/index.html": "h1", "/about/index.html": "h2" },
    status: "FINALIZED",
  });
});

const sync = (rows = ROWS, channelId = "live") =>
  syncFirebaseRedirects({ call: fake.call, site: SITE, channelId, target: PRODUCTION, rows });

describe("syncFirebaseRedirects (#1157)", () => {
  it("releases the served files with only the redirects replaced", async () => {
    const result = await sync();
    expect(result).toMatchObject({ outcome: "applied", redirectCount: 1, shadowedCount: 1 });
    const live = fake.served("live");
    expect(live.status).toBe("FINALIZED");
    expect(live.files).toEqual({ "/index.html": "h1", "/about/index.html": "h2" });
    expect(live.config.headers).toEqual(LIVE_CONFIG.headers);
    expect(live.config.rewrites).toEqual(LIVE_CONFIG.rewrites);
    expect(live.config.redirects).toEqual([
      { regex: "^/old/?$", location: "/about/", statusCode: 301 },
    ]);
    expect(result.location).toBe(fake.releases.get("live")?.[0] ?? "");
    expect(fake.releaseBodies).toEqual([{ message: "Caelo: redirects updated (no build)" }]);
  });

  it("an unchanged plan creates no release; the file list is read once per version", async () => {
    await sync();
    const releasesAfterFirst = fake.releases.get("live")?.length;
    const again = await sync();
    expect(again.outcome).toBe("unchanged");
    expect(fake.releases.get("live")?.length).toBe(releasesAfterFirst);
    // Only the seeded version was listed (two pages); the version the first
    // sync released has the same files, so the second sync lists nothing.
    expect(fake.fileListCalls).toBe(2);
  });

  it("names redirects to pages the served version does not have", async () => {
    const result = await sync([{ fromPath: "/promo", toPath: "/draft", statusCode: 302 }]);
    expect(result.unservedTargets).toEqual([{ fromPath: "/promo", location: "/draft/" }]);
  });

  it("re-releases a staging preview on its own channel", async () => {
    fake.seed("runid-abc", { config: {}, files: { "/index.html": "s1" }, status: "FINALIZED" });
    const result = await syncFirebaseRedirects({
      call: fake.call,
      site: SITE,
      channelId: "runid-abc",
      target: { ...PRODUCTION, env: "staging", name: "staging" },
      rows: ROWS,
    });
    expect(result.outcome).toBe("applied");
    expect(fake.served("runid-abc").config.redirects).toHaveLength(2);
    expect(fake.served("live").config.redirects).toEqual([]);
  });

  it("fails loudly, releasing nothing, when Hosting wants bytes it cannot have", async () => {
    fake.missing = ["h2"];
    const before = fake.releases.get("live")?.[0];
    await expect(sync()).rejects.toThrow(/re-upload 1 file.*Nothing changed/);
    expect(fake.releases.get("live")?.[0]).toBe(before);
  });

  it("fails loudly when the channel serves nothing", async () => {
    fake.releases.set("live", []);
    await expect(sync()).rejects.toThrow(/serves no version.*Publish live first/);
  });

  it("a redirect loop fails loudly with the fix", async () => {
    await expect(
      sync([
        { fromPath: "/a", toPath: "/b", statusCode: 301 },
        { fromPath: "/b", toPath: "/a", statusCode: 301 },
      ]),
    ).rejects.toThrow(/form a loop/);
  });
});
