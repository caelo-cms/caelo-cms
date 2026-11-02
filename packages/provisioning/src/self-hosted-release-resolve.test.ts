// SPDX-License-Identifier: MPL-2.0

/**
 * #1328 — resolving a self-hosted release: the MCP-Auth-Proxy image is
 * optional only for a release that has none (the registry says its tag does
 * not exist), never because the registry could not be asked.
 */

import { describe, expect, it } from "bun:test";
import { type HostRunner, resolveVerifiedRelease } from "./self-hosted-release.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;

/** GHCR with a token challenge; `proxy` decides the MCP-Auth-Proxy tag's answer. */
function ghcr(proxy: "present" | 404 | 503): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://ghcr.io/token")) return Response.json({ token: "t" });
    if (!new Headers(init?.headers).get("authorization")) {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
      });
    }
    if (url.includes("/caelo-cms/mcp-auth-proxy/")) {
      if (proxy !== "present") return new Response(null, { status: proxy });
      return new Response(null, { status: 200, headers: { "docker-content-digest": D("c") } });
    }
    const digest = url.includes("/caelo-cms/admin/") ? D("a") : D("b");
    return new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
  }) as typeof fetch;
}

function runner(): HostRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(argv) {
      calls.push(argv.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

describe("resolveVerifiedRelease (#1328)", () => {
  it("resolves and verifies all three images of a release that ships the proxy", async () => {
    const r = runner();
    const res = await resolveVerifiedRelease("0.12.0", { runner: r, fetchImpl: ghcr("present") });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.images["mcp-auth-proxy"]).toBe(`ghcr.io/caelo-cms/mcp-auth-proxy@${D("c")}`);
    expect(r.calls.filter((c) => c.startsWith("cosign verify"))).toHaveLength(3);
  });

  it("a release from before the proxy (its tag does not exist) resolves without it", async () => {
    const r = runner();
    const res = await resolveVerifiedRelease("0.11.0", { runner: r, fetchImpl: ghcr(404) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect("mcp-auth-proxy" in res.images).toBe(false);
    expect(res.images.admin).toBe(`ghcr.io/caelo-cms/admin@${D("a")}`);
    expect(r.calls.filter((c) => c.startsWith("cosign verify"))).toHaveLength(2);
  });

  it("a registry outage on the proxy tag fails instead of installing without it", async () => {
    const res = await resolveVerifiedRelease("0.12.0", { runner: runner(), fetchImpl: ghcr(503) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("mcp-auth-proxy:0.12.0");
  });
});
