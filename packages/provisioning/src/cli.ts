#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * cms-provision — Caelo's self-hosted provisioning CLI.
 *
 * Sub-commands:
 *   init [--domain D --owner-email E]  — first-time setup; generates
 *                                         secrets, writes .caelo/, runs
 *                                         `docker compose up -d`, prints
 *                                         the bootstrap token URL.
 *   up                                  — re-runs against existing config.
 *   regenerate-caddy                    — re-emits Caddyfile from the
 *                                         domains table; runs `caddy reload`.
 *   backup --to <path>                  — pgBackRest full + MinIO mirror →
 *                                         single .tar.zst.
 *   restore --from <path>               — wipes target + restores.
 *   status                              — prints container health + cert
 *                                         expiry per domain.
 *
 * Pulumi-driven cloud variants (GCP / AWS / Azure) land in P15 and
 * plug into the same CLI via `--provider <name>`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateBootstrapToken } from "./bootstrap-token.js";
import { type CaddyDomainSpec, generateCaddyfile } from "./caddy.js";
import { generateDockerCompose } from "./compose.js";

interface CaeloConfig {
  domain: string;
  ownerEmail: string;
  postgresPassword: string;
  minioRootUser: string;
  minioRootPassword: string;
  /**
   * P18 — project KEK (32 hex bytes). Auto-generated on `cms-provision init`,
   * persisted in `.caelo/config.json`, mounted into the admin + gateway
   * containers as CAELO_SECRET_KEK so the AES-GCM secret-box can decrypt
   * stored AI provider keys. Optional in the type so config.json files
   * generated before P18 still load — emitConfig() back-fills if missing.
   */
  caeloSecretKek?: string;
  anthropicApiKey?: string;
  resendApiKey?: string;
}

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CAELO_DIR = resolve(REPO_ROOT, ".caelo");
const CONFIG_PATH = resolve(CAELO_DIR, "config.json");
const COMPOSE_PATH = resolve(CAELO_DIR, "docker-compose.yml");
const CADDYFILE_PATH = resolve(CAELO_DIR, "Caddyfile");
const PENDING_TOKEN_PATH = resolve(CAELO_DIR, "pending-token.json");
// P15 — `cms-provision init --provider <name>` writes here so subsequent
// commands route to the right Pulumi stack. Defaults to "self-hosted"
// when missing (preserves the P14 path).
const PROVIDER_PATH = resolve(CAELO_DIR, "provider.json");

type Provider = "self-hosted" | "gcp" | "aws" | "azure";

function loadProvider(): Provider {
  if (!existsSync(PROVIDER_PATH)) return "self-hosted";
  try {
    const raw = JSON.parse(readFileSync(PROVIDER_PATH, "utf8")) as { provider?: string };
    return (raw.provider as Provider) ?? "self-hosted";
  } catch {
    return "self-hosted";
  }
}

function saveProvider(provider: Provider): void {
  if (!existsSync(CAELO_DIR)) mkdirSync(CAELO_DIR, { recursive: true });
  writeFileSync(PROVIDER_PATH, JSON.stringify({ provider }, null, 2));
}

/**
 * P15 review pass — guard for commands that only make sense on
 * self-hosted (compose/caddy generation, backup/restore via docker
 * exec). Cloud installs (gcp/aws/azure) get a Pulumi-flow message
 * pointing at the right stack dir + the pulumi-output-sync follow-up.
 * Exits the process when the active provider is non-self-hosted.
 */
function requireSelfHosted(commandName: string): void {
  const provider = loadProvider();
  if (provider === "self-hosted") return;
  console.error(
    `cms-provision ${commandName}: only available for --provider=self-hosted (active provider: ${provider}).\n\n` +
      `For cloud installs, use Pulumi directly:\n` +
      `  cd packages/provisioning/stacks/${provider}\n` +
      `  pulumi up\n` +
      `  bunx cms-provision pulumi-output-sync\n`,
  );
  process.exit(2);
}

function randomSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function loadConfig(): CaeloConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as CaeloConfig;
}

