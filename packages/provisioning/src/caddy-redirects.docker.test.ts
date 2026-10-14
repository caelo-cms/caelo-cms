// SPDX-License-Identifier: MPL-2.0

/**
 * #587 — the self-hosted redirect path end to end against a real Caddy:
 * the generated `_redirects.caddy` snippet, imported by the repo's
 * Caddyfiles, passes `caddy validate`; a running Caddy answers redirected
 * paths with the planned status + Location (query kept, case-sensitive, the
 * live page wins, 410 for gone); run with the reload loop the install's
 * Compose file uses (caddyRedirectReloadScript), Caddy picks up a deploy's
 * new snippet; a snippet Caddy rejects leaves the previous redirects served,
 * and the next good snippet is picked up again.
 *
 * Needs Docker. Skipped locally when Docker is not running; in CI (`CI`
 * set) a missing Docker fails the test instead of skipping it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRedirectPlan, emitCaddyRedirects, type RedirectTableRow } from "@caelo-cms/shared";
import { caddyRedirectReloadScript } from "./caddy-redirects.js";

/** The Caddy image the test runs (pinned; the Compose files use the 2.x line). */
const CADDY_IMAGE = "caddy:2.11.7-alpine";
const CADDY_DIR = resolve(import.meta.dir, "../caddy");

const dockerUp = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).success;
if (!dockerUp && process.env.CI) {
  throw new Error("caddy-redirects.docker.test: Docker is required in CI but `docker info` failed");
}

function docker(args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.success, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

function snippet(rows: [string, string, number][], servedFiles: string[]): string {
  const tableRows: RedirectTableRow[] = rows.map(([fromPath, toPath, statusCode]) => ({
    fromPath,
    toPath,
    statusCode,
  }));
  return emitCaddyRedirects(
    buildRedirectPlan({
      rows: tableRows,
      pageUrlStyle: "directory",
      servedFiles: new Set(servedFiles),
    }),
  );
}

const SERVED = ["index.html", "about/index.html", "blog/index.html"];

describe.skipIf(!dockerUp)("self-hosted redirects through a real Caddy", () => {
  const name = `caelo-test-587-${process.pid}-${Date.now()}`;
  let dir = "";
  let site = "";

  const write = (body: string) => writeFileSync(join(dir, "srv/current/_redirects.caddy"), body);
  const get = (path: string) => fetch(`${site}${path}`, { redirect: "manual" });
  /** Poll until `path` redirects to `location` (the loop polls every 2 s). */
  const eventually = async (path: string, location: string | null) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const got = (await get(path)).headers.get("location");
      if (got === location) return;
      if (Date.now() > deadline) {
        throw new Error(`${path} → ${got}, expected ${location}: ${docker(["logs", name]).out}`);
      }
      await Bun.sleep(250);
    }
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "caelo-587-caddy-"));
    mkdirSync(join(dir, "srv/current/about"), { recursive: true });
    mkdirSync(join(dir, "srv/current/blog"), { recursive: true });
    for (const f of SERVED) writeFileSync(join(dir, "srv/current", f), `<p>${f}</p>`);
    for (const env of ["production", "staging"]) {
      writeFileSync(
        join(dir, `Caddyfile.${env}`),
        readFileSync(join(CADDY_DIR, `Caddyfile.${env}`), "utf8"),
      );
    }
    write(
      snippet(
        [
          ["/old", "/about", 301],
          ["/tmp", "/blog", 302],
          ["/perm", "/about", 308],
          ["/hop1", "/hop2", 301],
          ["/hop2", "/blog", 301],
          ["/Case", "/about", 301],
          ["/q", "/about?ref=old", 301],
          ["/gone", "/410", 410],
          ["/about", "/elsewhere", 301],
        ],
        SERVED,
      ),
    );
  });

  afterAll(() => {
    docker(["rm", "-f", name]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("the repo's Caddyfiles validate with the generated snippet imported", () => {
    for (const env of ["production", "staging"]) {
      const r = docker([
        "run",
        "--rm",
        "-v",
        `${join(dir, `Caddyfile.${env}`)}:/etc/caddy/Caddyfile:ro`,
        "-v",
        `${join(dir, "srv")}:/srv:ro`,
        CADDY_IMAGE,
        "caddy",
        "validate",
        "--config",
        "/etc/caddy/Caddyfile",
        "--adapter",
        "caddyfile",
      ]);
      expect(`${env}: ${r.ok}`).toBe(`${env}: true`);
      expect(r.out).toContain("Valid configuration");
    }
  }, 120_000);

  it("a running Caddy answers redirected paths with the planned status + Location", async () => {
    const run = docker([
      "run",
      "-d",
      "--name",
      name,
      "-p",
      "127.0.0.1::80",
      "-v",
      `${join(dir, "Caddyfile.production")}:/etc/caddy/Caddyfile:ro`,
      "-v",
      `${join(dir, "srv")}:/srv:ro`,
      CADDY_IMAGE,
      // As the install's Compose file runs it (compose.ts).
      "/bin/sh",
      "-c",
      caddyRedirectReloadScript("/srv/current/_redirects.caddy"),
    ]);
    expect(run.out).not.toContain("Error");
    const port = (p: number) =>
      docker(["port", name, `${p}/tcp`])
        .out.trim()
        .split("\n")[0] ?? "";
    site = `http://${port(80)}`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const up = await fetch(`${site}/`).then(
        (r) => r.ok,
        () => false,
      );
      if (up) break;
      if (Date.now() > deadline)
        throw new Error(`Caddy did not start: ${docker(["logs", name]).out}`);
      await Bun.sleep(500);
    }

    const expectRedirect = async (path: string, status: number, location: string) => {
      const res = await get(path);
      expect(`${path} ${res.status} ${res.headers.get("location")}`).toBe(
        `${path} ${status} ${location}`,
      );
    };
    await expectRedirect("/old", 301, "/about/");
    await expectRedirect("/old/", 301, "/about/");
    await expectRedirect("/old?utm_source=x&a=1", 301, "/about/?utm_source=x&a=1");
    await expectRedirect("/tmp", 302, "/blog/");
    await expectRedirect("/perm/", 308, "/about/");
    await expectRedirect("/hop1", 301, "/blog/");
    await expectRedirect("/Case", 301, "/about/");
    await expectRedirect("/q?dropped=1", 301, "/about?ref=old");
    expect((await get("/gone")).status).toBe(410);
    // Exact, case-sensitive: /case is not /Case.
    expect((await get("/case")).status).toBe(404);
    // The live page wins over the recorded /about → /elsewhere.
    const about = await get("/about/");
    expect(about.status).toBe(200);
    expect(await about.text()).toBe("<p>about/index.html</p>");
  }, 120_000);

  it("picks up a deploy's new snippet through the reload loop", async () => {
    write(snippet([["/brand-new", "/blog", 301]], SERVED));
    await eventually("/brand-new", "/blog/");
    expect((await get("/old")).status).toBe(404);
  }, 60_000);

  it("a snippet Caddy rejects leaves the previous redirects live", async () => {
    write("map {path} {\n");
    await Bun.sleep(3_000);
    expect((await get("/brand-new")).headers.get("location")).toBe("/blog/");
    // The next good snippet is picked up again.
    write(snippet([["/after-fix", "/about", 301]], SERVED));
    await eventually("/after-fix", "/about/");
  }, 60_000);
});
