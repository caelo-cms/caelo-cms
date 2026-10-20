// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — production docker-compose.yml generator.
 *
 * Emits the production stack: Postgres + Caddy + the two Caelo services
 * (admin, gateway). Idempotent: same input →
 * byte-identical output. The CLI's `init` / `up` / `upgrade` sub-commands
 * write this to `.caelo/docker-compose.yml`.
 *
 * #696 — the admin and gateway run the PREBUILT, cosign-verified release
 * images, pinned by digest (CLAUDE.md §11.C: "a PR that requires the user to
 * run docker build is a regression"). Nothing of a Caelo source checkout is
 * mounted. The digest pin is what `upgrade` moves; a tag would let a
 * `docker compose pull` change the running release behind the operator's
 * back. Contributors who want their working tree in the containers ask for
 * {@link DevImages} explicitly (`init --dev`) — never the default.
 *
 * #707 — no `container_name`: Compose names containers per project, so an
 * install can share a host with other stacks (a fixed `caelo-postgres`
 * collides with the contributor dev stack's container of that name). Every
 * CLI command addresses containers by service name (`docker compose exec`).
 * Backups are `pg_dump`s plus the media and site files (self-hosted-backup.ts);
 * there is no pgBackRest sidecar — it never had access to the data volume.
 * No MinIO either: nothing in Caelo used it (media live in `.caelo/media/`),
 * and its `minio/minio` image is no longer published, so the service made
 * every fresh `docker compose up` fail.
 */

import { CADDY_REDIRECTS_FILE } from "@caelo-cms/shared";
import { caddyRedirectReloadCommand } from "./caddy-redirects.js";
import {
  ADMIN_MEMORY_DEFAULT,
  GATEWAY_TRUSTED_PROXY_HOPS,
  memoryQuantityMiB,
  publicSiteUrl,
  TRUSTED_PROXY_HOPS_ENV,
} from "./stack-contract.js";
import { ghcrRepository, isImageDigest, type ReleaseService } from "./upgrade/release-images.js";

/** The admin + gateway release images, each `ghcr.io/caelo-cms/<svc>@sha256:…`. */
export interface ReleaseImages {
  readonly mode: "release";
  readonly admin: string;
  readonly gateway: string;
}

/**
 * Contributor-only: run the admin + gateway from the Caelo checkout the
 * `.caelo/` dir lives in (bind mount on `oven/bun`). Never for an end-user
 * install — it needs the repo and builds nothing reproducible.
 */
export interface DevImages {
  readonly mode: "dev";
}

export type ComposeImages = ReleaseImages | DevImages;

/** The admin's HTTP port inside the Compose network (the Caddyfile proxies to it). */
export const COMPOSE_ADMIN_PORT = 5173;
/** `.caelo/<this>/` holds the pending Owner-bootstrap token the admin consumes. */
export const BOOTSTRAP_DIR = "bootstrap";

/**
 * Where the host's `.caelo/output/` appears in the admin (read-write, the
 * generator's output root) and in Caddy (read-only). The seeded deploy
 * targets' `out_dir` (`output/<env>`) resolves below it, which is where the
 * Caddyfile's site roots point (`/srv/caelo/output/<env>/current`).
 */
export const SITE_OUTPUT_ROOT = "/srv/caelo";

/**
 * #587 — every site's redirect snippet as Caddy sees it (one per deploy
 * target below {@link SITE_OUTPUT_ROOT}); the Caddy container reloads when
 * any of them changes (caddy-redirects.ts).
 */
export const COMPOSE_REDIRECT_SNIPPETS = `${SITE_OUTPUT_ROOT}/output/*/current/${CADDY_REDIRECTS_FILE}`;

/** `.caelo/<this>/` holds the uploaded media (the admin's local media adapter root). */
export const MEDIA_DIR = "media";
/** Where {@link MEDIA_DIR} appears in the admin container (its `MEDIA_ROOT_DIR`). */
export const MEDIA_ROOT = "/data/media";

/** The gateway's HTTP port inside the Compose network. */
export const COMPOSE_GATEWAY_PORT = 8090;

/**
 * The Compose services that run Caelo code — what `restore` stops while it
 * rewrites the databases, and what the health checks probe. Workers run
 * inside the admin (CLAUDE.md §11.B Tier 5); there is no orchestrator or
 * runner service.
 */
export const COMPOSE_APP_SERVICES = ["caelo-admin", "caelo-gateway"] as const;

/**
 * Where Caddy reaches the admin and the gateway: their Compose service
 * names. Caddy runs in its own container, so `localhost` there is Caddy
 * itself (issue #707).
 */
export const COMPOSE_ADMIN_UPSTREAM = `caelo-admin:${COMPOSE_ADMIN_PORT}`;
export const COMPOSE_GATEWAY_UPSTREAM = `caelo-gateway:${COMPOSE_GATEWAY_PORT}`;

/**
 * The Caddy image, pinned to the release the generated Caddyfile is
 * validated against (caddy-validate.test.ts runs `caddy validate` on this
 * exact image in CI). A floating `caddy:2-alpine` could pick up a Caddy
 * that rejects the config on the next `docker compose pull`.
 */
export const CADDY_IMAGE = "caddy:2.11.7-alpine";

/** The host ports Caddy publishes for HTTP and HTTPS. */
export interface PublishedPorts {
  readonly http: number;
  readonly https: number;
}

/**
 * The Compose project an install's containers, network and volumes belong
 * to, emitted as the file's top-level `name`. Without it Compose names the
 * project after the directory holding the file — `.caelo` → `caelo` for
 * every install, so two installs on one host would share containers and
 * the database volume. New installs get one per domain; installs from
 * before this was stored keep `caelo`, the name their volumes carry.
 */
export function composeProjectName(domain: string): string {
  return `caelo-${domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}

/** Whether `name` is a Compose project name (lowercase, digits, `-`, `_`; leading letter or digit). */
export function isComposeProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

/** `https://<domain>`, with the published HTTPS port when it is not 443. */
export function selfHostedSiteUrl(domain: string, httpsPort: number): string {
  return httpsPort === 443 ? publicSiteUrl(domain) : `${publicSiteUrl(domain)}:${httpsPort}`;
}

/** Whether `port` can be published on the host (any TCP port). */
export function isPublishablePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * `ghcr.io/caelo-cms/<service>@<digest>` — the only image reference shape a
 * release-mode Compose file accepts.
 */
export function ghcrImageRef(service: ReleaseService, digest: string): string {
  if (!isImageDigest(digest)) throw new Error(`not an image digest: ${JSON.stringify(digest)}`);
  return `${ghcrRepository(service)}@${digest}`;
}

/**
 * The digest of a release image reference, or null when `ref` is not a
 * digest-pinned reference to that service's Caelo repository.
 */
export function ghcrImageDigest(service: ReleaseService, ref: string): string | null {
  const prefix = `${ghcrRepository(service)}@`;
  if (!ref.startsWith(prefix)) return null;
  const digest = ref.slice(prefix.length);
  return isImageDigest(digest) ? digest : null;
}

/**
 * The application roles' passwords (bootstrap.sh creates the roles with
 * them). One per role, so the gateway — which gets only the public login —
 * never holds admin_role's (#613, #635, CLAUDE.md §2). An install's
 * config.json from before #635 still carries a `gateway` entry; it is
 * ignored.
 */
export interface RolePasswords {
  readonly admin: string;
  readonly public: string;
}

export interface ComposeSpec {
  readonly domain: string;
  /** The Postgres superuser's; only the database container uses it. */
  readonly postgresPassword: string; // generated by cms-provision; persisted in .caelo/secrets
  readonly rolePasswords: RolePasswords;
  /**
   * P18 — project KEK (32 bytes hex) for at-rest encryption of AI provider
   * keys + future secrets. Generated per install by cms-provision; persisted
   * in `.caelo/secrets`. NEVER prompt the operator for this — auto-generated
   * via the same randomHex(32) the GCP stack uses.
   */
  readonly caeloSecretKek: string;
  readonly anthropicApiKey?: string;
  readonly resendApiKey?: string;
  readonly diskSize: string;
  /**
   * #553 — memory reserved for the admin (it runs the Lighthouse quality
   * audit). Same `adminMemory` knob + default as every adapter
   * (stack-contract.ts); compose reserves it rather than capping it, so a
   * busy host never OOM-kills the admin at the limit.
   */
  readonly adminMemory?: string;
  /** Which admin + gateway images run (see {@link ComposeImages}). */
  readonly images: ComposeImages;
  /**
   * The host ports Caddy listens on (`80` / `443` for a public install —
   * ACME's HTTP and TLS-ALPN challenges need exactly those).
   */
  readonly ports: PublishedPorts;
  /** The Compose project ({@link composeProjectName}). */
  readonly project: string;
  /**
   * #696 Phase 4c — the host update agent's database login, when the agent
   * is set up: Postgres is then also published on `127.0.0.1:<dbPort>` (never
   * on another interface) for the agent on the host, and bootstrap.sh
   * creates the `caelo_agent` role from `AGENT_ROLE_PASSWORD`.
   */
  readonly agent?: ComposeAgent;
}

/** The host agent's side of the Compose file (see {@link ComposeSpec.agent}). */
export interface ComposeAgent {
  readonly dbPort: number;
  readonly dbPassword: string;
}

/** The only interface the agent's Postgres port is published on. */
export const AGENT_DB_BIND_ADDRESS = "127.0.0.1";

export function generateDockerCompose(spec: ComposeSpec): string {
  const adminMemory = spec.adminMemory ?? ADMIN_MEMORY_DEFAULT;
  const adminMemoryMiB = memoryQuantityMiB(adminMemory);
  if (adminMemoryMiB === null) {
    throw new Error(`adminMemory "${adminMemory}" is not a memory quantity (e.g. 2Gi)`);
  }
  const env = (k: string, v: string | undefined): string =>
    v ? `      ${k}: "${escapeYaml(v)}"` : "";
  for (const port of [spec.ports.http, spec.ports.https]) {
    if (!isPublishablePort(port)) throw new Error(`port ${port} is not a TCP port`);
  }
  if (!isComposeProjectName(spec.project)) {
    throw new Error(`${JSON.stringify(spec.project)} is not a Compose project name`);
  }
  if (spec.ports.http === spec.ports.https) {
    throw new Error(`HTTP and HTTPS cannot share port ${spec.ports.http}`);
  }
  if (spec.agent && !isAgentDbPort(spec.agent.dbPort)) {
    throw new Error(`agent dbPort ${spec.agent.dbPort} is not a TCP port between 1024 and 65535`);
  }
  return `# SPDX-License-Identifier: MPL-2.0
# Generated by cms-provision — do not edit; re-run \`bunx cms-provision up\`.
# Domain: ${spec.domain}

name: ${spec.project}

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: "${escapeYaml(spec.postgresPassword)}"
      POSTGRES_USER: caelo
      POSTGRES_DB: caelo
      ADMIN_ROLE_PASSWORD: "${escapeYaml(spec.rolePasswords.admin)}"
      PUBLIC_ROLE_PASSWORD: "${escapeYaml(spec.rolePasswords.public)}"
${postgresAgent(spec.agent)}    volumes:
      - caelo-pg:/var/lib/postgresql/data
      - ./bootstrap.sh:/docker-entrypoint-initdb.d/00_bootstrap.sh:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U caelo"]
      interval: 10s
      timeout: 5s
      retries: 5

  caddy:
    image: ${CADDY_IMAGE}
    # #587 — Caddy plus a loop that reloads it when a deploy changes a
    # site's _redirects.caddy import (caddy-redirects.ts).
    ${caddyRedirectReloadCommand(COMPOSE_REDIRECT_SNIPPETS)}
    restart: unless-stopped
    ports: ["${spec.ports.http}:80", "${spec.ports.https}:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caelo-caddy-data:/data
      - caelo-caddy-config:/config
      - ./output:${SITE_OUTPUT_ROOT}:ro

${adminService(spec, adminMemoryMiB, env)}

${gatewayService(spec)}

volumes:
  caelo-pg:
  caelo-caddy-data:
  caelo-caddy-config:
`;
}

type EnvLine = (k: string, v: string | undefined) => string;

/** Whether `port` may carry the agent's Postgres (unprivileged TCP port). */
export function isAgentDbPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/**
 * The agent's lines in the postgres service: its role password for
 * bootstrap.sh, and the port on the host's loopback interface only — the
 * agent runs on the host, and nothing else may reach the database.
 */
function postgresAgent(agent: ComposeAgent | undefined): string {
  if (!agent) return "";
  return [
    `      AGENT_ROLE_PASSWORD: "${escapeYaml(agent.dbPassword)}"`,
    "    # The host update agent (cms-provision agent): loopback only.",
    `    ports: ["${AGENT_DB_BIND_ADDRESS}:${agent.dbPort}:5432"]`,
    "",
  ].join("\n");
}

/**
 * How a Caelo service's container starts: its image and, in dev mode, the
 * checkout. `mounts` are extra bind mounts the service needs in both modes.
 */
function serviceRuntime(
  images: ComposeImages,
  service: ReleaseService,
  devCommand: string,
  mounts: readonly string[] = [],
): string {
  const volumes = (list: readonly string[]) =>
    list.length === 0 ? [] : ["    volumes:", ...list.map((m) => `      - ${m}`)];
  if (images.mode === "dev") {
    return [
      "    # DEV MODE (cms-provision init --dev): runs the Caelo checkout this",
      "    # .caelo/ dir lives in. Contributors only — never an end-user install.",
      "    image: oven/bun:1.4.2",
      "    working_dir: /app",
      `    command: ${devCommand}`,
      ...volumes(["../..:/app", ...mounts]),
    ].join("\n");
  }
  const digest = ghcrImageDigest(service, images[service]);
  if (!digest) {
    throw new Error(
      `${service} image ${JSON.stringify(images[service])} is not ${ghcrRepository(service)}@sha256:<digest>`,
    );
  }
  // The image's own CMD starts the service; no source is mounted.
  return [`    image: ${ghcrImageRef(service, digest)}`, ...volumes(mounts)].join("\n");
}

function adminService(spec: ComposeSpec, adminMemoryMiB: number, env: EnvLine): string {
  return `  caelo-admin:
${serviceRuntime(
  spec.images,
  "admin",
  `sh -c "cd apps/admin && bunx svelte-kit sync && bun --bun vite dev --host 0.0.0.0 --port ${COMPOSE_ADMIN_PORT}"`,
  // The Owner-bootstrap token handoff: `init` writes the token to
  // `.caelo/bootstrap/pending-token.json`; the admin reads (and deletes) it
  // from `/app/.caelo/` on first boot (hooks.server.ts). Only that dir is
  // mounted — never `.caelo/` itself, which holds config.json's superuser
  // password. Without the token /setup accepts any first Owner.
  // The static site: the admin builds into it (CAELO_OUTPUT_ROOT below),
  // Caddy serves it read-only from the same host dir. On the host, so a
  // recreated admin (upgrade) keeps the published site.
  // Uploaded media (MEDIA_ROOT_DIR below) likewise lives on the host.
  [
    `./${BOOTSTRAP_DIR}:/app/.caelo`,
    `./output:${SITE_OUTPUT_ROOT}`,
    `./${MEDIA_DIR}:${MEDIA_ROOT}`,
  ],
)}
    restart: unless-stopped
    depends_on:
      postgres: { condition: service_healthy }
    mem_reservation: ${adminMemoryMiB}m
    environment:
      ADMIN_DATABASE_URL: "${dbUrl("admin_role", spec.rolePasswords.admin, "cms_admin")}"
      PUBLIC_ADMIN_DATABASE_URL: "${dbUrl("admin_role", spec.rolePasswords.admin, "cms_public")}"
      CAELO_SECRET_KEK: "${escapeYaml(spec.caeloSecretKek)}"
      CAELO_SITE_URL: "${escapeYaml(selfHostedSiteUrl(spec.domain, spec.ports.https))}"
      PORT: "${COMPOSE_ADMIN_PORT}"
      CAELO_OUTPUT_ROOT: "${SITE_OUTPUT_ROOT}"
      MEDIA_ROOT_DIR: "${MEDIA_ROOT}"
      CAELO_PROVIDER: "self-hosted"
      NODE_ENV: production
${env("ANTHROPIC_API_KEY", spec.anthropicApiKey)}
${env("RESEND_API_KEY", spec.resendApiKey)}`;
}

function gatewayService(spec: ComposeSpec): string {
  return `  caelo-gateway:
${serviceRuntime(spec.images, "gateway", "bun run apps/api-gateway/src/server.ts")}
    restart: unless-stopped
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      # public_role on cms_public is its only database login (#613, #635,
      # CLAUDE.md §2: the public side has no path to the authoring database).
      PUBLIC_DATABASE_URL: "${dbUrl("public_role", spec.rolePasswords.public, "cms_public")}"
      GATEWAY_PORT: "${COMPOSE_GATEWAY_PORT}"
      # Caddy is the one proxy in front (client-ip.ts in the gateway).
      ${TRUSTED_PROXY_HOPS_ENV}: "${GATEWAY_TRUSTED_PROXY_HOPS["self-hosted"]}"
      # #806 — no remote MCP here: it rides Google IAP, which this install
      # does not have. CAELO_ADMIN_URL / CAELO_MCP_PUBLIC_URL /
      # CAELO_MCP_OAUTH_CLIENT_FILE stay unset, so the gateway's /api/mcp/*
      # answers 503 remote_mcp_not_configured and Settings → MCP says
      # "not available on this install".
      NODE_ENV: production`;
}

/** A compose-network database URL, password URL-encoded and YAML-escaped. */
function dbUrl(role: string, password: string, database: string): string {
  return escapeYaml(`postgres://${role}:${encodeURIComponent(password)}@postgres:5432/${database}`);
}

function escapeYaml(s: string): string {
  // Conservative escape for double-quoted YAML strings.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
