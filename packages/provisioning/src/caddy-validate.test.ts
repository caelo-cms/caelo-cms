// SPDX-License-Identifier: MPL-2.0

/**
 * The generated Caddyfile through the real Caddy (issue #566): `caddy
 * validate` on the exact image the Compose file runs ({@link CADDY_IMAGE}).
 * String assertions cannot catch a directive Caddy refuses — #566 shipped a
 * `try_files` nested in `file_server { }` that every unit test accepted and
 * Caddy 2.11 rejected, so no self-hosted vhost came up.
 *
 * Needs Docker. CI sets `CAELO_CADDY_VALIDATE=required`, which turns a
 * missing Docker into a failure instead of a skip, so this check can never
 * silently stop running there.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CaddyfileSpec, generateCaddyfile, selfHostedSeedDomains } from "./caddy.js";
import { CADDY_IMAGE, COMPOSE_ADMIN_UPSTREAM, COMPOSE_GATEWAY_UPSTREAM } from "./compose.js";

const REQUIRED = process.env.CAELO_CADDY_VALIDATE === "required";

function dockerAvailable(): boolean {
  try {
    return Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = dockerAvailable();

/** `caddy validate` with the Caddyfile on stdin (no bind mount, so it works on any Docker host). */
async function caddyValidate(caddyfile: string): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "-i",
      CADDY_IMAGE,
      "caddy",
      "validate",
      "--config",
      "/dev/stdin",
      "--adapter",
      "caddyfile",
    ],
    { stdin: new TextEncoder().encode(caddyfile), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, output: `${stdout}\n${stderr}` };
}

const base: CaddyfileSpec = {
  ownerEmail: "owner@example.com",
  tls: "acme",
  publicSiteRoot: "/srv/caelo/output/production/current",
  stagingSiteRoot: "/srv/caelo/output/staging/current",
  adminUpstream: COMPOSE_ADMIN_UPSTREAM,
  gatewayUpstream: COMPOSE_GATEWAY_UPSTREAM,
  domains: selfHostedSeedDomains("example.com", "staging.example.com"),
};

const CASES: Record<string, string> = {
  "the seed vhosts `init` writes (ACME)": generateCaddyfile(base),
  "the seed vhosts with --tls internal": generateCaddyfile({ ...base, tls: "internal" }),
  "seed + operator-added admin and public domains": generateCaddyfile({
    ...base,
    domains: [
      ...base.domains,
      { hostname: "www.example.org", kind: "public", env: "production" },
      { hostname: "cms.example.org", kind: "admin", env: "production" },
    ],
  }),
  "no domains yet (the :8081 block)": generateCaddyfile({ ...base, domains: [] }),
  "caddy/Caddyfile.production": readFileSync(
    join(import.meta.dir, "..", "caddy", "Caddyfile.production"),
    "utf8",
  ),
  "caddy/Caddyfile.staging": readFileSync(
    join(import.meta.dir, "..", "caddy", "Caddyfile.staging"),
    "utf8",
  ),
};

describe(`generated Caddyfiles pass \`caddy validate\` on ${CADDY_IMAGE} (#566)`, () => {
  if (REQUIRED) {
    it("Docker is available (CAELO_CADDY_VALIDATE=required)", () => {
      expect(HAVE_DOCKER).toBe(true);
    });
  }
  it.skipIf(!HAVE_DOCKER)(
    "rejects the #566 shape (proves the check is not a no-op)",
    async () => {
      const r = await caddyValidate(
        ":80 {\n  file_server {\n    try_files {path} {path}/index.html\n  }\n}\n",
      );
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("unknown subdirective 'try_files'");
    },
    180_000,
  );
  for (const [name, caddyfile] of Object.entries(CASES)) {
    it.skipIf(!HAVE_DOCKER)(
      name,
      async () => {
        const r = await caddyValidate(caddyfile);
        if (r.exitCode !== 0) console.error(r.output);
        expect(r.exitCode).toBe(0);
        expect(r.output).toContain("Valid configuration");
      },
      180_000,
    );
  }
});
