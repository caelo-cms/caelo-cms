// SPDX-License-Identifier: MPL-2.0

/**
 * #587 — the self-hosted deploy reloads Caddy through the admin API's unix
 * socket so the build's redirect snippet takes effect. A stand-in admin API
 * on a real unix socket checks the request; the real Caddy round trip is
 * packages/provisioning/src/caddy-redirects.docker.test.ts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caddyReloadTargetFromEnv, reloadCaddy, reloadCaddyIfConfigured } from "../caddy-reload.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  // Short path: unix socket paths are limited to ~104 bytes on macOS.
  const d = mkdtempSync(join(tmpdir(), "c587-"));
  dirs.push(d);
  return d;
}

describe("caddyReloadTargetFromEnv", () => {
  it("uses the socket + Caddyfile the Compose file sets", () => {
    expect(
      caddyReloadTargetFromEnv({
        CAELO_CADDY_ADMIN_SOCKET: "/run/caddy-admin/admin.sock",
        CAELO_CADDYFILE: "/etc/caelo/Caddyfile",
      }),
    ).toEqual({
      endpoint: { kind: "socket", path: "/run/caddy-admin/admin.sock" },
      caddyfilePath: "/etc/caelo/Caddyfile",
    });
  });

  it("has nothing to reload in local development (Caddy runs with --watch)", () => {
    expect(caddyReloadTargetFromEnv({})).toBeNull();
  });

  it("fails loudly on a self-hosted install without the env", () => {
    expect(() => caddyReloadTargetFromEnv({ CAELO_PROVIDER: "self-hosted" })).toThrow(
      /cms-provision up/,
    );
  });
});

describe("reloadCaddy", () => {
  it("POSTs the Caddyfile to /load over the unix socket", async () => {
    const dir = scratch();
    const socket = join(dir, "admin.sock");
    const caddyfile = join(dir, "Caddyfile");
    writeFileSync(caddyfile, ":80 {\n\timport /srv/current/_redirects.caddy*\n}\n");
    const seen: { method: string; path: string; type: string | null; body: string }[] = [];
    const server = Bun.serve({
      unix: socket,
      async fetch(req) {
        seen.push({
          method: req.method,
          path: new URL(req.url).pathname,
          type: req.headers.get("content-type"),
          body: await req.text(),
        });
        return new Response(null, { status: 200 });
      },
    });
    try {
      await reloadCaddyIfConfigured({
        CAELO_CADDY_ADMIN_SOCKET: socket,
        CAELO_CADDYFILE: caddyfile,
      });
    } finally {
      server.stop(true);
    }
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/load",
        type: "text/caddyfile",
        body: ":80 {\n\timport /srv/current/_redirects.caddy*\n}\n",
      },
    ]);
  });

  it("fails the deploy with Caddy's message when Caddy rejects the config", async () => {
    const dir = scratch();
    const socket = join(dir, "admin.sock");
    const caddyfile = join(dir, "Caddyfile");
    writeFileSync(caddyfile, "broken");
    const server = Bun.serve({
      unix: socket,
      fetch: () => new Response('{"error":"adapting config: bad token"}', { status: 400 }),
    });
    try {
      await expect(
        reloadCaddy({ endpoint: { kind: "socket", path: socket }, caddyfilePath: caddyfile }),
      ).rejects.toThrow(/HTTP 400.*bad token.*previous config/);
    } finally {
      server.stop(true);
    }
  });

  it("fails loudly when the admin API is unreachable", async () => {
    const dir = scratch();
    const caddyfile = join(dir, "Caddyfile");
    writeFileSync(caddyfile, ":80 {}\n");
    await expect(
      reloadCaddy({
        endpoint: { kind: "socket", path: join(dir, "missing.sock") },
        caddyfilePath: caddyfile,
      }),
    ).rejects.toThrow(/admin API is unreachable/);
  });
});