function saveConfig(c: CaeloConfig): void {
  if (!existsSync(CAELO_DIR)) mkdirSync(CAELO_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function emitConfig(cfg: CaeloConfig, extraDomains: CaddyDomainSpec[] = []): void {
  // Back-fill caeloSecretKek for installs created before P18. Persists
  // immediately so the next emitConfig run sees the same value (existing
  // encrypted ai_providers rows would otherwise become un-decryptable).
  if (!cfg.caeloSecretKek) {
    cfg.caeloSecretKek = randomSecret(32);
    saveConfig(cfg);
  }
  // Generate compose + Caddyfile from the canonical config.
  const compose = generateDockerCompose({
    domain: cfg.domain,
    postgresPassword: cfg.postgresPassword,
    minioRootUser: cfg.minioRootUser,
    minioRootPassword: cfg.minioRootPassword,
    caeloSecretKek: cfg.caeloSecretKek,
    anthropicApiKey: cfg.anthropicApiKey,
    resendApiKey: cfg.resendApiKey,
    diskSize: "20Gi",
  });
  writeFileSync(COMPOSE_PATH, compose);
  // Seed the install with the operator's primary domain plus a staging
  // sibling. Extra domains added via /security/domains are appended by
  // regenerate-caddy when it queries the live domains table.
  const baseDomains: CaddyDomainSpec[] = [
    { hostname: cfg.domain, kind: "admin", env: "production" },
    { hostname: cfg.domain, kind: "public", env: "production" },
    { hostname: `staging.${cfg.domain}`, kind: "public", env: "staging" },
  ];
  const caddy = generateCaddyfile({
    ownerEmail: cfg.ownerEmail,
    publicSiteRoot: "/srv/caelo/output/production/current",
    stagingSiteRoot: "/srv/caelo/output/staging/current",
    adminPort: 5173,
    gatewayPort: 8090,
    domains: dedupeDomains([...baseDomains, ...extraDomains]),
  });
  writeFileSync(CADDYFILE_PATH, caddy);
}

function dedupeDomains(list: CaddyDomainSpec[]): CaddyDomainSpec[] {
  // Two domain entries with the same (hostname, kind) collapse to the
  // first occurrence — the seed wins over operator additions on a
  // collision (which keeps admin routing intact even if someone adds
  // their primary domain via the UI by mistake).
  const seen = new Set<string>();
  const out: CaddyDomainSpec[] = [];
  for (const d of list) {
    const key = `${d.hostname}::${d.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

async function init(): Promise<void> {
  const domain = arg("domain");
  const ownerEmail = arg("owner-email");
  const providerArg = (arg("provider") ?? "self-hosted") as Provider;
  if (!["self-hosted", "gcp", "aws", "azure"].includes(providerArg)) {
    console.error(`Unknown --provider ${providerArg}. Choose self-hosted | gcp | aws | azure.`);
    process.exit(2);
  }
  if (!domain || !ownerEmail) {
    console.error(
      "Usage: cms-provision init [--provider gcp|aws|azure|self-hosted] --domain example.com --owner-email me@example.com",
    );
    process.exit(2);
  }
  if (existsSync(CONFIG_PATH)) {
    console.error(`config already exists at ${CONFIG_PATH}; run \`cms-provision up\` to re-deploy`);
    process.exit(2);
  }
  saveProvider(providerArg);
  if (providerArg !== "self-hosted") {
    // Cloud providers run via Pulumi at packages/provisioning/stacks/<provider>/.
    // The CLI doesn't generate compose/caddy for them — point the operator at
    // the Pulumi flow directly.
    console.log(`Provider: ${providerArg}`);
    console.log(
      `\nNext steps:\n  cd packages/provisioning/stacks/${providerArg}\n  pulumi stack init prod\n  pulumi config set caelo-${providerArg}:domain ${domain}\n  pulumi config set caelo-${providerArg}:ownerEmail ${ownerEmail}\n  pulumi up\n  bunx cms-provision pulumi-output-sync\n`,
    );
    return;
  }
  const cfg: CaeloConfig = {
    domain,
    ownerEmail,
    postgresPassword: randomSecret(32),
    minioRootUser: "caelo",
    minioRootPassword: randomSecret(32),
    caeloSecretKek: randomSecret(32),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    resendApiKey: process.env.RESEND_API_KEY,
  };
  saveConfig(cfg);
  emitConfig(cfg);

  // Mint the bootstrap token and stage it for hooks.server.ts to insert
  // on first request. The CLI doesn't talk to Postgres directly because
  // the DB hasn't started yet; the admin app picks the token up on its
  // first boot, calls owner_bootstrap_tokens.insert, then deletes the
  // staging file.
  const tok = generateBootstrapToken();
  writeFileSync(PENDING_TOKEN_PATH, JSON.stringify(tok, null, 2));

  // P15.1 — mint the shared HMAC secret for /api/internal/* endpoints.
  // Same secret is read by:
  //   - admin app (process.env.CAELO_INTERNAL_SECRET, set by docker-compose
  //     or the Pulumi cloud stack via secret env var),
  //   - cms-provision pulumi-output-sync (when running in CI / by hand),
  //   - any future internal-only orchestration.
  // Long enough to defeat brute-force; rotation via `pulumi config set
  // --secret caelo-internal-secret <new>` + `pulumi up` for cloud installs.
  const internalSecret = randomSecret(48);
  const internalSecretPath = resolve(CAELO_DIR, "internal-secret.json");
  writeFileSync(internalSecretPath, JSON.stringify({ secret: internalSecret }, null, 2));
  console.log(`Wrote ${COMPOSE_PATH}`);
  console.log(`Wrote ${CADDYFILE_PATH}`);
  console.log(`Wrote ${PENDING_TOKEN_PATH} (admin will insert on first boot)`);
  console.log("");
  console.log("Next steps:");
  console.log(`  cd ${CAELO_DIR}`);
  console.log("  docker compose up -d");
  console.log("  # Wait ~30s for Postgres + Caddy + ACME");
  console.log("");
  console.log("Then visit:");
  console.log(`  https://${domain}/setup?token=${tok.token}`);
  console.log(`  (token expires ${tok.expiresAt})`);
}

async function up(): Promise<void> {
  requireSelfHosted("up");
  const cfg = loadConfig();
  if (!cfg) {
    console.error("no config — run `cms-provision init` first");
    process.exit(2);
  }
  emitConfig(cfg, await tryFetchExtraDomains(cfg));
  console.log(`Re-emitted ${COMPOSE_PATH} + ${CADDYFILE_PATH}`);
  console.log("Run `docker compose -f .caelo/docker-compose.yml up -d` to apply.");
}

interface DomainRow {
  hostname: string;
  kind: "admin" | "public" | "locale-public";
  env: "production" | "staging";
  localeCode?: string | null;
}

/**
 * Pull operator-added domains directly from Postgres so the regenerated
 * Caddyfile picks them up. Uses `docker compose exec` so we don't need
 * the operator's host to have psql installed. Fails open: a DB-down
 * install still emits the seed Caddyfile so the admin stays reachable.
 */
async function tryFetchExtraDomains(cfg: CaeloConfig): Promise<CaddyDomainSpec[]> {
  try {
    const composeFile = COMPOSE_PATH;
    const sql =
      "SELECT hostname, kind, env, locale_code FROM domains WHERE removed_at IS NULL ORDER BY hostname";
    const proc = Bun.spawn(
      [
        "docker",
        "compose",
        "-f",
        composeFile,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "caelo",
        "-d",
        "caelo",
        "-At",
        "-F",
        "|",
        "-c",
        sql,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, PGPASSWORD: cfg.postgresPassword } },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) {
      console.warn("regenerate-caddy: could not query domains table (DB down?); using seed only");
      return [];
    }
    const rows: DomainRow[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [hostname, kind, env, localeCode] = line.split("|");
      if (!hostname || !kind || !env) continue;
      rows.push({
        hostname,
        kind: kind as DomainRow["kind"],
        env: env as DomainRow["env"],
        localeCode: localeCode || null,
      });
    }
    return rows.map<CaddyDomainSpec>((r) =>
      r.kind === "locale-public" && r.localeCode
        ? { hostname: r.hostname, kind: "locale-public", localeCode: r.localeCode, env: r.env }
        : { hostname: r.hostname, kind: r.kind as "admin" | "public", env: r.env },
    );
  } catch (e) {
    console.warn("regenerate-caddy: domains lookup threw (DB unreachable?); using seed only", e);
    return [];
  }
}

