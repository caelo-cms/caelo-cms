// SPDX-License-Identifier: MPL-2.0

/**
 * #587 — self-hosted wiring for the redirects table: each public vhost
 * imports its build's `_redirects.caddy`, and the Caddy container reloads
 * itself when a deploy changes it (caddy-redirects.ts). The snippet and the
 * loop run against a real Caddy in caddy-redirects.docker.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateCaddyfile } from "./caddy.js";
import { caddyRedirectReloadCommand, caddyRedirectReloadScript } from "./caddy-redirects.js";
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

/** The site block of `host`: from its `<host> {` line to the next `}` line. */
function block(host: string): string {
  const lines = caddyfile.split("\n");
  const start = lines.indexOf(`${host} {`);
  if (start === -1) return "";
  const end = lines.indexOf("}", start);
  return lines.slice(start, end + 1).join("\n");
}

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

  it("the dev Caddyfiles import the snippet of /srv/current", () => {
    for (const env of ["production", "staging"]) {
      const src = readFileSync(resolve(import.meta.dir, `../caddy/Caddyfile.${env}`), "utf8");
      expect(src).toContain("\timport /srv/current/_redirects.caddy*\n");
    }
  });
});

describe("Compose — Caddy picks up new redirects (#587)", () => {
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

  it("runs Caddy with the loop that reloads it on a changed snippet", () => {
    expect(service("caddy")).toContain(
      `    ${caddyRedirectReloadCommand("/srv/caelo/output/*/current/_redirects.caddy")}\n`,
    );
    expect(yaml).not.toContain("caddy-admin");
  });
});

describe("dev docker-compose.yml (#587)", () => {
  it("runs both dev Caddies with the same reload loop", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../../docker-compose.yml"), "utf8");
    const line = `    ${caddyRedirectReloadCommand("/srv/current/_redirects.caddy")}\n`;
    expect(src.split(line)).toHaveLength(3);
  });
});

describe("caddyRedirectReloadScript", () => {
  it("refuses a glob that could break out of the shell script", () => {
    expect(() => caddyRedirectReloadScript("/srv/x; rm -rf /")).toThrow(/unsafe snippet glob/);
  });

  it("doubles every $ for Compose, nothing else", () => {
    const script = caddyRedirectReloadScript("/srv/current/_redirects.caddy");
    const cmd = caddyRedirectReloadCommand("/srv/current/_redirects.caddy");
    const parsed = JSON.parse(cmd.slice("command: ".length)) as string[];
    expect(parsed.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(parsed[2]?.replaceAll("$$", "$")).toBe(script);
  });
});
