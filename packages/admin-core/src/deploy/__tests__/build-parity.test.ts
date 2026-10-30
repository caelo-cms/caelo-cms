// SPDX-License-Identifier: MPL-2.0

/**
 * #650 — the staging ↔ live parity guard: a live rebuild may differ from
 * the staged build only in the host.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isParityRefusal, RESTAGE_NEXT_STEP } from "@caelo-cms/shared";
import { type AssetReference, ParityRecorder } from "@caelo-cms/static-generator";
import {
  buildManifestOf,
  compareBuildManifests,
  hostNormaliser,
  manifestsMatch,
  parityRefusal,
} from "../build-parity.js";

const STAGING = "https://staging.example.com";
const LIVE = "https://www.example.com";
const SAME_VERSION = { stagedCaeloVersion: "0.10.52", runningCaeloVersion: "0.10.52" } as const;

describe("hostNormaliser", () => {
  const n = hostNormaliser(STAGING, LIVE);

  it("swaps the origin in canonical, og:url, hreflang, sitemap and robots", () => {
    expect(n(`<link rel="canonical" href="${STAGING}/a/">`)).toBe(
      `<link rel="canonical" href="${LIVE}/a/">`,
    );
    expect(n(`<meta property="og:url" content="${STAGING}/">`)).toBe(
      `<meta property="og:url" content="${LIVE}/">`,
    );
    expect(n(`<loc>${STAGING}/de/</loc>`)).toBe(`<loc>${LIVE}/de/</loc>`);
    expect(n(`Sitemap: ${STAGING}/sitemap.xml`)).toBe(`Sitemap: ${LIVE}/sitemap.xml`);
  });

  it("swaps the bare host inside escaped or encoded URLs", () => {
    expect(n('{"url":"https:\\/\\/staging.example.com\\/a"}')).toBe(
      '{"url":"https:\\/\\/www.example.com\\/a"}',
    );
    expect(n("share?u=https%3A%2F%2Fstaging.example.com%2Fa")).toBe(
      "share?u=https%3A%2F%2Fwww.example.com%2Fa",
    );
  });

  it("leaves live-host links authored in content alone", () => {
    expect(n(`<a href="${LIVE}/x">`)).toBe(`<a href="${LIVE}/x">`);
  });

  it("works when the live host is a suffix of the staging host", () => {
    const apex = hostNormaliser("https://staging.example.com", "https://example.com");
    expect(apex("https://staging.example.com/a https://example.com/b")).toBe(
      "https://example.com/a https://example.com/b",
    );
  });

  it("never reprocesses its own output when the staging host is inside the live host (codex review on #652)", () => {
    const apexStaging = hostNormaliser("https://example.com", "https://www.example.com");
    expect(apexStaging('<a href="https://example.com/a">example.com</a>')).toBe(
      '<a href="https://www.example.com/a">www.example.com</a>',
    );
    // A longer name that merely ends in the staging host is not the host.
    expect(apexStaging("mail.example.com and cdn-example.com")).toBe(
      "mail.example.com and cdn-example.com",
    );
  });

  it("refuses identical hosts — there would be nothing to tell apart", () => {
    expect(() => hostNormaliser(LIVE, `${LIVE}/`)).toThrow("its own host");
  });
});

describe("compareBuildManifests / parityRefusal", () => {
  it("matches identical manifests", () => {
    const diff = compareBuildManifests({ "a.html": "1" }, { "a.html": "1" });
    expect(manifestsMatch(diff)).toBe(true);
    expect(parityRefusal(diff, { stagingRunId: "run", ...SAME_VERSION })).toBeNull();
  });

  it("reports added, removed and changed files, sorted", () => {
    const diff = compareBuildManifests(
      { "b.html": "1", "a.html": "1", "gone.html": "1" },
      { "a.html": "2", "b.html": "1", "new.html": "1" },
    );
    expect(diff).toEqual({ added: ["new.html"], removed: ["gone.html"], changed: ["a.html"] });
    const msg = parityRefusal(diff, { stagingRunId: "run-7", ...SAME_VERSION });
    expect(msg).toContain("run-7");
    expect(msg).toContain("1 changed (a.html)");
    expect(msg).toContain("only in the live build (new.html)");
    expect(msg).toContain("missing from the live build (gone.html)");
    expect(msg).toContain("Stage again");
  });

  it("lists only the first files of a long diff", () => {
    const live = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}.html`, "x"]));
    const msg = parityRefusal(compareBuildManifests({}, live), {
      stagingRunId: "r",
      ...SAME_VERSION,
      limit: 3,
    });
    expect(msg).toContain("30 only in the live build (p0.html, p1.html, p10.html, …)");
  });

  // #834 regression — after an upgrade between Stage and Publish live the
  // refusal blamed site edits; the cause was the new Caelo version.
  const fontDiff = compareBuildManifests(
    { "about/index.html": "a", "_assets/fonts/pinned/inter.latin.9d9051c79679.woff2": "f" },
    { "about/index.html": "b", "_assets/fonts/pinned/inter.wght.latin.3075c73f4eb5.woff2": "f" },
  );

  it("names the Caelo upgrade first when the staged build was made by another version", () => {
    const msg = parityRefusal(fontDiff, {
      stagingRunId: "run-up",
      stagedCaeloVersion: "0.10.51",
      runningCaeloVersion: "0.10.52",
    });
    expect(msg).toStartWith(
      "Publish live stopped: Caelo was updated from 0.10.51 to 0.10.52 since this Stage, and the new version renders the site differently",
    );
    expect(msg).not.toContain("another edit was merged");
    expect(msg).toContain("about/index.html");
    expect(msg).toContain(RESTAGE_NEXT_STEP);
  });

  it("blames a site change only when the versions match", () => {
    const msg = parityRefusal(fontDiff, { stagingRunId: "run-same", ...SAME_VERSION });
    expect(msg).not.toContain("Caelo was updated");
    expect(msg).toContain("The site changed after that Stage");
  });

  it("says the version is unknown for a build staged before versions were recorded", () => {
    const msg = parityRefusal(fontDiff, {
      stagingRunId: "run-old",
      stagedCaeloVersion: null,
      runningCaeloVersion: "0.10.52",
    });
    expect(msg).toContain("The Caelo version that made this Stage is unknown");
    expect(msg).toContain("a Caelo update to 0.10.52");
    expect(msg).not.toContain("Caelo was updated from");
    expect(msg).toContain(RESTAGE_NEXT_STEP);
  });

  it("every refusal is recognisable as one and points at the Stage again button (#835)", () => {
    expect(RESTAGE_NEXT_STEP).toContain('"Stage again" button next to Publish live');
    for (const stagedCaeloVersion of ["0.10.51", "0.10.52", null]) {
      const msg = parityRefusal(fontDiff, {
        stagingRunId: "r",
        stagedCaeloVersion,
        runningCaeloVersion: "0.10.52",
      });
      expect(isParityRefusal(msg ?? "")).toBe(true);
      expect(msg).toEndWith(RESTAGE_NEXT_STEP);
    }
  });
});

describe("buildManifestOf on real build trees (#1271: digests taken by the generator)", () => {
  let stagingDir: string;
  let liveDir: string;
  const LOGO = new Uint8Array([0, 1, 2, 255, 254]);

  async function put(dir: string, rel: string, body: string | Uint8Array): Promise<void> {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }

  /** A referenced media file, as the build lists it (never in the build). */
  function logo(bytes: Uint8Array): AssetReference {
    return {
      path: "_assets/logo.0123456789abcdef.png",
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      gzipSha256: "0".repeat(64),
      gzipSize: 1,
      digestProfile: "p",
      source: { kind: "media", storageKey: "abc/orig.png" },
    };
  }

  /**
   * A build as the generator writes it, rendered for `origin`: pages
   * digested as written, sitemap written by another pass (read at the end),
   * the logo referenced by its stored hash.
   */
  async function build(
    dir: string,
    origin: string,
    env: string,
    opts: { about?: string; extra?: string; logo?: Uint8Array } = {},
  ): Promise<void> {
    const parity = new ParityRecorder(env === "staging" ? hostNormaliser(STAGING, LIVE) : null);
    const pages: [string, string][] = [
      [
        "index.html",
        `<html><head><link rel="canonical" href="${origin}/"><meta property="og:url" content="${origin}/"></head><body>Hallo</body></html>`,
      ],
      ["about/index.html", opts.about ?? `<a href="${origin}/about/">x</a>`],
      ...(opts.extra ? ([["new/index.html", opts.extra]] as [string, string][]) : []),
    ];
    for (const [rel, html] of pages) {
      await put(dir, rel, html);
      parity.record(rel, html);
    }
    await put(dir, "sitemap.xml", `<urlset><url><loc>${origin}/</loc></url></urlset>`);
    await put(
      dir,
      "robots.txt",
      env === "staging" ? "User-agent: *\nDisallow: /\n" : `Sitemap: ${origin}/sitemap.xml\n`,
    );
    await put(dir, "routing-manifest.json", JSON.stringify({ env, runId: `${env}-run` }));
    await parity.finish({
      buildDir: dir,
      assets: [logo(opts.logo ?? LOGO)],
      unrecorded: ["sitemap.xml", "robots.txt", "routing-manifest.json"],
    });
  }

  beforeEach(async () => {
    stagingDir = await mkdtemp(join(tmpdir(), "caelo-parity-s-"));
    liveDir = await mkdtemp(join(tmpdir(), "caelo-parity-l-"));
    await build(stagingDir, STAGING, "staging");
  });
  afterEach(async () => {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(liveDir, { recursive: true, force: true });
  });

  it("a host-only difference passes; per-build files are ignored; media count by stored hash", async () => {
    await build(liveDir, LIVE, "production");
    const staged = await buildManifestOf(stagingDir, "normalised");
    const live = await buildManifestOf(liveDir, "plain");
    expect(Object.keys(staged)).not.toContain("robots.txt");
    expect(Object.keys(staged)).not.toContain("routing-manifest.json");
    expect(Object.keys(staged)).toContain("_assets/logo.0123456789abcdef.png");
    expect(Object.keys(staged)).toContain("sitemap.xml");
    expect(manifestsMatch(compareBuildManifests(staged, live))).toBe(true);
  });

  it("without normalising, the same trees differ (the host is everywhere)", async () => {
    await build(liveDir, LIVE, "production");
    const diff = compareBuildManifests(
      await buildManifestOf(stagingDir, "plain"),
      await buildManifestOf(liveDir, "plain"),
    );
    expect(diff.changed).toEqual(["about/index.html", "index.html", "sitemap.xml"]);
  });

  it("a content change after the Stage blocks the publish and names the file", async () => {
    await build(liveDir, LIVE, "production", {
      about: `<a href="${LIVE}/about/">changed</a>`,
      extra: "new page",
    });
    const diff = compareBuildManifests(
      await buildManifestOf(stagingDir, "normalised"),
      await buildManifestOf(liveDir, "plain"),
    );
    expect(diff).toEqual({ added: ["new/index.html"], removed: [], changed: ["about/index.html"] });
  });

  it("a changed referenced media file is caught too (by its stored hash)", async () => {
    await build(liveDir, LIVE, "production", { logo: new Uint8Array([0, 1, 2, 255, 253]) });
    const diff = compareBuildManifests(
      await buildManifestOf(stagingDir, "normalised"),
      await buildManifestOf(liveDir, "plain"),
    );
    expect(diff.changed).toEqual(["_assets/logo.0123456789abcdef.png"]);
  });

  it("the stored hash of a referenced file equals the hash of its bytes", async () => {
    // What a build that still held the bytes would have recorded.
    const legacy = createHash("sha256").update(LOGO).digest("base64url").slice(0, 32);
    expect((await buildManifestOf(stagingDir, "plain"))["_assets/logo.0123456789abcdef.png"]).toBe(
      legacy,
    );
  });

  it("refuses a normalised manifest for a build rendered without a staging host", async () => {
    await build(liveDir, LIVE, "production");
    await expect(buildManifestOf(liveDir, "normalised")).rejects.toThrow("no host-normalised");
  });
});
