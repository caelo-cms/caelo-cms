// SPDX-License-Identifier: MPL-2.0

/**
 * #587 — the self-hosted redirect path end to end against the Caddy image
 * the Compose file runs ({@link CADDY_IMAGE}):
 *
 * - the GENERATED Caddyfile (the seed vhosts `init` writes) and the repo's
 *   dev Caddyfiles pass `caddy validate` with a real redirect snippet
 *   imported;
 * - a container started like the Compose service (same Caddyfile shape,
 *   same `/srv/caelo` mount, same reload-loop command and snippet glob)
 *   answers redirected paths on the live and the staging host with the
 *   planned status + Location — query kept, case-sensitive, the live page
 *   wins, 410 for gone;
 * - the reload loop picks up a deploy's new snippet, a snippet Caddy
 *   rejects leaves the previous redirects live, and the next good snippet
 *   is picked up again.
 *
 * Needs Docker and curl. CI sets `CAELO_CADDY_VALIDATE=required` (as for
 * caddy-validate.test.ts), which turns a missing Docker into a failure.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRedirectPlan, emitCaddyRedirects, type RedirectTableRow } from "@caelo-cms/shared";
import { generateCaddyfile, selfHostedSeedDomains } from "./caddy.js";
import { caddyRedirectReloadScript } from "./caddy-redirects.js";
import {
  CADDY_IMAGE,
  COMPOSE_ADMIN_UPSTREAM,
  COMPOSE_GATEWAY_UPSTREAM,
  COMPOSE_REDIRECT_SNIPPETS,
  SITE_OUTPUT_ROOT,
} from "./compose.js";

const REQUIRED = process.env.CAELO_CADDY_VALIDATE === "required";
const dockerUp = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).success;
if (!dockerUp && REQUIRED) {
  throw new Error(
    "caddy-redirects.docker.test: CAELO_CADDY_VALIDATE=required but `docker info` failed",
  );
}

const LIVE = "example.test";
const STAGING = "staging.example.test";
const CADDY_DIR = resolve(import.meta.dir, "../caddy");
const SERVED = ["index.html", "about/index.html", "blog/index.html"];
/** Consecutive matching answers that count as "the reload settled". */
const SETTLED_PROBES = 5;

