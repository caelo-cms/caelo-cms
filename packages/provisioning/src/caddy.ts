// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — Caddyfile generator.
 *
 * Reads the `domains` table + the deploy targets and emits a
 * deterministic Caddyfile string. The CLI's `regenerate-caddy`
 * sub-command writes this to `/etc/caddy/Caddyfile` and runs
 * `caddy reload`.
 *
 * Per-vhost shape:
 *   <hostname> {
 *     # admin   → reverse_proxy localhost:5173
 *     # public  → root + try_files (static), with /api/* → gateway
 *     # locale  → same as public, scoped to a per-locale dist dir
 *     tls <ownerEmail>
 *   }
 *
 * Staging vhosts force `X-Robots-Tag: noindex`.
 */

export interface CaddyDomainSpec {
  readonly hostname: string;
  readonly kind: "admin" | "public" | "locale-public";
  readonly localeCode?: string;
  readonly env: "production" | "staging";
}

export interface CaddyfileSpec {
  readonly ownerEmail: string;
  readonly publicSiteRoot: string; // absolute path on disk
  readonly stagingSiteRoot: string;
  readonly adminPort: number;
  readonly gatewayPort: number;
  readonly domains: ReadonlyArray<CaddyDomainSpec>;
}

export function generateCaddyfile(spec: CaddyfileSpec): string {
  const blocks: string[] = [];

  // Global options.
  blocks.push(`{
  email ${spec.ownerEmail}
}
`);

  for (const d of spec.domains) {
    blocks.push(vhost(d, spec));
  }

  // Localhost dev fallback when no domains are configured (so a fresh
  // `cms-provision` produces a working Caddyfile even pre-DNS).
  if (spec.domains.length === 0) {
    blocks.push(`# No domains configured yet — cms-provision regenerate-caddy
# will overwrite this file when you add one at /security/domains.
:8081 {
  reverse_proxy localhost:${spec.adminPort}
}
`);
  }

  return blocks.join("\n");
}

function vhost(d: CaddyDomainSpec, spec: CaddyfileSpec): string {
  const noindex = d.env === "staging" ? `\n  header X-Robots-Tag "noindex"` : "";
  if (d.kind === "admin") {
    return `${d.hostname} {${noindex}
  reverse_proxy localhost:${spec.adminPort}
}
`;
  }
  // public / locale-public — same shape: API routes go to the gateway,
  // the rest serves static files. Locale variants serve from a
  // per-locale subdirectory.
  const root = d.env === "staging" ? spec.stagingSiteRoot : spec.publicSiteRoot;
  const localeSubdir = d.kind === "locale-public" && d.localeCode ? `/${d.localeCode}` : "";
  return `${d.hostname} {${noindex}
  root * ${root}${localeSubdir}
  handle /api/* {
    reverse_proxy localhost:${spec.gatewayPort}
  }
  handle /admin/* {
    reverse_proxy localhost:${spec.adminPort}
  }
  handle {
    file_server {
      try_files {path} {path}/index.html /index.html
    }
  }
}
`;
}
