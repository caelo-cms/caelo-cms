// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type CaddyfileSpec,
  caddyTokenProblem,
  generateCaddyfile,
  selfHostedAdminHost,
  selfHostedSeedDomains,
} from "./caddy.js";
import { COMPOSE_ADMIN_UPSTREAM, COMPOSE_GATEWAY_UPSTREAM } from "./compose.js";

/** The inputs `cms-provision init` passes for example.com. */
const spec: CaddyfileSpec = {
  ownerEmail: "owner@example.com",
  tls: "acme",
  publicSiteRoot: "/srv/caelo/output/production/current",
  stagingSiteRoot: "/srv/caelo/output/staging/current",
  adminUpstream: COMPOSE_ADMIN_UPSTREAM,
  gatewayUpstream: COMPOSE_GATEWAY_UPSTREAM,
  domains: selfHostedSeedDomains("example.com", "staging.example.com"),
};

/** One site block, from its address line to its closing brace. */
function block(caddyfile: string, host: string): string {
  const start = caddyfile.indexOf(`\n${host} {\n`);
  if (start === -1) throw new Error(`no site block for ${host}`);
  return caddyfile.slice(start + 1, caddyfile.indexOf("\n}\n", start) + 2);
}

describe("self-hosted seed vhosts", () => {
  it("puts the admin on admin.<domain>, the live and the staging site on their own hosts", () => {
    expect(selfHostedSeedDomains("example.com", "staging.example.com")).toEqual([
      { hostname: "admin.example.com", kind: "admin", env: "production" },
      { hostname: "example.com", kind: "public", env: "production" },
      { hostname: "staging.example.com", kind: "public", env: "staging" },
    ]);
    expect(selfHostedAdminHost("example.com")).toBe("admin.example.com");
  });

  it("refuses two vhosts for one host — Caddy would reject the whole file", () => {
    expect(() =>
      generateCaddyfile({
        ...spec,
        domains: [
          { hostname: "example.com", kind: "admin", env: "production" },
          { hostname: "example.com", kind: "public", env: "production" },
        ],
      }),
    ).toThrow(/example\.com is listed twice/);
  });
});

describe("Caddyfile upstreams (#707)", () => {
  const out = generateCaddyfile(spec);

  it("proxies to the Compose service names, never to localhost (Caddy's own container)", () => {
    expect(out).not.toContain("localhost");
    expect(out).not.toContain("127.0.0.1");
    expect(block(out, "admin.example.com")).toContain("reverse_proxy caelo-admin:5173");
    for (const host of ["example.com", "staging.example.com"]) {
      expect(block(out, host)).toContain("handle /api/* {\n    reverse_proxy caelo-gateway:8090\n");
    }
  });

  it("does not route /admin/* on the public site (the admin routes from / on its own host)", () => {
    expect(block(out, "example.com")).not.toContain("/admin");
  });
});

describe("Caddyfile static site (#566)", () => {
  const publicBlock = block(generateCaddyfile(spec), "example.com");

  it("emits try_files as its own directive before file_server, never inside it", () => {
    expect(publicBlock).toContain(
      "  handle {\n    try_files {path} {path}/index.html\n    file_server\n  }\n",
    );
    expect(publicBlock).not.toMatch(/file_server \{[^}]*try_files/);
  });

  it("answers a missing path with a 404 and the generator's 404 page, not the home page", () => {
    expect(publicBlock).not.toContain("/index.html /index.html");
    expect(publicBlock).toContain(
      "  handle_errors 404 {\n    rewrite * /404.html\n    file_server\n  }\n",
    );
  });

  it("serves production and staging from their own roots; only staging is noindex", () => {
    const out = generateCaddyfile(spec);
    expect(block(out, "example.com")).toContain("root * /srv/caelo/output/production/current");
    expect(block(out, "example.com")).not.toContain("X-Robots-Tag");
    const staging = block(out, "staging.example.com");
    expect(staging).toContain("root * /srv/caelo/output/staging/current");
    expect(staging).toContain('header X-Robots-Tag "noindex"');
  });
});

describe("Caddyfile TLS", () => {
  it("uses ACME with the Owner's email by default", () => {
    const out = generateCaddyfile(spec);
    expect(out.startsWith("{\n  email owner@example.com\n}\n")).toBe(true);
    expect(out).not.toContain("local_certs");
  });

  it("issues every certificate from Caddy's local CA with tls internal", () => {
    const out = generateCaddyfile({ ...spec, tls: "internal" });
    expect(out.startsWith("{\n  email owner@example.com\n  local_certs\n}\n")).toBe(true);
  });

  it("rejects unsafe characters in ownerEmail and domain hostnames", () => {
    expect(() => generateCaddyfile({ ...spec, ownerEmail: "owner@example.com\n  debug" })).toThrow(
      /invalid ownerEmail/,
    );
    expect(() =>
      generateCaddyfile({
        ...spec,
        domains: [
          { hostname: "evil.example.com {\n  respond 200\n}", kind: "public", env: "production" },
        ],
      }),
    ).toThrow(/invalid hostname/);
  });

  it("refuses a comma in a site address — it would add a second address to the block", () => {
    // `admin.example.com,:80` would serve the admin on every host on port 80.
    expect(() =>
      generateCaddyfile({
        ...spec,
        domains: [{ hostname: "admin.example.com,:80", kind: "admin", env: "production" }],
      }),
    ).toThrow(/invalid hostname/);
    // A comma is harmless inside a token like the email.
    expect(caddyTokenProblem("a,b@example.com", "token")).toBeNull();
    expect(caddyTokenProblem("a,b.example.com", "address")).toMatch(/','/);
    expect(caddyTokenProblem("", "token")).toBe("it is empty");
    expect(caddyTokenProblem("192.168.1.10", "address")).toBeNull();
  });
});