async function regenerateCaddy(): Promise<void> {
  requireSelfHosted("regenerate-caddy");
  const cfg = loadConfig();
  if (!cfg) {
    console.error("no config — run `cms-provision init` first");
    process.exit(2);
  }
  const extra = await tryFetchExtraDomains(cfg);
  emitConfig(cfg, extra);
  console.log(`Re-emitted ${CADDYFILE_PATH} (${extra.length} domain(s) from DB).`);
  // Reload caddy in-place — no downtime, picks up cert provisioning for
  // any new domains automatically via ACME.
  const proc = Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      COMPOSE_PATH,
      "exec",
      "caddy",
      "caddy",
      "reload",
      "--config",
      "/etc/caddy/Caddyfile",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  await proc.exited;
  if (proc.exitCode !== 0) {
    console.warn(
      "caddy reload exited non-zero — Caddyfile written, run reload manually once the container is up.",
    );
  }
}

async function status(): Promise<void> {
  const provider = loadProvider();
  console.log(`Active provider: ${provider}`);
  if (provider !== "self-hosted") {
    console.log(`Stack dir:        packages/provisioning/stacks/${provider}`);
    console.log(`State + outputs:  pulumi stack output (run from the stack dir)`);
    console.log(`Cert + DNS:       visit /security/dns in the admin`);
    return;
  }
  const cfg = loadConfig();
  if (!cfg) {
    console.error("no config");
    process.exit(2);
  }
  console.log(`Caelo install: ${cfg.domain}`);
  console.log(`Owner email:   ${cfg.ownerEmail}`);
  console.log(`Config path:   ${CONFIG_PATH}`);
  console.log("Container health: run `docker compose -f .caelo/docker-compose.yml ps`");
  console.log("Cert status:      visit /security/domains in the admin");
}

