// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — the self-hosted publisher's plugin-data publish: it copies the
 * live archive to `builds/<runId>/`, overwrites only files the build has
 * (a shorter body leaves no tail of the old one), mirrors into `current/`,
 * and refuses a path the live build lacks without creating it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployTarget } from "@caelo-cms/static-generator";
import { selfHostedStaticPublisher } from "../static-publisher-self-hosted.js";

let root: string;
let target: DeployTarget;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "caelo-self-hosted-plugin-data-"));
  target = {
    id: "00000000-0000-0000-0000-000000000001",
    name: "production",
    env: "production",
    outDir: root,
    baseUrl: "https://example.com",
    robotsDefault: "index",
    isDefault: true,
  };
  const live = join(root, "builds", "live-build");
  await mkdir(join(live, "blog"), { recursive: true });
  await writeFile(join(live, "routing-manifest.json"), "{}");
  await writeFile(join(live, "blog", "index.html"), "<p>old thread with a long body</p>");
  await writeFile(join(live, "index.html"), "<p>home</p>");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function liveRef() {
  return {
    runId: "live-run",
    buildId: "live-build",
    location: null,
    localBuildDir: join(root, "builds", "live-build"),
  };
}

describe("selfHostedStaticPublisher.publishPluginData", () => {
  it("replaces only the named files, truncating a shorter body, and mirrors into current/", async () => {
    const summary = await selfHostedStaticPublisher.publishPluginData({
      target,
      live: liveRef(),
      runId: "data-run",
      files: new Map([["blog/index.html", Buffer.from("<p>new</p>")]]),
      pruneBuildIds: [],
    });
    expect(summary.destinationBuildId).toBe("data-run");
    expect(await readFile(join(root, "builds", "data-run", "blog", "index.html"), "utf8")).toBe(
      "<p>new</p>",
    );
    expect(await readFile(join(root, "current", "blog", "index.html"), "utf8")).toBe("<p>new</p>");
    expect(await readFile(join(root, "current", "index.html"), "utf8")).toBe("<p>home</p>");
    // The live archive itself stays as published.
    expect(await readFile(join(root, "builds", "live-build", "blog", "index.html"), "utf8")).toBe(
      "<p>old thread with a long body</p>",
    );
  });

  it("refuses a path the live build does not have, without creating it", async () => {
    await expect(
      selfHostedStaticPublisher.publishPluginData({
        target,
        live: liveRef(),
        runId: "data-run",
        files: new Map([["new/page.html", Buffer.from("x")]]),
        pruneBuildIds: [],
      }),
    ).rejects.toThrow(/not a file of the live build/);
    expect(existsSync(join(root, "builds", "data-run", "new", "page.html"))).toBe(false);
  });
});
