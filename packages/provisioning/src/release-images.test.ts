// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  cosignVerifyArgv,
  parseBearerChallenge,
  RELEASE_SIGNER_IDENTITY_REGEXP,
  releaseTag,
  resolveRegistryDigest,
} from "./release-images.js";

const DIGEST = `sha256:${"d".repeat(64)}`;

/** A fetch fake that records requests and answers from `handler`. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

describe("resolveRegistryDigest", () => {
  it("reads the digest straight from an anonymous registry (Artifact Registry)", async () => {
    const f = fakeFetch(
      () => new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } }),
    );
    const r = await resolveRegistryDigest(
      "europe-west1-docker.pkg.dev",
      "p/r/admin",
      "1.2.3",
      f.impl,
    );
    expect(r).toEqual({ ok: true, digest: DIGEST });
    expect(f.calls[0]?.url).toBe(
      "https://europe-west1-docker.pkg.dev/v2/p/r/admin/manifests/1.2.3",
    );
  });

  it("follows GHCR's Bearer challenge to an anonymous pull token", async () => {
    const f = fakeFetch((url, init) => {
      if (url.startsWith("https://ghcr.io/token")) {
        return Response.json({ token: "anon-token" });
      }
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== "Bearer anon-token") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:caelo-cms/admin:pull"',
          },
        });
      }
      return new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } });
    });
    const r = await resolveRegistryDigest("ghcr.io", "caelo-cms/admin", "0.10.43", f.impl);
    expect(r).toEqual({ ok: true, digest: DIGEST });
    const tokenUrl = new URL(f.calls[1]?.url ?? "");
    expect(tokenUrl.searchParams.get("scope")).toBe("repository:caelo-cms/admin:pull");
    expect(tokenUrl.searchParams.get("service")).toBe("ghcr.io");
  });

  it("reports a missing tag and a malformed digest header", async () => {
    const missing = fakeFetch(() => new Response(null, { status: 404, statusText: "Not Found" }));
    expect(
      await resolveRegistryDigest("ghcr.io", "caelo-cms/admin", "9.9.9", missing.impl),
    ).toEqual({ ok: false, reason: "HTTP 404 Not Found" });
    const bad = fakeFetch(
      () => new Response(null, { status: 200, headers: { "docker-content-digest": "md5:x" } }),
    );
    const r = await resolveRegistryDigest("ghcr.io", "caelo-cms/admin", "1", bad.impl);
    expect(r.ok).toBe(false);
  });
});

describe("parseBearerChallenge", () => {
  it("parses the parameters and rejects non-Bearer challenges", () => {
    expect(parseBearerChallenge('Bearer realm="https://r/t",service="s"')).toEqual({
      realm: "https://r/t",
      service: "s",
    });
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
    expect(parseBearerChallenge(null)).toBeNull();
  });
});

describe("releaseTag", () => {
  it("strips a leading v and maps channels", () => {
    expect(releaseTag({ version: "v0.10.43" })).toBe("0.10.43");
    expect(releaseTag({ version: "0.10.43" })).toBe("0.10.43");
    expect(releaseTag({ channel: "rc" })).toBe("rc");
    expect(releaseTag({})).toBe("latest");
  });
});

describe("cosignVerifyArgv", () => {
  it("pins the Caelo release workflow identity and GitHub's OIDC issuer", () => {
    const argv = cosignVerifyArgv("ghcr.io/caelo-cms/admin@x");
    expect(argv.slice(0, 3)).toEqual(["cosign", "verify", "ghcr.io/caelo-cms/admin@x"]);
    expect(argv).toContain(RELEASE_SIGNER_IDENTITY_REGEXP);
    expect(argv).toContain("https://token.actions.githubusercontent.com");
  });
});
