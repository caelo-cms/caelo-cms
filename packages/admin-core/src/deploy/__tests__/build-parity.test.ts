// SPDX-License-Identifier: MPL-2.0

/**
 * #650 — the staging ↔ live parity guard: a live rebuild may differ from
 * the staged build only in the host.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildManifestOf,
  compareBuildManifests,
  hostNormaliser,
  manifestsMatch,
  parityRefusal,
} from "../build-parity.js";

const STAGING = "https://staging.example.com";
const LIVE = "https://www.example.com";

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
    expect(parityRefusal(diff, { stagingRunId: "run" })).toBeNull();
  });

  it("reports added, removed and changed files, sorted", () => {
    const diff = compareBuildManifests(
      { "b.html": "1", "a.html": "1", "gone.html": "1" },
      { "a.html": "2", "b.html": "1", "new.html": "1" },
    );
    expect(diff).toEqual({ added: ["new.html"], removed: ["gone.html"], changed: ["a.html"] });
    const msg = parityRefusal(diff, { stagingRunId: "run-7" });
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
      limit: 3,
    });
    expect(msg).toContain("30 only in the live build (p0.html, p1.html, p10.html, …)");
  });
});

describe("buildManifestOf on real build trees", () => {
  let stagingDir: string;
  let liveDir: string;

  async function put(dir: string, rel: string, body: string | Uint8Array): Promise<void> {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }

  /** The generator's ab-routing.json shape: one experiment, control at `controlWeight`. */
  function abRouting(manifestVersion: string, controlWeight: number): string {
    return JSON.stringify(
      {
        manifestVersion,
        experiments: [
          {
            pageSlug: "/about",
            experimentId: "00000000-0000-4000-8000-000000000001",
            variants: [
              { label: "control", weight: controlWeight, path: "/about" },
              { label: "b", weight: 100 - controlWeight, path: "/_variants/hero__b/about" },
            ],
          },
        ],
      },
      null,
      2,
    );
  }

  /** A build as the generator writes it, rendered for `origin`. */
  async function build(dir: string, origin: string, env: string): Promise<void> {
    await put(
      dir,
      "index.html",
      `<html><head><link rel="canonical" href="${origin}/"><meta property="og:url" content="${origin}/"></head><body>Hallo</body></html>`,
    );
    await put(dir, "about/index.html", `<a href="${origin}/about/">x</a>`);
    await put(dir, "sitemap.xml", `<urlset><url><loc>${origin}/</loc></url></urlset>`);
    await put(dir, "_assets/logo.png", new Uint8Array([0, 1, 2, 255, 254]));
    await put(
      dir,
      "robots.txt",
      env === "staging" ? "User-agent: *\nDisallow: /\n" : `Sitemap: ${origin}/sitemap.xml\n`,
    );
    await put(dir, "routing-manifest.json", JSON.stringify({ env, runId: `${env}-run` }));
    await put(dir, "ab-routing.json", abRouting(`${env}-run`, 50));
  }

  beforeEach(async () => {
    stagingDir = await mkdtemp(join(tmpdir(), "caelo-parity-s-"));
    liveDir = await mkdtemp(join(tmpdir(), "caelo-parity-l-"));
    await build(stagingDir, STAGING, "staging");
    await build(liveDir, LIVE, "production");
  });
  afterEach(async () => {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(liveDir, { recursive: true, force: true });
  });

  it("a host-only difference passes; per-build files are ignored", async () => {
    const staged = await buildManifestOf(stagingDir, hostNormaliser(STAGING, LIVE));
    const live = await buildManifestOf(liveDir);
    expect(Object.keys(staged)).not.toContain("robots.txt");
    expect(Object.keys(staged)).not.toContain("routing-manifest.json");
    // The A/B routing is compared; only its per-build manifestVersion is not.
    expect(Object.keys(staged)).toContain("ab-routing.json");
    expect(Object.keys(staged)).toContain("_assets/logo.png");
    expect(manifestsMatch(compareBuildManifests(staged, live))).toBe(true);
  });

  it("without normalising, the same trees differ (the host is everywhere)", async () => {
    const diff = compareBuildManifests(
      await buildManifestOf(stagingDir),
      await buildManifestOf(liveDir),
    );
    expect(diff.changed).toEqual(["about/index.html", "index.html", "sitemap.xml"]);
  });

  it("a content change after the Stage blocks the publish and names the file", async () => {
    await put(liveDir, "about/index.html", `<a href="${LIVE}/about/">changed</a>`);
    await put(liveDir, "new/index.html", "new page");
    const diff = compareBuildManifests(
      await buildManifestOf(stagingDir, hostNormaliser(STAGING, LIVE)),
      await buildManifestOf(liveDir),
    );
    expect(diff).toEqual({ added: ["new/index.html"], removed: [], changed: ["about/index.html"] });
  });

  it("a changed binary asset is caught too", async () => {
    await put(liveDir, "_assets/logo.png", new Uint8Array([0, 1, 2, 255, 253]));
    const diff = compareBuildManifests(
      await buildManifestOf(stagingDir, hostNormaliser(STAGING, LIVE)),
      await buildManifestOf(liveDir),
    );
    expect(diff.changed).toEqual(["_assets/logo.png"]);
  });

  it("an A/B routing change after the Stage blocks the publish (Codex review on #652)", async () => {
    // Weights moved 50/50 → 90/10 after the Stage; the variant pages are
    // byte-identical, so ab-routing.json is the only difference.
    await put(liveDir, "ab-routing.json", abRouting("production-run", 90));
    const diff = compareBuildManifests(
      await buildManifestOf(stagingDir, hostNormaliser(STAGING, LIVE)),
      await buildManifestOf(liveDir),
    );
    expect(diff).toEqual({ added: [], removed: [], changed: ["ab-routing.json"] });
  });

  it("refuses an ab-routing.json that is not the generator's JSON instead of skipping it", async () => {
    await put(liveDir, "ab-routing.json", "not json");
    await expect(buildManifestOf(liveDir)).rejects.toThrow(/ab-routing.json.*not valid JSON/);
  });
});