async function backup(): Promise<void> {
  requireSelfHosted("backup");
  const cfg = loadConfig();
  if (!cfg) {
    console.error("no config");
    process.exit(2);
  }
  const to = arg("to") ?? resolve(process.cwd(), `caelo-backup-${Date.now()}.tar.zst`);
  console.log(`Backup target: ${to}`);

  // 1. pgBackRest full backup inside the sidecar container.
  console.log("Step 1/3: pgBackRest full backup …");
  const pgb = Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      COMPOSE_PATH,
      "exec",
      "-T",
      "pgbackrest",
      "pgbackrest",
      "--type=full",
      "--stanza=caelo",
      "backup",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  await pgb.exited;
  if (pgb.exitCode !== 0) {
    console.error("pgBackRest backup failed; aborting");
    process.exit(pgb.exitCode ?? 1);
  }

  // 2. MinIO mirror to a tmp inside the minio container.
  console.log("Step 2/3: mirroring MinIO bucket …");
  const mc = Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      COMPOSE_PATH,
      "exec",
      "-T",
      "minio",
      "mc",
      "mirror",
      "--overwrite",
      "/data",
      "/tmp/minio-backup",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  await mc.exited;
  if (mc.exitCode !== 0) {
    console.error("MinIO mirror failed; aborting");
    process.exit(mc.exitCode ?? 1);
  }

  // 3. tar+zstd from named volumes onto the host.
  console.log(`Step 3/3: archiving → ${to}`);
  const tar = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "-v",
      "caelo_caelo-pg-backups:/pgb:ro",
      "-v",
      "caelo_caelo-minio:/minio:ro",
      "-v",
      `${resolve(to, "..")}:/out`,
      "alpine:3",
      "sh",
      "-c",
      `apk add --no-cache zstd tar >/dev/null && tar --zstd -cf /out/${to.split("/").pop()} -C /pgb . -C /minio .`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  await tar.exited;
  if (tar.exitCode !== 0) {
    console.error("tar archive failed");
    process.exit(tar.exitCode ?? 1);
  }
  console.log(`Backup complete: ${to}`);
}

