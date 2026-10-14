// SPDX-License-Identifier: MPL-2.0

/**
 * #587 — self-hosted wiring for the redirects table: each public vhost
 * imports its build's `_redirects.caddy`, Caddy's admin API listens on a
 * unix socket in a volume only Caddy and the admin mount, and the admin
 * gets the socket + a read-only Caddyfile to reload through. (The snippet
 * itself runs through a real Caddy in admin-core's
 * caddy-redirects.docker.test.ts.)
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateCaddyfile } from "./caddy.js";
import { generateDockerCompose } from "./compose.js";

const caddyfile = generateCaddyfile({
  ownerEmail: "owner@example.com",
  publicSiteRoot: "/srv/caelo/output/production/current",
  stagingSiteRoot: "/srv/caelo/output/staging/current",
  adminPort: 5173,
  gatewayPort: 8090,
  domains: [
    { hostname: "example.com", kind: "public", env: "production" },
    { hostname: "staging.example.com", kind: "public", env: "staging" },
    { hostname: "admin.example.com", kind: "admin", env: "production" },
  ],
});

const block = (host: string) =>
  caddyfile.match(new RegExp(`(?:^|\\n)${host.replace(/\./g, "\\.")} \\{[\\s\\S]*?\\n\\}`))?.[0] ??
  "";

describe("Caddyfile — redirects (#587)", () => {
  it("each public vhost imports the redirect snippet of the build it serves", () => {
    expect(block("example.com")).toContain(
      "  root * /srv/caelo/output/production/current\n  import /srv/caelo/output/production/current/_redirects.caddy*\n",
    );
    expect(block("staging.example.com")).toContain(
      "import /srv/caelo/output/staging/current/_redirects.caddy*",
    );
    expect(block("admin.example.com")).not.toContain("_redirects.caddy");
  });

  it("serves the admin API on the shared unix socket only", () => {
    expect(
      caddyfile.startsWith(
        "{\n  email owner@example.com\n  admin unix//run/caddy-admin/admin.sock\n}",
      ),
    ).toBe(true);
  });

  it("the dev Caddyfiles import the snippet of /srv/current", () => {
    for (const env of ["production", "staging"]) {
      const src = readFileSync(resolve(import.meta.dir, `../caddy/Caddyfile.${env}`), "utf8");
      expect(src).toContain("\timport /srv/current/_redirects.caddy*\n");
    }
  });
});

describe("Compose — Caddy reload path (#587)", () => {
  const yaml = generateDockerCompose({
    domain: "example.com",
    postgresPassword: "pgpw",
    rolePasswords: { admin: "a", public: "p", gateway: "g" },
    minioRootUser: "caelo",
    minioRootPassword: "m",
    caeloSecretKek: "0".repeat(64),
    diskSize: "20Gi",
    images: {
      mode: "release",
      admin: `ghcr.io/caelo-cms/admin@sha256:${"a".repeat(64)}`,
      gateway: `ghcr.io/caelo-cms/gateway@sha256:${"b".repeat(64)}`,
    },
  });
  const service = (name: string) => {
    const start = yaml.indexOf(`  ${name}:\n`);
    const end = yaml.indexOf("\n\n", start);
    return yaml.slice(start, end === -1 ? undefined : end);
  };

  it("shares the admin socket volume between Caddy and the admin only", () => {
    expect(service("caddy")).toContain("- caelo-caddy-admin:/run/caddy-admin");
    expect(service("caelo-admin")).toContain("- caelo-caddy-admin:/run/caddy-admin");
    expect(service("caelo-gateway")).not.toContain("caddy-admin");
    expect(yaml).toMatch(/\nvolumes:\n[\s\S]*\n {2}caelo-caddy-admin:\n/);
  });

  it("gives the admin the socket and a read-only copy of the Caddyfile", () => {
    const admin = service("caelo-admin");
    expect(admin).toContain("- ./Caddyfile:/etc/caelo/Caddyfile:ro");
    expect(admin).toContain('CAELO_CADDY_ADMIN_SOCKET: "/run/caddy-admin/admin.sock"');
    expect(admin).toContain('CAELO_CADDYFILE: "/etc/caelo/Caddyfile"');
  });
});

describe("dev docker-compose.yml (#587)", () => {
  it("runs both dev Caddies with --watch so a new build's snippet is picked up", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../../docker-compose.yml"), "utf8");
    expect(
      src.match(/command: caddy run --config \/etc\/caddy\/Caddyfile --adapter caddyfile --watch/g),
    ).toHaveLength(2);
  });
});
