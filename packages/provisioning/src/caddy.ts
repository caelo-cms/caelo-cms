// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — Caddyfile generator.
 *
 * Reads the `domains` table + the deploy targets and emits a
 * deterministic Caddyfile string. The CLI's `regenerate-caddy`
 * sub-command writes this to `.caelo/Caddyfile` and runs
 * `caddy reload`.
 *
 * Per-vhost shape:
 *   <hostname> {
 *     # admin   → reverse_proxy <adminUpstream>
 *     # public  → /api/* → <gatewayUpstream>; everything else is the
 *     #           static site (try_files + file_server, 404 → /404.html)
 *   }
 *
 * Upstreams are `host:port` as seen FROM CADDY. In the Compose install
 * Caddy runs in its own container, where `localhost` is Caddy itself, so
 * the CLI passes the Compose service names (`caelo-admin:5173`,
 * `caelo-gateway:8090`) — issue #707.
 *
 * Every directive here must be one Caddy accepts: the output is checked
 * with `caddy validate` on the pinned Caddy image (caddy-validate.test.ts,
 * run in CI) — issue #566 shipped a `try_files` nested inside
 * `file_server { }`, which Caddy 2.11 refuses, so no vhost came up.
 *
 * Staging vhosts force `X-Robots-Tag: noindex`.
 *
 * Public vhosts import the redirect snippet of the build they serve
 * (`_redirects.caddy`, #587); the Caddy container reloads itself when a
 * deploy changes it (caddy-redirects.ts).
 *
 * Public vhosts mark content-hashed build outputs (fonts, plugin
 * bundles — `CONTENT_HASHED_PATH_PATTERN` in @caelo-cms/shared)
 * `immutable` for a year. Everything else keeps Caddy's file_server
 * default (no Cache-Control; ETag + Last-Modified for revalidation),
 * so pages and slug-addressed media are never pinned in caches. The
 * matcher also requires the file to exist (`file`), so a 404 for a
 * hashed URL (an old page requesting an asset the new build dropped)
 * is never cached for a year.
 *
 * A path that matches no file is a real 404 serving the generator's
 * `/404.html` — never the home page with a 200 (an SPA-style
 * `/index.html` fallback would turn every dead URL into a soft 404).
 * Same behaviour as the GCS / S3 / Blob adapters (CLAUDE.md §11.B).
 *
 * `.ico` files (theme favicons) are served as `image/x-icon`, the one
 * icon MIME the media library stores and `<link rel="icon" type>`
 * declares. file_server only fills Content-Type when no earlier handler
 * set it, so the `header` line wins over the host's mime.types name.
 */

import {
  CONTENT_HASHED_PATH_PATTERN,
  caddyRedirectsImport,
  IMMUTABLE_CACHE_CONTROL,
} from "@caelo-cms/shared";

export interface CaddyDomainSpec {
  readonly hostname: string;
  readonly kind: "admin" | "public";
  readonly env: "production" | "staging";
}

/**
 * How Caddy gets certificates: `acme` — publicly trusted ones from Let's
 * Encrypt / ZeroSSL (needs public DNS + ports 80/443 reachable); `internal`
 * — Caddy's own local CA, for a LAN or evaluation install without public
 * DNS (browsers warn until the CA root is trusted).
 */
export type CaddyTlsMode = "acme" | "internal";

export interface CaddyfileSpec {
  readonly ownerEmail: string;
  readonly tls: CaddyTlsMode;
  readonly publicSiteRoot: string; // absolute path inside the Caddy container
  readonly stagingSiteRoot: string;
  /** `host:port` of the admin as Caddy reaches it (Compose: `caelo-admin:5173`). */
  readonly adminUpstream: string;
  /** `host:port` of the API gateway as Caddy reaches it (Compose: `caelo-gateway:8090`). */
  readonly gatewayUpstream: string;
  readonly domains: ReadonlyArray<CaddyDomainSpec>;
}

/** The host the admin of a self-hosted install answers on (same convention as GCP). */
export function selfHostedAdminHost(domain: string): string {
  return `admin.${domain}`;
}

/**
 * The vhosts every self-hosted install serves before an Owner adds domains
 * in the admin: the admin on `admin.<domain>`, the live site on `<domain>`,
 * the staging site on its own host. The admin needs its own host — it
 * routes from `/` (`/setup`, `/login`, …), so it cannot share one with the
 * public site, and Caddy refuses two site blocks for the same address.
 */
export function selfHostedSeedDomains(domain: string, stagingDomain: string): CaddyDomainSpec[] {
  return [
    { hostname: selfHostedAdminHost(domain), kind: "admin", env: "production" },
    { hostname: domain, kind: "public", env: "production" },
    { hostname: stagingDomain, kind: "public", env: "staging" },
  ];
}

/**
 * Characters that would let a value end its Caddyfile token and start new
 * directives or blocks: whitespace (incl. newlines), both quote styles Caddy
 * tokenizes (`"` and backtick), braces (blocks and `{placeholders}`), the
 * comment marker, escapes and semicolons. A site address additionally may
 * not hold a comma, which would add further addresses to the same block.
 */
const UNSAFE_CADDY_TOKEN_RE = /[\s"`{}#\\;]/;
const UNSAFE_CADDY_ADDRESS_RE = /[\s"`{}#\\;,]/;

/**
 * Why `value` cannot go into the Caddyfile as one token, or null when it can.
 * `init` checks the operator's domains and email with this before it writes
 * anything, so a bad value never leaves a half-made install behind.
 *
 * @param kind `address` for a site address (hostname), `token` for any other value
 */
export function caddyTokenProblem(value: string, kind: "address" | "token"): string | null {
  if (value.length === 0) return "it is empty";
  const unsafe = kind === "address" ? UNSAFE_CADDY_ADDRESS_RE : UNSAFE_CADDY_TOKEN_RE;
  if (unsafe.test(value)) {
    return `it contains whitespace, a quote, a brace, '#', '\\', ';'${kind === "address" ? " or ','" : ""}`;
  }
  return null;
}

function assertSafeCaddyToken(label: string, value: string, kind: "address" | "token"): void {
  const problem = caddyTokenProblem(value, kind);
  if (problem) {
    throw new Error(
      `Caddyfile: invalid ${label} ${JSON.stringify(value)} — ${problem}. Fix the value in .caelo/config.json (or the domain you added) and run the command again.`,
    );
  }
}

/** Every caller-supplied value is checked before any of it is emitted (#888). */
export function generateCaddyfile(spec: CaddyfileSpec): string {
  assertSafeCaddyToken("ownerEmail", spec.ownerEmail, "token");
  assertSafeCaddyToken("publicSiteRoot", spec.publicSiteRoot, "token");
  assertSafeCaddyToken("stagingSiteRoot", spec.stagingSiteRoot, "token");
  assertSafeCaddyToken("adminUpstream", spec.adminUpstream, "token");
  assertSafeCaddyToken("gatewayUpstream", spec.gatewayUpstream, "token");

  const hostnames = new Set<string>();
  for (const d of spec.domains) {
    assertSafeCaddyToken("hostname", d.hostname, "address");
    if (hostnames.has(d.hostname)) {
      // Caddy refuses a config with two site blocks for one address, so a
      // duplicate would take every vhost down, not just this one.
      throw new Error(
        `Caddyfile: ${d.hostname} is listed twice — one host serves either the admin or a public site, not both.`,
      );
    }
    hostnames.add(d.hostname);
  }

  const blocks: string[] = [];

  // Global options.
  blocks.push(`{
  email ${spec.ownerEmail}${spec.tls === "internal" ? "\n  local_certs" : ""}
}
`);

  for (const d of spec.domains) {
    blocks.push(vhost(d, spec));
  }

  // Localhost dev fallback when no domains are configured (so a fresh
  // `cms-provision` produces a working Caddyfile even pre-DNS).
  if (spec.domains.length === 0) {
    blocks.push(`# No domains configured yet — cms-provision regenerate-caddy
# will overwrite this file when you add one at /settings/domains.
:8081 {
  reverse_proxy ${spec.adminUpstream}
}
`);
  }

  return blocks.join("\n");
}

function vhost(d: CaddyDomainSpec, spec: CaddyfileSpec): string {
  const noindex = d.env === "staging" ? `\n  header X-Robots-Tag "noindex"` : "";
  if (d.kind === "admin") {
    return `${d.hostname} {${noindex}
  reverse_proxy ${spec.adminUpstream}
}
`;
  }
  // public — API routes go to the gateway, the rest is the static site.
  // `try_files` is its own directive (a rewrite), never a file_server
  // subdirective (#566).
  const root = d.env === "staging" ? spec.stagingSiteRoot : spec.publicSiteRoot;
  // #587 — the redirects table of the build this vhost serves.
  return `${d.hostname} {${noindex}
  root * ${root}
  ${caddyRedirectsImport(root)}
  @content_hashed {
    path_regexp content_hashed ${CONTENT_HASHED_PATH_PATTERN}
    file
  }
  header @content_hashed Cache-Control "${IMMUTABLE_CACHE_CONTROL}"
  @ico path *.ico
  header @ico Content-Type "image/x-icon"
  handle /api/* {
    reverse_proxy ${spec.gatewayUpstream}
  }
  handle {
    try_files {path} {path}/index.html
    file_server
  }
  handle_errors 404 {
    rewrite * /404.html
    file_server
  }
}
`;
}