function docker(args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.success, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

function snippet(rows: [string, string, number][]): string {
  const tableRows: RedirectTableRow[] = rows.map(([fromPath, toPath, statusCode]) => ({
    fromPath,
    toPath,
    statusCode,
  }));
  return emitCaddyRedirects(
    buildRedirectPlan({
      rows: tableRows,
      pageUrlStyle: "directory",
      servedFiles: new Set(SERVED),
    }),
  );
}

describe.skipIf(!dockerUp)(`self-hosted redirects through ${CADDY_IMAGE}`, () => {
  const name = `caelo-test-587-${process.pid}-${Date.now()}`;
  let dir = "";
  let httpsPort = "";

  /** The host dir mounted at SITE_OUTPUT_ROOT, as `./output` is in Compose. */
  const outputDir = () => join(dir, "output");
  const current = (env: string) => join(outputDir(), "output", env, "current");
  const write = (env: string, body: string) =>
    writeFileSync(join(current(env), "_redirects.caddy"), body);

  /** Status + Location of `https://<host><path>` through the container. */
  const probe = (host: string, path: string): { status: number; location: string | null } => {
    const r = Bun.spawnSync(
      [
        "curl",
        "-sk",
        "-o",
        "/dev/null",
        "-D",
        "-",
        "--resolve",
        `${host}:${httpsPort}:127.0.0.1`,
        `https://${host}:${httpsPort}${path}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const head = r.stdout.toString();
    const status = Number(head.match(/^HTTP\/\S+ (\d{3})/)?.[1] ?? 0);
    const location = head.match(/^location: ([^\r\n]*)/im)?.[1]?.trim() ?? null;
    return { status, location };
  };
  /**
   * Waits until `path` answers with `location` on {@link SETTLED_PROBES}
   * consecutive connections. One matching answer is not enough: Caddy's
   * graceful reload keeps the old config's listener open next to the new
   * one (SO_REUSEPORT) while it drains, so the connection after the first
   * new answer can still reach the old config (CI runs 38867358899 and
   * 39242522450). Only a streak of new answers shows the reload settled.
   */
  const eventually = async (host: string, path: string, location: string | null) => {
    const deadline = Date.now() + 30_000;
    let streak = 0;
    for (;;) {
      const got = probe(host, path).location;
      streak = got === location ? streak + 1 : 0;
      if (streak >= SETTLED_PROBES) return;
      if (got === location) {
        await Bun.sleep(200);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${host}${path} → ${got}, expected ${location}: ${docker(["logs", name]).out}`,
        );
      }
      await Bun.sleep(250);
    }
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "caelo-587-caddy-"));
    for (const env of ["production", "staging"]) {
      for (const f of SERVED) {
        mkdirSync(join(current(env), f, ".."), { recursive: true });
        writeFileSync(join(current(env), f), `<p>${env} ${f}</p>`);
      }
    }
    // The Caddyfile `init` writes, with Caddy's local CA so the test needs
    // no public DNS.
    writeFileSync(
      join(dir, "Caddyfile"),
      generateCaddyfile({
        ownerEmail: "owner@example.test",
        tls: "internal",
        publicSiteRoot: `${SITE_OUTPUT_ROOT}/output/production/current`,
        stagingSiteRoot: `${SITE_OUTPUT_ROOT}/output/staging/current`,
        adminUpstream: COMPOSE_ADMIN_UPSTREAM,
        gatewayUpstream: COMPOSE_GATEWAY_UPSTREAM,
        domains: selfHostedSeedDomains(LIVE, STAGING),
      }),
    );
    write(
      "production",
      snippet([
        ["/old", "/about", 301],
        ["/tmp", "/blog", 302],
        ["/perm", "/about", 308],
        ["/hop1", "/hop2", 301],
        ["/hop2", "/blog", 301],
        ["/Case", "/about", 301],
        ["/q", "/about?ref=old", 301],
        ["/gone", "/410", 410],
        ["/about", "/elsewhere", 301],
      ]),
    );
    write("staging", snippet([["/staged-old", "/blog", 301]]));
  });

  afterAll(() => {
    docker(["rm", "-f", name]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("the generated Caddyfile and the repo's dev Caddyfiles validate with a snippet imported", () => {
    const validate = (caddyfile: string, siteMount: string) =>
      docker([
        "run",
        "--rm",
        "-v",
        `${caddyfile}:/etc/caddy/Caddyfile:ro`,
        "-v",
        siteMount,
        CADDY_IMAGE,
        "caddy",
        "validate",
        "--config",
        "/etc/caddy/Caddyfile",
        "--adapter",
        "caddyfile",
      ]);
    const generated = validate(join(dir, "Caddyfile"), `${outputDir()}:${SITE_OUTPUT_ROOT}:ro`);
    expect(generated.out).toContain("Valid configuration");
    for (const env of ["production", "staging"]) {
      const devFile = join(dir, `Caddyfile.${env}`);
      writeFileSync(devFile, readFileSync(join(CADDY_DIR, `Caddyfile.${env}`), "utf8"));
      // docker-compose.yml mounts output/<env> at /srv; current/ holds the snippet.
      const r = validate(devFile, `${join(outputDir(), "output", env)}:/srv:ro`);
      expect(`${env}: ${r.out.includes("Valid configuration")}`).toBe(`${env}: true`);
    }
  }, 180_000);

  it("a container started like the Compose service answers the planned redirects", async () => {
    const run = docker([
      "run",
      "-d",
      "--name",
      name,
      "-p",
      "127.0.0.1::443",
      "-v",
      `${join(dir, "Caddyfile")}:/etc/caddy/Caddyfile:ro`,
      "-v",
      `${outputDir()}:${SITE_OUTPUT_ROOT}:ro`,
      CADDY_IMAGE,
      // The Compose service's command, with the Compose snippet glob.
      "/bin/sh",
      "-c",
      caddyRedirectReloadScript(COMPOSE_REDIRECT_SNIPPETS),
    ]);
    expect(run.ok).toBe(true);
    httpsPort = docker(["port", name, "443/tcp"]).out.trim().split("\n")[0]?.split(":").pop() ?? "";
    const deadline = Date.now() + 90_000;
    while (probe(LIVE, "/").status !== 200) {
      if (Date.now() > deadline) {
        throw new Error(`Caddy did not start: ${docker(["logs", name]).out}`);
      }
      await Bun.sleep(500);
    }

    const expectRedirect = (path: string, status: number, location: string, host = LIVE) => {
      const r = probe(host, path);
      expect(`${host}${path} ${r.status} ${r.location}`).toBe(
        `${host}${path} ${status} ${location}`,
      );
    };
    expectRedirect("/old", 301, "/about/");
    expectRedirect("/old/", 301, "/about/");
    expectRedirect("/old?utm_source=x&a=1", 301, "/about/?utm_source=x&a=1");
    expectRedirect("/tmp", 302, "/blog/");
    expectRedirect("/perm/", 308, "/about/");
    expectRedirect("/hop1", 301, "/blog/");
    expectRedirect("/Case", 301, "/about/");
    expectRedirect("/q?dropped=1", 301, "/about?ref=old");
    expectRedirect("/staged-old", 301, "/blog/", STAGING);
    expect(probe(LIVE, "/gone").status).toBe(410);
    // Exact, case-sensitive: /case is not /Case.
    expect(probe(LIVE, "/case").status).toBe(404);
    // Each host serves its own build's redirects.
    expect(probe(LIVE, "/staged-old").status).toBe(404);
    // The live page wins over the recorded /about → /elsewhere.
    expect(probe(LIVE, "/about/")).toEqual({ status: 200, location: null });
  }, 180_000);

  it("the reload loop picks up a deploy's new snippet", async () => {
    write("production", snippet([["/brand-new", "/blog", 301]]));
    await eventually(LIVE, "/brand-new", "/blog/");
    // What must hold is that the new snippet REPLACES the old one once the
    // reload settled (see `eventually` for why one answer is not enough).
    await eventually(LIVE, "/old", null);
    expect(probe(LIVE, "/old").status).toBe(404);
    expect(probe(LIVE, "/brand-new").location).toBe("/blog/");
  }, 60_000);

  it("a snippet Caddy rejects leaves the previous redirects live; the next good one is picked up", async () => {
    write("production", "map {path} {\n");
    await Bun.sleep(5_000);
    expect(probe(LIVE, "/brand-new").location).toBe("/blog/");
    expect(docker(["logs", name]).out).toContain("Caddy rejected the reload");
    write("production", snippet([["/after-fix", "/about", 301]]));
    await eventually(LIVE, "/after-fix", "/about/");
  }, 60_000);
});
