// SPDX-License-Identifier: MPL-2.0

/**
 * Regression (#1632): a build that outlasts its access token still
 * uploads. The Firebase build upload took one ADC token when it opened
 * and sent it with every `populateFiles` and upload for the whole build;
 * the metadata server hands out a cached token that can be minutes from
 * expiring, and a six-minute build failed with 401 ACCESS_TOKEN_EXPIRED.
 *
 * Publish live has the same shape: it lists every file of the staged
 * version, populates the copy and then waits on the lease fence
 * (`beforeRelease`), which can take minutes, before the release.
 *
 * The real publisher runs against an in-memory Hosting that refuses an
 * expired token the way Hosting does; google-auth-library's client is a
 * fake whose token the test expires mid-build.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeSiteHeaders,
  DEFAULT_SITE_SECURITY_POLICY,
  EMPTY_CSP_FACTS,
  SECURITY_HEADERS_BUILD_FILE,
  STATIC_FILES_MANIFEST_FILE,
} from "@caelo-cms/shared";
import type { DeployTarget } from "@caelo-cms/static-generator";
// Snapshot the real module so afterAll can undo the process-global
// mock.module below (issue #305 — same pattern as the promote test).
import * as realGoogleAuth from "google-auth-library";
import { writeAssetReferences } from "../../__tests__/fixtures/asset-references.js";

const realGoogleAuthExports = { ...realGoogleAuth };

/** What google-auth-library's client hands out now, and how often it was asked. */
const adc = { token: "token-1", asked: 0, gate: null as Promise<void> | null };

mock.module("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return {
        getAccessToken: async () => {
          adc.asked += 1;
          if (adc.gate) await adc.gate;
          return { token: adc.token };
        },
      };
    }
  },
}));

afterAll(() => {
  mock.module("google-auth-library", () => realGoogleAuthExports);
});

const API = "https://firebasehosting.googleapis.com/v1beta1/";
const UPLOAD = "https://upload.test/";
const SITE = "test-site";

/** Hosting as far as a build upload uses it, refusing expired tokens. */
class TokenCheckingHosting {
  readonly expired = new Set<string>();
  /** The token of every accepted request, in order, by kind. */
  readonly seen: { kind: string; token: string }[] = [];
  #seq = 0;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    if (this.expired.has(token)) {
      return new Response(
        JSON.stringify({
          error: {
            code: 401,
            status: "UNAUTHENTICATED",
            details: [{ reason: "ACCESS_TOKEN_EXPIRED" }],
          },
        }),
        { status: 401 },
      );
    }
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const method = init?.method ?? "GET";
    if (url.startsWith(UPLOAD)) {
      await new Response(init?.body ?? null).arrayBuffer();
      this.seen.push({ kind: "upload", token });
      return json({});
    }
    if (!url.startsWith(API)) throw new Error(`unexpected fetch ${url}`);
    const route = url.slice(API.length).split("?")[0] ?? "";
    if (method === "POST" && route === `sites/${SITE}/versions`) {
      this.seen.push({ kind: "create", token });
      return json({ name: `sites/${SITE}/versions/v${++this.#seq}` });
    }
    if (route.endsWith(":populateFiles")) {
      this.seen.push({ kind: "populate", token });
      const files = JSON.parse(String(init?.body)).files as Record<string, string>;
      return json({
        uploadRequiredHashes: [...new Set(Object.values(files))],
        uploadUrl: `${UPLOAD}v`,
      });
    }
    if (method === "PATCH") {
      this.seen.push({ kind: "finalize", token });
      return json({});
    }
    if (method === "POST" && route === `sites/${SITE}/releases`) {
      this.seen.push({ kind: "release", token });
      return json({});
    }
    if (method === "GET" && /^sites\/[^/]+\/versions\/[^/]+\/files$/.test(route)) {
      this.seen.push({ kind: "list", token });
      return json({ files: [{ path: "/index.html", hash: "a".repeat(64), status: "ACTIVE" }] });
    }
    if (method === "GET" && /^sites\/[^/]+\/versions\/[^/]+$/.test(route)) {
      this.seen.push({ kind: "config", token });
      return json({ config: {} });
    }
    throw new Error(`unhandled ${method} ${url}`);
  };
}

const PRODUCTION: DeployTarget = {
  id: "00000000-0000-0000-0000-000000000002",
  name: "production",
  env: "production",
  outDir: "output/production",
  baseUrl: "",
  robotsDefault: "index",
  isDefault: true,
};

