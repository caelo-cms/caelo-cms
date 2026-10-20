// SPDX-License-Identifier: MPL-2.0

/**
 * The release check's pure parts: the "Check now" cooldown, how GitHub's
 * answers (release, rate limit, error, no answer) become an outcome, and
 * the route prediction's edges (the manifest comparison itself is
 * release-facts.test.ts and the check-now integration test). GitHub
 * is replaced at the fetcher boundary; nothing here touches a database.
 */

import { describe, expect, it } from "bun:test";
import { CAELO_VERSION } from "@caelo-cms/shared";
import {
  fetchLatestRelease,
  predictReleaseRoute,
  RELEASE_CHECK_COOLDOWN_MS,
  type ReleaseFetch,
  releaseCheckCooldownMessage,
  releaseCheckCooldownMs,
} from "./release-check.js";

const NOW = new Date("2026-10-14T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("releaseCheckCooldownMs", () => {
  it("lets a check run when there was none", () => {
    expect(releaseCheckCooldownMs(null, NOW)).toBe(0);
  });

  it("refuses within a minute of the last check, with the time left", () => {
    expect(releaseCheckCooldownMs(ago(0), NOW)).toBe(RELEASE_CHECK_COOLDOWN_MS);
    expect(releaseCheckCooldownMs(ago(15_000), NOW)).toBe(45_000);
    expect(releaseCheckCooldownMs(ago(59_999), NOW)).toBe(1);
  });

  it("lets a check run once the minute is over", () => {
    expect(releaseCheckCooldownMs(ago(60_000), NOW)).toBe(0);
    expect(releaseCheckCooldownMs(ago(40 * 60_000), NOW)).toBe(0);
  });

  it("waits a full minute when the last check lies in the future (clock skew)", () => {
    expect(releaseCheckCooldownMs(ago(-5_000), NOW)).toBe(RELEASE_CHECK_COOLDOWN_MS);
  });
});

describe("releaseCheckCooldownMessage", () => {
  it("names the seconds left, rounded up", () => {
    expect(releaseCheckCooldownMessage(44_100)).toContain("Try again in 45 seconds.");
    expect(releaseCheckCooldownMessage(400)).toContain("Try again in 1 second.");
  });
});

function answering(res: Response | Error): ReleaseFetch {
  return async () => {
    if (res instanceof Error) throw res;
    return res;
  };
}

describe("fetchLatestRelease", () => {
  it("reads the release GitHub names", async () => {
    const o = await fetchLatestRelease({
      fetchImpl: answering(
        Response.json({
          tag_name: "v0.10.49",
          html_url: "https://github.com/caelo-cms/caelo-cms/releases/tag/v0.10.49",
          body: "## Fixes",
          published_at: "2026-10-14T08:00:00Z",
        }),
      ),
    });
    expect(o).toEqual({
      reached: true,
      latestVersion: "0.10.49",
      releaseUrl: "https://github.com/caelo-cms/caelo-cms/releases/tag/v0.10.49",
      releaseNotes: "## Fixes",
      publishedAt: "2026-10-14T08:00:00Z",
    });
  });

  it("caps the notes", async () => {
    const o = await fetchLatestRelease({
      fetchImpl: answering(Response.json({ tag_name: "v1.0.0", body: "x".repeat(30_000) })),
    });
    expect(o.reached && o.releaseNotes?.length).toBe(20_000);
  });

  it("says when GitHub is rate-limiting this server", async () => {
    const o = await fetchLatestRelease({
      fetchImpl: answering(
        new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791993600" },
        }),
      ),
    });
    expect(o.reached).toBe(false);
    if (o.reached) return;
    expect(o.problem).toBe("rate_limited");
    expect(o.message).toContain("until ");
    expect(o.message).toContain("UTC");
  });

  it("treats 429 as a rate limit too", async () => {
    const o = await fetchLatestRelease({ fetchImpl: answering(new Response("", { status: 429 })) });
    expect(!o.reached && o.problem).toBe("rate_limited");
  });

  it("reports another HTTP error with its status", async () => {
    const o = await fetchLatestRelease({ fetchImpl: answering(new Response("", { status: 502 })) });
    expect(o.reached).toBe(false);
    if (o.reached) return;
    expect(o.problem).toBe("http_error");
    expect(o.message).toContain("HTTP 502");
  });

  it("reports an unreachable GitHub and a timeout", async () => {
    const down = await fetchLatestRelease({ fetchImpl: answering(new TypeError("fetch failed")) });
    expect(!down.reached && down.problem).toBe("unreachable");
    const timeout = new Error("The operation timed out.");
    timeout.name = "TimeoutError";
    const slow = await fetchLatestRelease({ fetchImpl: answering(timeout) });
    expect(slow.reached).toBe(false);
    if (slow.reached) return;
    expect(slow.message).toContain("5 seconds");
  });

  it("rejects an answer without a release name or that is not JSON", async () => {
    const empty = await fetchLatestRelease({ fetchImpl: answering(Response.json({})) });
    expect(!empty.reached && empty.problem).toBe("malformed");
    const garbage = await fetchLatestRelease({
      fetchImpl: answering(new Response("<html>", { status: 200 })),
    });
    expect(!garbage.reached && garbage.problem).toBe("malformed");
  });
});

describe("predictReleaseRoute (#817)", () => {
  const found = {
    reached: true as const,
    latestVersion: "99.0.0",
    releaseUrl: null,
    releaseNotes: null,
    publishedAt: null,
  };
  let reads = 0;
  const opts = {
    provider: "gcp",
    readManifest: async (version: string) => {
      reads += 1;
      return { ok: false as const, message: `no manifest for v${version}` };
    },
  };

  it("passes a failed check through untouched", async () => {
    const failed = { reached: false as const, problem: "unreachable" as const, message: "x" };
    expect(await predictReleaseRoute(failed, opts)).toEqual(failed);
  });

  it("routes nothing when the release is not newer than what runs", async () => {
    reads = 0;
    const same = await predictReleaseRoute({ ...found, latestVersion: CAELO_VERSION }, opts);
    expect(same).toEqual({ ...found, latestVersion: CAELO_VERSION, infraChange: null });
    expect(reads).toBe(0);
  });

  it("leaves the route unknown when a manifest cannot be read", async () => {
    expect(await predictReleaseRoute(found, opts)).toEqual({ ...found, infraChange: null });
  });
});
