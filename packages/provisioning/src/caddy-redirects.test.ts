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
import { generateCaddyfile, selfHostedSeedDomains } from "./caddy.js";
import { caddyRedirectReloadCommand, caddyRedirectReloadScript } from "./caddy-redirects.js";
import {
  COMPOSE_ADMIN_UPSTREAM,
  COMPOSE_GATEWAY_UPSTREAM,
  COMPOSE_REDIRECT_SNIPPETS,
  generateDockerCompose,
} from "./compose.js";

const caddyfile = generateCaddyfile({
  ownerEmail: "owner@example.com",
  tls: "acme",
  publicSiteRoot: "/srv/caelo/output/production/current",
  stagingSiteRoot: "/srv/caelo/output/staging/current",
  adminUpstream: COMPOSE_ADMIN_UPSTREAM,
  gatewayUpstream: COMPOSE_GATEWAY_UPSTREAM,
  domains: selfHostedSeedDomains("example.com", "staging.example.com"),
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
    rolePasswords: { admin: "a", public: "p" },
    caeloSecretKek: "0".repeat(64),
    internalSecret: "i".repeat(48),
    diskSize: "20Gi",
    ports: { http: 80, https: 443 },
    project: "caelo-example-com",
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
      `    ${caddyRedirectReloadCommand(COMPOSE_REDIRECT_SNIPPETS)}\n`,
    );
    expect(COMPOSE_REDIRECT_SNIPPETS).toBe("/srv/caelo/output/*/current/_redirects.caddy");
    // The loop names no container or project: it runs inside the Caddy
    // container of whichever Compose project this is.
    expect(caddyRedirectReloadCommand(COMPOSE_REDIRECT_SNIPPETS)).not.toMatch(
      /caelo-caddy|COMPOSE_PROJECT|docker/,
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