async function restore(): Promise<void> {
  requireSelfHosted("restore");
  const from = arg("from");
  if (!from) {
    console.error("Usage: cms-provision restore --from <path> [--yes]");
    process.exit(2);
  }
  if (!process.argv.includes("--yes")) {
    console.error(
      `DESTRUCTIVE: would restore from ${from}, wiping current pgbackrest + minio volumes. Re-run with --yes to confirm.`,
    );
    process.exit(1);
  }
  const cfg = loadConfig();
  if (!cfg) {
    console.error("no config");
    process.exit(2);
  }

  console.log(`Restoring from ${from} …`);
  // 1. Stop dependent services so they don't write while we restore.
  console.log("Step 1/4: stopping admin/gateway/orchestrator/runner …");
  await Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      COMPOSE_PATH,
      "stop",
      "caelo-admin",
      "caelo-gateway",
      "caelo-orchestrator",
      "caelo-runner",
    ],
    { stdout: "inherit", stderr: "inherit" },
  ).exited;

  // 2. Untar into the named volumes.
  console.log("Step 2/4: extracting archive into volumes …");
  const tarDir = resolve(from, "..");
  const tarFile = from.split("/").pop();
  const ex = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "-v",
      "caelo_caelo-pg-backups:/pgb",
      "-v",
      "caelo_caelo-minio:/minio",
      "-v",
      `${tarDir}:/in:ro`,
      "alpine:3",
      "sh",
      "-c",
      `apk add --no-cache zstd tar >/dev/null && rm -rf /pgb/* /minio/* && tar --zstd -xf /in/${tarFile} -C /pgb && tar --zstd -xf /in/${tarFile} -C /minio`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  await ex.exited;
  if (ex.exitCode !== 0) {
    console.error("extract failed");
    process.exit(ex.exitCode ?? 1);
  }

  // 3. pgBackRest restore.
  console.log("Step 3/4: pgBackRest restore …");
  const pgr = Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      COMPOSE_PATH,
      "exec",
      "-T",
      "pgbackrest",
      "pgbackrest",
      "--stanza=caelo",
      "restore",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  await pgr.exited;
  if (pgr.exitCode !== 0) {
    console.error("pgBackRest restore failed");
    process.exit(pgr.exitCode ?? 1);
  }

  // 4. Bring services back up.
  console.log("Step 4/4: restarting services …");
  await Bun.spawn(["docker", "compose", "-f", COMPOSE_PATH, "up", "-d"], {
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
  console.log("Restore complete.");
}

const cmd = process.argv[2];
/**
 * P15 — `pulumi-output-sync`. Reads `pulumi stack output --json` from
 * the active stack (cwd or --stack-dir), writes the rendered outputs
 * into cms_admin.provisioning_outputs via the local `psql` shell-out.
 * Run after every `pulumi up` so the admin's /security/dns page picks
 * up the latest snapshot.
 *
 * Self-hosted installs auto-skip — there's nothing useful to sync since
 * the outputs are static (single VM, single domain).
 */
async function pulumiOutputSync(): Promise<void> {
  const provider = loadProvider();
  if (provider === "self-hosted") {
    console.log("provider=self-hosted; nothing to sync (no Pulumi outputs)");
    return;
  }
  const stackDir = arg("stack-dir") ?? `packages/provisioning/stacks/${provider}`;
  const env = (arg("environment") ?? "production") as "dev" | "staging" | "production";
  if (!["dev", "staging", "production"].includes(env)) {
    console.error(`--environment must be dev | staging | production`);
    process.exit(2);
  }

  // 1. Read pulumi outputs.
  console.log(`Reading pulumi outputs from ${stackDir} …`);
  const pulumi = Bun.spawn(["pulumi", "stack", "output", "--json"], {
    cwd: resolve(REPO_ROOT, stackDir),
    stdout: "pipe",
    stderr: "inherit",
  });
  const stdout = await new Response(pulumi.stdout).text();
  await pulumi.exited;
  if (pulumi.exitCode !== 0) {
    console.error("pulumi stack output failed; aborting");
    process.exit(pulumi.exitCode ?? 1);
  }
  let outputs: Record<string, unknown>;
  try {
    outputs = JSON.parse(stdout);
  } catch (e) {
    console.error("pulumi stack output returned invalid JSON:", e);
    process.exit(1);
  }

  // 2. Mint a signed-JWT for the /api/internal/* endpoint.
  // P15.1 — admin's HTTP boundary requires a bearer token (CALEO_INTERNAL_SECRET
  // shared between Pulumi + admin). One short-lived token per sync call.
  const internalSecret = process.env.CAELO_INTERNAL_SECRET;
  const adminBaseUrl = process.env.CAELO_ADMIN_URL;
  if (!internalSecret || internalSecret.length < 32) {
    console.error(
      "CAELO_INTERNAL_SECRET not set or too short (need ≥32 chars). Pulumi mints this in `cms-provision init`; export it (or `pulumi stack output --show-secrets internalSecretOut`) and re-run.",
    );
    process.exit(2);
  }
  if (!adminBaseUrl) {
    console.error(
      "CAELO_ADMIN_URL not set (e.g. https://example.com). Required so the CLI knows where the admin lives.",
    );
    process.exit(2);
  }
  const iat = Date.now();
  const exp = iat + 5 * 60 * 1000; // 5min replay window
  const tokenScope = "provisioning-outputs.sync";
  const tokenMessage = `${iat}:${exp}:${tokenScope}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(internalSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(tokenMessage));
  const token = `${Buffer.from(tokenMessage).toString("base64url")}.${Buffer.from(sigBuf).toString("base64url")}`;

  // 3. POST to /api/internal/provisioning-outputs/sync.
  console.log(`Posting outputs to ${adminBaseUrl}/api/internal/provisioning-outputs/sync …`);
  const res = await fetch(`${adminBaseUrl}/api/internal/provisioning-outputs/sync`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ provider, environment: env, outputs }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`sync failed: ${res.status} ${res.statusText} — ${txt}`);
    process.exit(1);
  }
  const result = (await res.json()) as { ok?: boolean; updated?: boolean };
  console.log(`Synced ${provider}/${env} → ${result.updated === false ? "inserted" : "updated"}.`);
}

async function version(): Promise<void> {
  // P17.0 — single source of truth lives in @caelo-cms/shared/version.ts.
  // Imported lazily so the CLI's startup cost stays small.
  const { CAELO_VERSION } = await import("@caelo-cms/shared");
  console.log(`cms-provision (Caelo v${CAELO_VERSION})`);
}

const handlers: Record<string, () => Promise<void>> = {
  // Self-hosted P14 sub-commands (Docker Compose path)
  init,
  up,
  "regenerate-caddy": regenerateCaddy,
  // §11.C lifecycle dispatchers route by provider via install metadata.
  // Self-hosted bodies remain reachable as `<command>-self-hosted` for
  // back-compat scripts that bypassed the dispatcher.
  status: lifecycleStatus,
  "status-self-hosted": status,
  backup: lifecycleBackup,
  "backup-self-hosted": backup,
  restore,
  upgrade: lifecycleUpgrade,
  "rotate-secret": lifecycleRotateSecret,
  destroy: lifecycleDestroy,
  // Misc
  "pulumi-output-sync": pulumiOutputSync,
  version,
  "--version": version,
  "-v": version,
  // §11.C wizard — explicit invocation. Default routing (no cmd) also
  // lands here unless `--no-wizard` is passed.
  wizard: wizardCommand,
};

async function lifecycleStatus(): Promise<void> {
  const { statusCommand } = await import("./lifecycle.js");
  await statusCommand();
}
async function lifecycleUpgrade(): Promise<void> {
  const { upgradeCommand } = await import("./lifecycle.js");
  await upgradeCommand();
}
async function lifecycleBackup(): Promise<void> {
  const { backupCommand } = await import("./lifecycle.js");
  await backupCommand();
}
async function lifecycleRotateSecret(): Promise<void> {
  const { rotateSecretCommand } = await import("./lifecycle.js");
  await rotateSecretCommand(process.argv[3]);
}
async function lifecycleDestroy(): Promise<void> {
  const { destroyCommand } = await import("./lifecycle.js");
  await destroyCommand();
}

/**
 * §11.C — interactive wizard. Loaded lazily so the bare-CLI startup
 * cost stays small (clack + kleur are pulled in only when needed).
 * Reads `--provider`, `--domain`, `--owner-email`, `--project-id`, and
 * `--non-interactive` from argv when supplied.
 */
async function wizardCommand(): Promise<void> {
  const { runWizard } = await import("./wizard.js");
  await runWizard({
    nonInteractive: process.argv.includes("--non-interactive"),
    provider: arg("provider") as "self-hosted" | "gcp" | "aws" | "azure" | undefined,
    domain: arg("domain"),
    ownerEmail: arg("owner-email"),
    projectId: arg("project-id"),
  });
}

const handler = cmd ? handlers[cmd] : undefined;
if (!handler) {
  // §11.C — bare `cms-provision` (no sub-command) drops into the
  // wizard. The legacy "print usage" behaviour is preserved via
  // `--no-wizard` for scripts that depended on the old shape.
  if (cmd === undefined && !process.argv.includes("--no-wizard")) {
    await wizardCommand();
  } else {
    console.log(
      "Usage: cms-provision [wizard] | <init|up|status|upgrade|backup|restore|rotate-secret|destroy|regenerate-caddy|pulumi-output-sync|version> [options]\n" +
        "Pass --no-wizard with no sub-command to print this usage instead of the wizard.",
    );
    process.exit(cmd ? 2 : 0);
  }
} else {
  await handler();
}