let hosting: TokenCheckingHosting;
let buildDir: string;
const realFetch = globalThis.fetch;
const ENV_KEYS = ["CAELO_FIREBASE_SITE", "CAELO_GATEWAY_SERVICE", "CAELO_GATEWAY_REGION"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  hosting = new TokenCheckingHosting();
  globalThis.fetch = hosting.fetch as typeof fetch;
  adc.token = "token-1";
  adc.asked = 0;
  adc.gate = null;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CAELO_FIREBASE_SITE = SITE;
  process.env.CAELO_GATEWAY_SERVICE = "gateway";
  process.env.CAELO_GATEWAY_REGION = "europe-west1";
  buildDir = await mkdtemp(join(tmpdir(), "caelo-fb-token-"));
  await writeAssetReferences(buildDir);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(buildDir, { recursive: true, force: true });
});

const page = (i: number) => ({
  relPath: `p${i}/index.html`,
  body: Buffer.from(`<html><body>page ${i}</body></html>`),
});

describe("Firebase build upload — #1632 token lifetime", () => {
  it("a build that outlasts its token asks for a new one and finishes", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    const upload = await firebaseHostingPublisher.openBuildUpload({
      target: PRODUCTION,
      servedStagingLocation: null,
    });
    // The first files go out while the first token is valid (one batch of 250).
    for (let i = 0; i < 260; i++) await upload.put(page(i));
    expect(hosting.seen.some((s) => s.kind === "populate" && s.token === "token-1")).toBe(true);

    // Minutes later the token has expired; the client hands out a new one.
    hosting.expired.add("token-1");
    adc.token = "token-2";
    for (let i = 260; i < 400; i++) await upload.put(page(i));
    await upload.put({ relPath: "_redirects", body: Buffer.from("# generated\n") });
    await upload.put({
      relPath: STATIC_FILES_MANIFEST_FILE,
      body: Buffer.from(JSON.stringify({ version: 1, files: [] })),
    });
    await upload.put({
      relPath: SECURITY_HEADERS_BUILD_FILE,
      body: Buffer.from(
        JSON.stringify(composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, EMPTY_CSP_FACTS)),
      ),
    });
    const summary = await firebaseHostingPublisher.publishStaging({
      buildDir,
      runId: "run-long",
      target: PRODUCTION,
      upload,
      servedStagingLocation: null,
    });
    expect(summary.location).toBe(`sites/${SITE}/versions/v1`);
    const after = hosting.seen.slice(hosting.seen.findIndex((s) => s.token === "token-2"));
    expect(after.map((s) => s.kind)).toContain("populate");
    expect(after.map((s) => s.kind)).toContain("upload");
    expect(after.at(-1)).toEqual({ kind: "finalize", token: "token-2" });
    expect(after.every((s) => s.token === "token-2")).toBe(true);
  });

  it("Publish live releases with a fresh token after a long wait at the lease fence", async () => {
    const { firebaseHostingPublisher } = await import("../static-publisher-firebase.js");
    const summary = await firebaseHostingPublisher.promoteToProduction({
      sourceRunId: "run-staged",
      sourceBuildDir: buildDir,
      sourceLocation: `sites/${SITE}/versions/staged`,
      fromTarget: PRODUCTION,
      toTarget: PRODUCTION,
      siteBaseUrl: "https://example.test",
      // The fence waits for its leases; meanwhile the first token expires.
      beforeRelease: async () => {
        hosting.expired.add("token-1");
        adc.token = "token-2";
      },
    });
    expect(summary.location).toBe(`sites/${SITE}/versions/v1`);
    expect(hosting.seen.map((s) => s.kind)).toEqual([
      "config",
      "list",
      "create",
      "populate",
      "upload",
      "finalize",
      "release",
    ]);
    expect(hosting.seen.at(-1)).toEqual({ kind: "release", token: "token-2" });
  });

  it("requests asked for at once share one token fetch", async () => {
    const { googleAccessToken } = await import("../static-publisher-firebase.js");
    const token = await googleAccessToken();
    let open: () => void = () => {};
    adc.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const asked = Array.from({ length: 50 }, () => token());
    open();
    expect(await Promise.all(asked)).toEqual(Array.from({ length: 50 }, () => "token-1"));
    expect(adc.asked).toBe(1);
    // Asked again later, the client is asked again (and refreshes when due).
    adc.gate = null;
    adc.token = "token-2";
    expect(await token()).toBe("token-2");
    expect(adc.asked).toBe(2);
  });
});
