// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1461 — each serving path gives a static file its declared
 * Content-Type, also where the host would go by the file name.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeSiteHeaders,
  DEFAULT_SITE_SECURITY_POLICY,
  EMPTY_CSP_FACTS,
  formatStaticFilesManifest,
  SECURITY_HEADERS_BUILD_FILE,
} from "@caelo-cms/shared";
import { localBuildSource } from "../../quality/staged-origin.js";
import { staticFileHeaderEntries } from "../static-publisher-firebase.js";
import { selfHostedStaticPublisher } from "../static-publisher-self-hosted.js";

const AASA = {
  path: ".well-known/apple-app-site-association",
  contentType: "application/json; charset=utf-8",
};

describe("Firebase Hosting", () => {
  it("pins one exact path per file, with the dots escaped", () => {
    const [aasa, xml] = staticFileHeaderEntries([
      AASA,
      { path: "feed/a.b.xml", contentType: "text/xml; charset=utf-8" },
    ]);
    expect(aasa?.headers).toEqual({ "Content-Type": AASA.contentType });
    const re = new RegExp(xml?.regex ?? "");
    expect(re.test("/feed/a.b.xml")).toBe(true);
    expect(re.test("/feed/aXb.xml")).toBe(false);
    expect(re.test("/feed/a.b.xml/x")).toBe(false);
    expect(new RegExp(aasa?.regex ?? "").test(`/${AASA.path}`)).toBe(true);
  });
});

describe("self-hosted", () => {
  it("keeps the Content-Types in the snippet when a redirect sync rewrites it", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "caelo-static-files-"));
    const current = join(outputRoot, "out", "current");
    await mkdir(current, { recursive: true });
    await writeFile(join(current, "index.html"), "<html></html>");
    await writeFile(join(current, "_static-files.json"), formatStaticFilesManifest([AASA]));
    await selfHostedStaticPublisher.syncRedirects({
      target: { env: "production", outDir: "out" },
      rows: [{ fromPath: "/old", toPath: "/", statusCode: 301 }],
      servedRunId: "00000000-0000-0000-0000-000000000001",
      outputRoot,
    } as unknown as Parameters<typeof selfHostedStaticPublisher.syncRedirects>[0]);
    const snippet = await readFile(join(current, "_redirects.caddy"), "utf8");
    expect(snippet).toContain("/old");
    expect(snippet).toContain(`path /${AASA.path}`);
    expect(snippet).toContain(`Content-Type "${AASA.contentType}"`);
  });

  it("keeps the build's page headers in the snippet when a redirect sync rewrites it (#1454)", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "caelo-static-files-"));
    const current = join(outputRoot, "out", "current");
    await mkdir(current, { recursive: true });
    await writeFile(join(current, "index.html"), "<html></html>");
    await writeFile(
      join(current, SECURITY_HEADERS_BUILD_FILE),
      JSON.stringify(composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, EMPTY_CSP_FACTS)),
    );
    await selfHostedStaticPublisher.syncRedirects({
      target: { env: "production", outDir: "out" },
      rows: [{ fromPath: "/old", toPath: "/", statusCode: 301 }],
      servedRunId: "00000000-0000-0000-0000-000000000001",
      outputRoot,
    } as unknown as Parameters<typeof selfHostedStaticPublisher.syncRedirects>[0]);
    const snippet = await readFile(join(current, "_redirects.caddy"), "utf8");
    expect(snippet).toContain("/old");
    expect(snippet).toContain('header @caelo_documents X-Frame-Options "SAMEORIGIN"');
  });

  it("syncs a build from before static files, which has no sidecar", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "caelo-static-files-"));
    const current = join(outputRoot, "out", "current");
    await mkdir(current, { recursive: true });
    await writeFile(join(current, "index.html"), "<html></html>");
    const r = await selfHostedStaticPublisher.syncRedirects({
      target: { env: "production", outDir: "out" },
      rows: [],
      servedRunId: "00000000-0000-0000-0000-000000000001",
      outputRoot,
    } as unknown as Parameters<typeof selfHostedStaticPublisher.syncRedirects>[0]);
    expect(r.outcome).toBe("applied");
  });
});

describe("the staged build", () => {
  it("answers with the declared type for a path without an extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "caelo-static-files-"));
    await mkdir(join(dir, ".well-known"));
    await writeFile(join(dir, AASA.path), "{}");
    await writeFile(
      join(dir, "_content-types.json"),
      JSON.stringify({ [AASA.path]: AASA.contentType }),
    );
    const file = await localBuildSource(dir).read(AASA.path);
    expect(file?.contentType).toBe(AASA.contentType);
  });
});
