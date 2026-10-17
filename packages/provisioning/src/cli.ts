#!/usr/bin/env bun

// SPDX-License-Identifier: MPL-2.0

/**
 * cms-provision — Caelo's self-hosted provisioning CLI.
 *
 * Sub-commands:
 *   init [--domain D --owner-email E]  — first-time setup; generates
 *                                         secrets, resolves + cosign-verifies
 *                                         the release images, writes .caelo/,
 *                                         starts the stack (migrations
 *                                         included), health-checks it and
 *                                         prints the bootstrap token URL.
 *                                         `--provider self-hosted` with no
 *                                         sub-command runs this. `--dev` runs
 *                                         a Caelo checkout (contributors).
 *   up                                  — re-emits from the existing config
 *                                         and converges the running stack.
 *   migrate                             — applies DB migrations with the
 *                                         admin image the install runs.
 *   upgrade [--version X]               — verified, backed-up, health-checked
 *                                         image roll with rollback.
 *   agent install|status|logs|uninstall — the update agent (systemd --user
 *                                         timer) that installs the updates
 *                                         the Owner starts in the admin.
 *   regenerate-caddy                    — re-emits Caddyfile from the
 *                                         domains table; runs `caddy reload`.
 *   backup [--to <path>]                — pg_dump of both databases + the
 *                                         site + media files → one .tar.gz.
 *   restore --from <path> --yes         — replaces databases + files with
 *                                         a backup, restarts, health-checks.
 *   status                              — prints container health + cert
 *                                         expiry per domain.
 *
 * Pulumi-driven cloud variants (GCP / AWS / Azure) land in P15 and
 * plug into the same CLI via `--provider <name>`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAELO_VERSION,
  defaultStagingHost,
  normalizeStagingHost,
  stagingHostProblem,
} from "@caelo-cms/shared";
import type { AgentCliContext } from "./agent/command.js";
import type { AgentConfig } from "./agent/config.js";
import { generateBootstrapToken } from "./bootstrap-token.js";
import {
  type CaddyDomainSpec,
  type CaddyTlsMode,
  generateCaddyfile,
  selfHostedAdminHost,
  selfHostedSeedDomains,
} from "./caddy.js";
import { redactCredentials } from "./checkpoint-secrets.js";
import { cliUsage, initDelegatesToWizard, resolveCliRoute } from "./cli-routing.js";
import {
  BOOTSTRAP_DIR,
  COMPOSE_ADMIN_UPSTREAM,
  COMPOSE_GATEWAY_UPSTREAM,
  type ComposeImages,
  composeProjectName,
  generateDockerCompose,
  isPublishablePort,
  MEDIA_DIR,
  type PublishedPorts,
  type RolePasswords,
  SITE_OUTPUT_ROOT,
  selfHostedSiteUrl,
} from "./compose.js";
import { selfCommand } from "./self-command.js";
import {
  bunHostRunner,
  readRelease,
  recordRelease,
  releaseImages,
  resolveVerifiedRelease,
} from "./self-hosted-release.js";
import {
  convergeSelfHostedRoles,
  decideUp,
  selfHostedBootstrapScript,
} from "./self-hosted-roles.js";

interface CaeloConfig {
  domain: string;
  /**
   * #650 — the staging site's host (`--staging-domain`, default
   * `staging.<domain>`). Optional so older config.json files load;
   * emitConfig() back-fills the default.
   */
  stagingDomain?: string;
  ownerEmail: string;
  postgresPassword: string;
  /**
   * P18 — project KEK (32 hex bytes). Auto-generated on `cms-provision init`,
   * persisted in `.caelo/config.json`, mounted into the admin + gateway
   * containers as CAELO_SECRET_KEK so the AES-GCM secret-box can decrypt
   * stored AI provider keys. Optional in the type so config.json files
   * generated before P18 still load — emitConfig() back-fills if missing.
   */
  caeloSecretKek?: string;
  /**
   * #613 — one password per application role. Optional in the type so
   * config.json files from before still load; `up` back-fills them and
   * applies them to the database before any Compose URL uses them.
   */
  rolePasswords?: RolePasswords;
  /**
   * Whether the database's roles are known to carry `rolePasswords`: true
   * from `init` (bootstrap.sh applies them on the fresh volume's first
   * start), false for passwords `up` just back-filled, until applied.
   */
  rolesConverged?: boolean;
  anthropicApiKey?: string;
  resendApiKey?: string;
  /**
   * #696 — `dev` only for a contributor install made with `init --dev` (the
   * admin + gateway run the Caelo checkout, bind-mounted). Absent/`release`:
   * the prebuilt images recorded in `.caelo/release.json`.
   */
  imageMode?: "release" | "dev";
  /**
   * #696 Phase 4c — the host update agent (`cms-provision agent install`):
   * its database password and the loopback port Postgres is published on.
   */
  agent?: AgentConfig;
  /**
   * #707 — how Caddy gets certificates (`init --tls internal` for a LAN or
   * evaluation install without public DNS). Optional so older config.json
   * files load; loadConfig() back-fills `acme`, what they always ran.
   */
  tls?: CaddyTlsMode;
  /**
   * #707 — the host ports Caddy publishes (`init --http-port/--https-port`).
   * Optional so older config.json files load; loadConfig() back-fills 80/443.
   */
  ports?: PublishedPorts;
  /**
   * #707 — the Compose project (`name:` in the Compose file). Optional so
   * older config.json files load; loadConfig() back-fills `caelo`, the
   * project name Compose derived from `.caelo/` for them (their volumes
   * carry it).
   */
  composeProject?: string;
}

const REPO_ROOT = resolve(import.meta.dir, "../../..");
/**
 * Whether this CLI runs from a Caelo source checkout (contributor) rather
 * than from an installed package (`bunx @caelo-cms/provisioning` puts it in
 * a package cache, where `../../..` is a `node_modules` dir).
 */
const IN_REPO_CHECKOUT =
  existsSync(resolve(REPO_ROOT, "packages/provisioning/package.json")) &&
  existsSync(resolve(REPO_ROOT, "bun.lock"));
/**
 * The install's `.caelo/` dir: `$CAELO_SELF_HOSTED_DIR` when set; in a
 * checkout the repo's own `.caelo/` (dev mode bind-mounts `../..` from it);
 * otherwise `./.caelo` in the working directory — never inside a package
 * cache, which `bunx` may wipe.
 */
const CAELO_DIR = process.env.CAELO_SELF_HOSTED_DIR
  ? resolve(process.env.CAELO_SELF_HOSTED_DIR)
  : resolve(IN_REPO_CHECKOUT ? REPO_ROOT : process.cwd(), ".caelo");
const CONFIG_PATH = resolve(CAELO_DIR, "config.json");
const COMPOSE_PATH = resolve(CAELO_DIR, "docker-compose.yml");
const CADDYFILE_PATH = resolve(CAELO_DIR, "Caddyfile");
// What the Postgres container runs on its first start (compose.ts mounts it).
const BOOTSTRAP_SCRIPT_PATH = resolve(CAELO_DIR, "bootstrap.sh");
// The admin container mounts only `.caelo/bootstrap/` (compose.ts), never the
// secrets next to it, and consumes the token from there on first boot.
const PENDING_TOKEN_PATH = resolve(CAELO_DIR, BOOTSTRAP_DIR, "pending-token.json");
// P15 — `cms-provision init --provider <name>` writes here so subsequent
// commands route to the right Pulumi stack. Defaults to "self-hosted"
// when missing (preserves the P14 path).
const PROVIDER_PATH = resolve(CAELO_DIR, "provider.json");

type Provider = "self-hosted" | "gcp" | "gcp-firebase" | "aws" | "azure";

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
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as CaeloConfig;
  // #707 — settings added later, back-filled (and stored) with what every
  // install ran before they existed, so `upgrade` / `agent` render the same
  // Compose file as before.
  if (!cfg.tls || !cfg.ports || !cfg.composeProject) {
    cfg.tls ??= "acme";
    cfg.ports ??= { http: 80, https: 443 };
    cfg.composeProject ??= "caelo";
    saveConfig(cfg);
  }
  return cfg;
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

/** Fresh passwords for the two application roles. */
function newRolePasswords(): RolePasswords {
  return { admin: randomSecret(32), public: randomSecret(32) };
}

function emitConfig(cfg: CaeloConfig, extraDomains: CaddyDomainSpec[] = []): void {
  // Back-fill caeloSecretKek for installs created before P18. Persists
  // immediately so the next emitConfig run sees the same value (existing
  // encrypted ai_providers rows would otherwise become un-decryptable).
  if (!cfg.caeloSecretKek) {
    cfg.caeloSecretKek = randomSecret(32);
    saveConfig(cfg);
  }
  if (!cfg.stagingDomain) {
    cfg.stagingDomain = defaultStagingHost(cfg.domain);
    saveConfig(cfg);
  }
  if (!cfg.tls) throw new Error("config has no tls — it is back-filled on load; this is a bug");
  emitComposeFiles(cfg);
  // Seed the install with the admin host, the primary domain and the
  // staging host. Extra domains added via /settings/domains are appended by
  // regenerate-caddy when it queries the live domains table.
  const caddy = generateCaddyfile({
    ownerEmail: cfg.ownerEmail,
    tls: cfg.tls,
    publicSiteRoot: `${SITE_OUTPUT_ROOT}/output/production/current`,
    stagingSiteRoot: `${SITE_OUTPUT_ROOT}/output/staging/current`,
    // Caddy runs in its own container: the Compose service names, never
    // localhost (#707).
    adminUpstream: COMPOSE_ADMIN_UPSTREAM,
    gatewayUpstream: COMPOSE_GATEWAY_UPSTREAM,
    domains: dedupeDomains([
      ...selfHostedSeedDomains(cfg.domain, cfg.stagingDomain),
      ...extraDomains,
    ]),
  });
  writeFileSync(CADDYFILE_PATH, caddy);
}

/**
 * The Compose file and the bootstrap script Postgres runs on its first
 * start — what the agent commands re-write (never the Caddyfile, whose
 * operator-added domains only `up` / `regenerate-caddy` read back).
 */
function emitComposeFiles(cfg: CaeloConfig): void {
  writeFileSync(COMPOSE_PATH, renderCompose(cfg, installImages(cfg)), { mode: 0o600 });
  // No secrets (it reads the passwords from the container's environment),
  // and the postgres user inside the container must be able to read it.
  writeFileSync(
    BOOTSTRAP_SCRIPT_PATH,
    selfHostedBootstrapScript({ agent: activeAgent(cfg) !== undefined }),
    { mode: 0o755 },
  );
  // The bind-mounted content dirs, created by the CLI so Docker does not
  // create them root-owned on a Linux host.
  for (const dir of ["output", MEDIA_DIR]) mkdirSync(resolve(CAELO_DIR, dir), { recursive: true });
}

/** The Compose file for `cfg` running `images` (secrets come from config.json). */
function renderCompose(cfg: CaeloConfig, images: ComposeImages): string {
  if (!cfg.rolePasswords) {
    // `init` sets them and `up` back-fills + applies them before calling here.
    throw new Error("config has no rolePasswords — run `cms-provision up`");
  }
  if (!cfg.caeloSecretKek) throw new Error("config has no caeloSecretKek — run `cms-provision up`");
  if (!cfg.ports || !cfg.composeProject) {
    throw new Error(
      "config has no ports / composeProject — they are back-filled on load; this is a bug",
    );
  }
  return generateDockerCompose({
    domain: cfg.domain,
    postgresPassword: cfg.postgresPassword,
    rolePasswords: cfg.rolePasswords,
    caeloSecretKek: cfg.caeloSecretKek,
    anthropicApiKey: cfg.anthropicApiKey,
    resendApiKey: cfg.resendApiKey,
    diskSize: "20Gi",
    images,
    ports: cfg.ports,
    project: cfg.composeProject,
    ...(activeAgent(cfg) ? { agent: activeAgent(cfg) } : {}),
  });
}

/** The agent's settings while it is set up (not after `agent uninstall`). */
function activeAgent(cfg: CaeloConfig): AgentConfig | undefined {
  return cfg.agent && !cfg.agent.disabled ? cfg.agent : undefined;
}

/** What the `agent` commands need from this CLI's config handling. */
function agentContext(cfg: CaeloConfig): AgentCliContext {
  return {
    caeloDir: CAELO_DIR,
    domain: cfg.domain,
    imageMode: cfg.imageMode,
    agent: () => cfg.agent,
    saveAgent: (agent) => {
      if (agent) cfg.agent = agent;
      else delete cfg.agent;
      saveConfig(cfg);
    },
    emitConfig: () => emitComposeFiles(cfg),
    convergeRoles: () => {
      if (!cfg.rolePasswords) {
        return Promise.resolve({
          ok: false as const,
          reachable: true,
          error: "config.json has no role passwords — run `cms-provision up` first",
        });
      }
      return convergeSelfHostedRoles(cfg.rolePasswords, {
        probe: postgresIsUp,
        psql: superuserPsql,
        ...(activeAgent(cfg) ? { agentPassword: activeAgent(cfg)?.dbPassword } : {}),
      });
    },
    renderCompose: (images) => renderCompose(cfg, images),
    randomSecret: () => randomSecret(32),
  };
}

/** `agent <install|status|logs|uninstall|run|apply>` (agent/command.ts). */
async function agentCli(): Promise<void> {
  requireSelfHosted("agent");
  const cfg = loadConfig();
  if (!cfg) {
    console.error("no config — run `cms-provision init` first");
    process.exit(2);
  }
  const { agentCommand } = await import("./agent/command.js");
  process.exitCode = await agentCommand(process.argv, agentContext(cfg));
}

/**
 * The admin + gateway images the install runs: the checkout in dev mode,
 * else the digests recorded in release.json. An install with neither (made
 * before #696, still running the repo bind mount) is moved to the prebuilt
 * images by `upgrade` — no silent fallback to the bind mount.
 */
function installImages(cfg: CaeloConfig): ComposeImages {
  if (cfg.imageMode === "dev") return { mode: "dev" };
  const release = readRelease(CAELO_DIR);
  if (!release) {
    throw new Error(
      `${CAELO_DIR}/release.json records no release images. This install predates the prebuilt\n` +
        `images (it ran the repo bind mount): run \`${selfCommand("upgrade")}\` to move it to the signed\n` +
        'release images. (A contributor checkout that wants the bind mount sets "imageMode": "dev" in config.json.)',
    );
  }
  return releaseImages(release);
}

function dedupeDomains(list: CaddyDomainSpec[]): CaddyDomainSpec[] {
  // One vhost per hostname (Caddy refuses two site blocks for one address):
  // the first occurrence wins, so the seed wins over operator additions on
  // a collision (which keeps admin routing intact even if someone adds the
  // admin host via the UI as a public domain by mistake).
  const seen = new Set<string>();
  const out: CaddyDomainSpec[] = [];
  for (const d of list) {
    if (seen.has(d.hostname)) continue;
    seen.add(d.hostname);
    out.push(d);
  }
  return out;
}

/** `--http-port` / `--https-port` (default 80 / 443), or exit with a usage error. */
function portsArg(): PublishedPorts {
  const parse = (name: string, fallback: number): number => {
    const raw = arg(name);
    if (raw === undefined) return fallback;
    const port = Number(raw);
    if (!isPublishablePort(port)) {
      console.error(`--${name}: ${JSON.stringify(raw)} is not a TCP port`);
      process.exit(2);
    }
    return port;
  };
  return { http: parse("http-port", 80), https: parse("https-port", 443) };
}

/** `--tls acme|internal` (default acme), or exit with a usage error. */
function tlsArg(): CaddyTlsMode {
  const raw = arg("tls") ?? "acme";
  if (raw !== "acme" && raw !== "internal") {
    console.error(
      `--tls: ${JSON.stringify(raw)} — choose acme (public DNS) or internal (local CA)`,
    );
    process.exit(2);
  }
  return raw;
}

/** `https://<host>[:port]` for a host Caddy serves. */
function siteUrl(cfg: CaeloConfig, host: string): string {
  if (!cfg.ports)
    throw new Error("config has no ports — they are back-filled on load; this is a bug");
  return selfHostedSiteUrl(host, cfg.ports.https);
}

/**
 * Re-render the Caddyfile from config + the domains table and reload the
 * running Caddy (regenerate-caddy, restore).
 */
async function refreshCaddy(
  cfg: CaeloConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  emitConfig(cfg, await fetchExtraDomains());
  const { reloadCaddy } = await import("./self-hosted-start.js");
  return reloadCaddy(CAELO_DIR, bunHostRunner);
}

/**
 * Pull, start Postgres, migrate, start everything, health-check
 * (self-hosted-start.ts). Exits non-zero with the reason on failure; the
 * operator re-runs `up`, which converges from wherever it stopped.
 */
async function startStack(): Promise<void> {
  const { startSelfHosted } = await import("./self-hosted-start.js");
  const r = await startSelfHosted({
    caeloDir: CAELO_DIR,
    runner: bunHostRunner,
    log: (m) => console.log(`==> ${m}`),
  });
  if (!r.ok) {
    console.error(`\nThe install did not come up (${r.stage}): ${r.error}`);
    console.error(`Fix the cause and run \`${selfCommand("up")}\` — it continues from here.`);
    process.exit(1);
  }
}

async function init(): Promise<void> {
  const domain = arg("domain");
  const ownerEmail = arg("owner-email");
  const providerArg = (arg("provider") ?? "self-hosted") as Provider;
  if (!["self-hosted", "gcp", "gcp-firebase", "aws", "azure"].includes(providerArg)) {
    console.error(
      `Unknown --provider ${providerArg}. Choose self-hosted | gcp | gcp-firebase | aws | azure.`,
    );
    process.exit(2);
  }
  // §11.C — cloud installs are provisioned end-to-end by the wizard
  // (gcloud bootstrap, cost table, pulumi up, DNS, owner setup URL).
  // `init` used to print manual Pulumi steps here instead, which pointed
  // at a stack dir that only exists inside the Caelo repo.
  if (initDelegatesToWizard(providerArg)) {
    await wizardCommand();
    return;
  }
  if (!domain || !ownerEmail) {
    console.error(
      "Usage: cms-provision init [--provider self-hosted] --domain example.com [--staging-domain staging.example.com] --owner-email me@example.com [--version x.y.z] [--skip-verify] [--dev] [--tls acme|internal] [--http-port 80] [--https-port 443]\n" +
        "Cloud providers (gcp | gcp-firebase | aws | azure) run the wizard: cms-provision --provider <name>",
    );
    process.exit(2);
  }
  if (existsSync(CONFIG_PATH)) {
    console.error(`config already exists at ${CONFIG_PATH}; run \`cms-provision up\` to re-deploy`);
    process.exit(2);
  }
  const tls = tlsArg();
  const ports = portsArg();
  if (ports.http === ports.https) {
    console.error("--http-port and --https-port must differ");
    process.exit(2);
  }
  const stagingArg = arg("staging-domain");
  const stagingProblem = stagingArg
    ? stagingHostProblem(stagingArg, {
        liveHosts: [domain, `www.${domain}`],
        adminHosts: [`admin.${domain}`],
      })
    : null;
  if (stagingProblem) {
    console.error(`--staging-domain: ${stagingProblem}`);
    process.exit(2);
  }
  // #696 — the prebuilt release images, resolved to digests and
  // cosign-verified BEFORE anything is written, so a failed check leaves no
  // half-made install. `--dev` (contributors only) runs this checkout instead.
  const dev = process.argv.includes("--dev");
  if (dev && !IN_REPO_CHECKOUT) {
    console.error(
      "--dev runs the admin + gateway from a Caelo source checkout and only works from one\n" +
        "(bun packages/provisioning/src/cli.ts init --dev …). End-user installs omit it.",
    );
    process.exit(2);
  }
  const version = (arg("version") ?? CAELO_VERSION).replace(/^v/, "");
  const skipVerify = process.argv.includes("--skip-verify");
  let images: ComposeImages = { mode: "dev" };
  if (!dev) {
    console.log(`Resolving + verifying the Caelo ${version} release images …`);
    const resolved = await resolveVerifiedRelease(version, {
      runner: bunHostRunner,
      skipVerify,
      onProgress: (m) => console.log(`  ${m}`),
    });
    if (!resolved.ok) {
      console.error(resolved.error);
      process.exit(1);
    }
    if (skipVerify) console.warn("--skip-verify set — image signatures NOT verified.");
    images = resolved.images;
  }
  saveProvider(providerArg);
  const cfg: CaeloConfig = {
    domain,
    stagingDomain: stagingArg ? normalizeStagingHost(stagingArg) : defaultStagingHost(domain),
    ownerEmail,
    postgresPassword: randomSecret(32),
    rolePasswords: newRolePasswords(),
    // A fresh volume: bootstrap.sh creates the roles with these on first start.
    rolesConverged: true,
    caeloSecretKek: randomSecret(32),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    resendApiKey: process.env.RESEND_API_KEY,
    imageMode: dev ? "dev" : "release",
    tls,
    ports,
    composeProject: composeProjectName(domain),
  };
  saveConfig(cfg);
  if (images.mode === "release") {
    recordRelease(
      CAELO_DIR,
      { version, images },
      { from: null, to: version, outcome: "installed" },
    );
  }
  emitConfig(cfg);

  // Mint the bootstrap token and stage it for hooks.server.ts to insert
  // on first request. The CLI doesn't talk to Postgres directly because
  // the DB hasn't started yet; the admin app picks the token up on its
  // first boot, calls owner_bootstrap_tokens.insert, then deletes the
  // staging file.
  const tok = generateBootstrapToken();
  mkdirSync(resolve(CAELO_DIR, BOOTSTRAP_DIR), { recursive: true, mode: 0o700 });
  writeFileSync(PENDING_TOKEN_PATH, JSON.stringify(tok, null, 2), { mode: 0o600 });

  // P15.1 — mint the shared HMAC secret for /api/internal/* endpoints.
  // Same secret is read by:
  //   - admin app (process.env.CAELO_INTERNAL_SECRET),
  //   - cms-provision pulumi-output-sync (when running in CI / by hand),
  //   - any future internal-only orchestration.
  // Long enough to defeat brute-force. GCP installs keep their own copy in
  // Secret Manager (runtime-secrets.ts), rotated by `rotate-secret
  // internal-secret`.
  const internalSecret = randomSecret(48);
  const internalSecretPath = resolve(CAELO_DIR, "internal-secret.json");
  writeFileSync(internalSecretPath, JSON.stringify({ secret: internalSecret }, null, 2));
  // #696 Phase 4c — the update agent (Linux + systemd): the fresh volume's
  // bootstrap.sh creates its database login on Postgres's first start.
  const { reportAgentSetup, setUpAgent } = await import("./agent/command.js");
  const agentSetup =
    images.mode === "release"
      ? await setUpAgent(agentContext(cfg), { database: "fresh", explicit: false })
      : null;
  console.log(`Wrote ${COMPOSE_PATH}`);
  console.log(`Wrote ${CADDYFILE_PATH}`);
  console.log(`Wrote ${PENDING_TOKEN_PATH} (admin will insert on first boot)`);
  console.log(
    images.mode === "release"
      ? `Images: Caelo ${version}, pinned by digest (${images.admin.split("@")[1]?.slice(0, 19)}…)`
      : "Images: DEV MODE — admin + gateway run this checkout (contributors only).",
  );
  // Printed BEFORE the start: the admin consumes pending-token.json on its
  // first boot, so a start that fails half-way and is resumed with `up`
  // would otherwise leave the operator without the link.
  const adminHost = selfHostedAdminHost(domain);
  const setupUrl = `${siteUrl(cfg, adminHost)}/setup?token=${tok.token}`;
  console.log("");
  console.log(`Owner setup link (save it; valid until ${tok.expiresAt}):`);
  console.log(`  ${setupUrl}`);
  console.log("");
  // #707 / §11.C — one command ends with a serving install, not with steps
  // to copy.
  await startStack();
  console.log("");
  console.log("Caelo is running. Point these DNS records at this host (A/AAAA):");
  for (const host of [adminHost, domain, cfg.stagingDomain ?? defaultStagingHost(domain)]) {
    console.log(`  ${host}`);
  }
  console.log(
    tls === "acme"
      ? "Caddy fetches the certificates once they resolve (ports 80 + 443 must be reachable)."
      : "TLS: Caddy's local CA (--tls internal) — browsers warn until its root is trusted.",
  );
  console.log("");
  console.log("Then create the Owner account:");
  console.log(`  ${setupUrl}`);
  console.log(`  (token expires ${tok.expiresAt})`);
  if (agentSetup) {
    console.log("");
    reportAgentSetup(agentSetup);
  }
}

async function up(): Promise<void> {
  requireSelfHosted("up");
  const cfg = loadConfig();
  if (!cfg) {
    console.error("no config — run `cms-provision init` first");
    process.exit(2);
  }
  // Postgres runs on the CURRENT Compose file first, so the roles can be
  // converged and the operator-added domains read before anything is
  // re-emitted (a failure here surfaces through the convergence below).
  if (existsSync(COMPOSE_PATH)) {
    await bunHostRunner.run(
      ["docker", "compose", "-f", COMPOSE_PATH, "up", "-d", "--wait", "postgres"],
      { inherit: true },
    );
  }
  // #613 — the database roles first, then the Compose URLs that use them.
  if (!cfg.rolePasswords) {
    cfg.rolePasswords = newRolePasswords();
    cfg.rolesConverged = false;
    saveConfig(cfg);
  }
  const decision = decideUp(
    cfg.rolesConverged ?? false,
    await convergeSelfHostedRoles(cfg.rolePasswords, {
      probe: postgresIsUp,
      psql: superuserPsql,
      ...(activeAgent(cfg) ? { agentPassword: activeAgent(cfg)?.dbPassword } : {}),
    }),
  );
  if (decision.kind === "abort") {
    console.error(decision.error);
    process.exit(1);
  }
  if (decision.warning) console.warn(decision.warning);
  if (decision.markConverged) {
    cfg.rolesConverged = true;
    saveConfig(cfg);
  }
  emitConfig(cfg, await fetchExtraDomains());
  console.log(`Re-emitted ${COMPOSE_PATH} + ${CADDYFILE_PATH}`);
  await startStack();
  console.log(`\nCaelo is running: ${siteUrl(cfg, selfHostedAdminHost(cfg.domain))}`);
}

/** Whether the install's Postgres container answers (with the CURRENT Compose file). */
async function postgresIsUp(): Promise<boolean> {
  if (!existsSync(COMPOSE_PATH)) return false;
  const proc = Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      COMPOSE_PATH,
      "exec",
      "-T",
      "postgres",
      "pg_isready",
      "-U",
      "caelo",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  return (await proc.exited) === 0;
}

/** Run a psql script as the superuser inside the Postgres container; the script goes on stdin. */
async function superuserPsql(script: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      COMPOSE_PATH,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "caelo",
      "-d",
      "postgres",
      "-q",
      "-f",
      "-",
    ],
    { stdin: new TextEncoder().encode(script), stdout: "ignore", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr };
}

/**
 * Operator-added domains (Settings → Domains) from `cms_admin.domains`, so
 * the regenerated Caddyfile keeps serving them. Uses `docker compose exec`
 * so the host needs no psql. A stopped database yields the seed vhosts only
 * (with a warning — nothing can be read); a running database whose query
 * fails is an error, never a silent drop of the operator's domains.
 */
async function fetchExtraDomains(): Promise<CaddyDomainSpec[]> {
  if (!(await postgresIsUp())) {
    console.warn(
      "Postgres is not running: the Caddyfile gets the seed hosts only (domains added in the admin are re-read on the next `up`).",
    );
    return [];
  }
  // The superuser bypasses RLS; the table exists once the migrations ran.
  const sql =
    "SELECT hostname, kind FROM domains WHERE kind IN ('admin', 'public') ORDER BY hostname";
  const r = await bunHostRunner.run([
    "docker",
    "compose",
    "-f",
    COMPOSE_PATH,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "caelo",
    "-d",
    "cms_admin",
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
    "-F",
    "|",
    "-c",
    sql,
  ]);
  if (r.exitCode !== 0) {
    // Before the first migration there is no domains table — and no domains.
    if (/relation "domains" does not exist|database "cms_admin" does not exist/.test(r.stderr)) {
      return [];
    }
    throw new Error(`could not read the domains table: ${r.stderr.trim()}`);
  }
  return parseDomainRows(r.stdout);
}

/** `hostname|kind` rows from psql -At → vhosts (domains has no env column: they are live hosts). */
function parseDomainRows(stdout: string): CaddyDomainSpec[] {
  const rows: CaddyDomainSpec[] = [];
  for (const line of stdout.split("\n")) {
    const [hostname, kind] = line.trim().split("|");
    if (!hostname || (kind !== "admin" && kind !== "public")) continue;
    rows.push({ hostname, kind, env: "production" });
  }
  return rows;
}

async function regenerateCaddy(): Promise<void> {
  requireSelfHosted("regenerate-caddy");
  const cfg = loadConfig();
  if (!cfg) {
    console.error("no config — run `cms-provision init` first");
    process.exit(2);
  }
  const r = await refreshCaddy(cfg);
  if (!r.ok) {
    console.error(`${CADDYFILE_PATH} was re-written, but ${r.error}`);
    process.exit(1);
  }
  console.log(`Re-emitted ${CADDYFILE_PATH} and reloaded Caddy.`);
}

async function status(): Promise<void> {
  const provider = loadProvider();
  console.log(`Active provider: ${provider}`);
  if (provider !== "self-hosted") {
    console.log(`Stack dir:        packages/provisioning/stacks/${provider}`);
    console.log(`State + outputs:  pulumi stack output (run from the stack dir)`);
    console.log(`Cert + DNS:       visit /settings/dns in the admin`);
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
  console.log("Cert status:      visit /settings/domains in the admin");
}

/** `backup [--to <file>]` for a self-hosted install (self-hosted-backup.ts). */
async function backup(): Promise<void> {
  requireSelfHosted("backup");
  if (!loadConfig()) {
    console.error("no config — run `cms-provision init` first");
    process.exit(2);
  }
  const to = resolve(
    arg("to") ?? `caelo-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`,
  );
  const { backupSelfHosted } = await import("./self-hosted-backup.js");
  const r = await backupSelfHosted(to, readRelease(CAELO_DIR)?.version ?? CAELO_VERSION, {
    caeloDir: CAELO_DIR,
    runner: bunHostRunner,
    log: (m) => console.log(`==> ${m}`),
  });
  if (!r.ok) {
    console.error(`Backup failed: ${r.error}`);
    process.exit(1);
  }
  console.log(`Backup complete: ${r.path}`);
  console.log(
    `It holds the databases, the published site and the media — not ${CONFIG_PATH} (the secrets); keep a copy of that separately.`,
  );
}

/** `restore --from <file> --yes` for a self-hosted install (self-hosted-backup.ts). */
async function restore(): Promise<void> {
  requireSelfHosted("restore");
  const from = arg("from");
  if (!from) {
    console.error("Usage: cms-provision restore --from <backup.tar.gz> --yes");
    process.exit(2);
  }
  if (!process.argv.includes("--yes")) {
    console.error(
      `DESTRUCTIVE: replaces both databases, the published site and the media with ${from}. Re-run with --yes to confirm.`,
    );
    process.exit(1);
  }
  const cfg = loadConfig();
  if (!cfg?.rolePasswords) {
    console.error("no config with role passwords — run `cms-provision init` / `up` first");
    process.exit(2);
  }
  const passwords = cfg.rolePasswords;
  const { restoreSelfHosted } = await import("./self-hosted-backup.js");
  const r = await restoreSelfHosted(resolve(from), {
    caeloDir: CAELO_DIR,
    runner: bunHostRunner,
    log: (m) => console.log(`==> ${m}`),
    convergeRoles: () =>
      convergeSelfHostedRoles(passwords, {
        probe: postgresIsUp,
        psql: superuserPsql,
        ...(activeAgent(cfg) ? { agentPassword: activeAgent(cfg)?.dbPassword } : {}),
      }),
    refreshCaddy: () => refreshCaddy(cfg),
  });
  if (!r.ok) {
    console.error(`Restore failed: ${r.error}`);
    if (r.installChanged) {
      console.error(
        `The install is partly restored. Fix the cause and run the same restore again — it starts over from the archive.`,
      );
    }
    process.exit(1);
  }
  console.log(
    `Restore complete (backup of Caelo ${r.manifest.caeloVersion}, taken ${r.manifest.createdAt}).`,
  );
}

/**
 * #696 — `migrate`: apply the database migrations with the admin image the
 * install runs (a one-off `docker compose run` of its migration entrypoint,
 * as the GCP migrate job does). Postgres must be up; idempotent.
 */
async function migrate(): Promise<void> {
  requireSelfHosted("migrate");
  if (!existsSync(COMPOSE_PATH)) {
    console.error(`no Compose file — run \`${selfCommand("init")}\` first`);
    process.exit(2);
  }
  const { runMigrations } = await import("./self-hosted-upgrade.js");
  const r = await runMigrations(CAELO_DIR, bunHostRunner);
  if (!r.ok) {
    console.error(r.error);
    process.exit(1);
  }
  console.log("Migrations applied (cms_admin + cms_public).");
}

/**
 * Whether `upgrade` targets this directory's self-hosted Compose install.
 * `--install <id|domain|all>` always names cloud installs (install.json),
 * so it goes to the lifecycle selector even where a `.caelo/` exists.
 */
function selfHostedInstallPresent(): boolean {
  return (
    arg("install") === undefined && existsSync(CONFIG_PATH) && loadProvider() === "self-hosted"
  );
}

/**
 * #696 — `upgrade` for a self-hosted install: verified digests, pg_dump
 * backup, pull, migrations, admin-then-gateway roll with health checks and
 * rollback (self-hosted-upgrade.ts).
 */
async function upgradeSelfHostedCommand(opts: {
  version?: string;
  channel?: "stable" | "rc" | "beta";
  skipVerify?: boolean;
}): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) {
    console.error("no config — run `cms-provision init` first");
    process.exit(2);
  }
  if (cfg.imageMode === "dev") {
    console.error(
      "This is a DEV MODE install: the admin + gateway run your Caelo checkout, so there are\n" +
        "no images to upgrade. Update the checkout (git pull), then `bun packages/provisioning/src/cli.ts migrate` and\n" +
        `\`docker compose -f ${COMPOSE_PATH} restart caelo-admin caelo-gateway\`.`,
    );
    process.exit(2);
  }
  const { upgradeSelfHosted } = await import("./self-hosted-upgrade.js");
  const { acquireUpgradeLock } = await import("./agent/lock.js");
  // The update agent rolls through the same lock: never two rolls at once.
  let unlock: () => void;
  try {
    unlock = acquireUpgradeLock(CAELO_DIR, "`cms-provision upgrade`");
  } catch (e) {
    console.error(`Nothing was changed: ${(e as Error).message} Wait for it to finish.`);
    process.exit(1);
  }
  let result: Awaited<ReturnType<typeof upgradeSelfHosted>>;
  try {
    result = await upgradeSelfHosted(opts, {
      caeloDir: CAELO_DIR,
      runner: bunHostRunner,
      renderCompose: (images) => renderCompose(cfg, images),
      convergeRoles: agentContext(cfg).convergeRoles,
      log: {
        step: (m) => console.log(`\n==> ${m}`),
        info: (m) => console.log(`    ${m}`),
        warn: (m) => console.warn(`    ! ${m}`),
        error: (m) => console.error(`    x ${m}`),
      },
    });
  } finally {
    unlock();
  }
  if (result.ok) {
    if (result.status === "upgraded" && cfg.imageMode !== "release") {
      cfg.imageMode = "release";
      saveConfig(cfg);
    }
    // #696 Phase 4c — set up the update agent, or re-pin it to this release.
    const { reportAgentSetup, setUpAgent } = await import("./agent/command.js");
    console.log("");
    reportAgentSetup(await setUpAgent(agentContext(cfg), { database: "live", explicit: false }));
    return;
  }
  console.error(`\nUpgrade failed at "${result.stage}":\n${result.error}`);
  console.error(
    result.previousRunning
      ? "The previous release is still the one running."
      : "The install may be degraded — see above.",
  );
  process.exit(1);
}

const cmd = process.argv[2];
/**
 * P15 — `pulumi-output-sync`. Reads `pulumi stack output --json` from
 * the active stack (cwd or --stack-dir), writes the rendered outputs
 * into cms_admin.provisioning_outputs via the local `psql` shell-out.
 * Run after every `pulumi up` so the admin's /settings/dns page picks
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
      "CAELO_INTERNAL_SECRET not set or too short (need ≥32 chars). Self-hosted: `cms-provision init` writes it to .caelo/internal-secret.json. GCP: it lives in Secret Manager — export CAELO_INTERNAL_SECRET=$(gcloud secrets versions access latest --secret=caelo-production-internal-secret --project=<project>) and re-run.",
    );
    process.exit(2);
  }
  if (!adminBaseUrl) {
    console.error(
      "CAELO_ADMIN_URL not set (e.g. https://example.com). Required so the CLI knows where the admin lives.",
    );
    process.exit(2);
  }
  const { mintInternalToken } = await import("./internal-token.js");
  const token = await mintInternalToken(internalSecret, "provisioning-outputs.sync");

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
  migrate,
  // §11.C lifecycle dispatchers route by provider via install metadata.
  // Self-hosted bodies remain reachable as `<command>-self-hosted` for
  // back-compat scripts that bypassed the dispatcher.
  status: lifecycleStatus,
  "status-self-hosted": status,
  backup: async () => (selfHostedInstallPresent() ? backup() : lifecycleBackup()),
  "backup-self-hosted": backup,
  restore,
  upgrade: lifecycleUpgrade,
  "rotate-secret": lifecycleRotateSecret,
  destroy: lifecycleDestroy,
  truncate: lifecycleTruncate,
  "admin-domain": adminDomain,
  "staging-domain": stagingDomain,
  "owner-reset": ownerReset,
  // #696 — Pulumi state in the install's own project.
  state: async () => (await import("./state-command.js")).stateCommand(process.argv),
  attach: async () => (await import("./state-command.js")).attachCommand(process.argv),
  // #696 Phase 4c — the self-hosted update agent.
  agent: agentCli,
  // #696 — the install job's entry point (runs inside the Cloud Run job).
  "install-job": async () =>
    (await import("./install-job-runner.js")).installJobCommand(process.argv),
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
  // P20 — version + channel flags. Default = latest stable.
  //   bunx @caelo-cms/provisioning upgrade
  //   bunx @caelo-cms/provisioning upgrade --version 0.5.3
  //   bunx @caelo-cms/provisioning upgrade --channel rc
  // P21 ship 4 — `--skip-verify` opts out of cosign signature checks.
  //   Default verifies; skip only for forks/staging using unsigned images.
  const version = arg("version");
  const channelArg = arg("channel");
  const channel: "stable" | "rc" | "beta" | undefined =
    channelArg === "rc" || channelArg === "beta" || channelArg === "stable"
      ? channelArg
      : undefined;
  const skipVerify = process.argv.includes("--skip-verify");
  if (selfHostedInstallPresent()) {
    await upgradeSelfHostedCommand({
      ...(version ? { version } : {}),
      ...(channel ? { channel } : {}),
      ...(skipVerify ? { skipVerify: true } : {}),
    });
    return;
  }
  // #696 — `--skip-health-check` rolls without the post-roll deep health
  //   check (Cloud Run readiness only), e.g. for a release that predates it.
  const skipHealthCheck = process.argv.includes("--skip-health-check");
  // #607 — optional; must match the install's recorded region (upgrade
  // never moves an install between regions).
  const region = arg("region");
  const { upgradeCommand } = await import("./lifecycle.js");
  await upgradeCommand({
    ...(region ? { region } : {}),
    ...(version ? { version } : {}),
    ...(channel ? { channel } : {}),
    ...(skipVerify ? { skipVerify: true } : {}),
    ...(skipHealthCheck ? { skipHealthCheck: true } : {}),
  });
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
async function lifecycleTruncate(): Promise<void> {
  const { truncateCommand } = await import("./lifecycle.js");
  await truncateCommand();
}

/**
 * #769 `owner-reset [--install <id>] [--email <addr>]` — print a one-time
 * reset link for a locked-out Owner, for installs whose admin cannot email
 * one (see owner-reset.ts for why the operator's cloud identity may).
 */
async function ownerReset(): Promise<void> {
  const { installFlag, listInstalls, selectInstall } = await import("./install-state.js");
  const selected = selectInstall(listInstalls(), installFlag(process.argv));
  if (!selected.ok) {
    console.error(selected.message);
    process.exit(1);
  }
  const meta = selected.meta;
  if (meta.provider !== "gcp-firebase") {
    console.error(
      `owner-reset works on gcp-firebase installs so far; this one is ${meta.provider} (issue #770). ` +
        "Until then, another Owner can set a new password under Settings -> Users, or set up email under Settings -> Email so /forgot can send the link.",
    );
    process.exit(1);
  }
  if (!meta.projectId || !meta.region) {
    console.error(
      `install ${meta.installId} has no project or region recorded in install.json; re-run the wizard to record it.`,
    );
    process.exit(1);
  }
  const email = arg("email");
  const { describeOwnerReset, requestOwnerReset } = await import("./owner-reset.js");
  const r = await requestOwnerReset(
    { projectId: meta.projectId, region: meta.region },
    email ? { email } : {},
  );
  if (!r.ok) {
    console.error(`owner-reset: ${r.error}`);
    process.exit(1);
  }
  for (const line of describeOwnerReset(r.value)) console.log(line);
}

/**
 * `admin-domain enable` — bind admin.<domain> to a gcp-firebase admin
 * (see admin-domain.ts for why this runs as the operator, not Pulumi).
 */
async function adminDomain(): Promise<void> {
  await domainMappingCommand("admin");
}

/**
 * #650 `staging-domain enable [--staging-domain <host>]` — bind the install's
 * staging host to the gcp-firebase gateway, which serves the protected
 * staging site. #678: the command also configures the admin — without the
 * flag it maps the host the admin stores; `--staging-domain` sets a new one
 * there (the operator's explicit decision, audited). The first run turns on
 * basic auth and prints the generated credentials once;
 * `--rotate-staging-password` replaces the password, `--show-staging-password`
 * prints the current one.
 */
async function stagingDomain(): Promise<void> {
  await domainMappingCommand("staging");
}

async function domainMappingCommand(kind: "admin" | "staging"): Promise<void> {
  const command = `${kind}-domain`;
  const sub = process.argv[3];
  if (sub !== "enable") {
    console.log(
      `Usage: cms-provision ${command} enable [--install <install-id>]${kind === "staging" ? " [--staging-domain <host>] [--rotate-staging-password] [--show-staging-password]" : ""}`,
    );
    process.exit(2);
  }
  const {
    installFlag,
    installStagingHost,
    currentMetadata,
    listInstalls,
    recordableStagingHost,
    selectInstall,
    writeMetadata,
  } = await import("./install-state.js");
  const { enableAdminDomain, enableStagingDomain } = await import("./admin-domain.js");
  // Guessing among several installs could map the domain in the wrong project.
  const selected = selectInstall(
    listInstalls().filter((m) => m.projectId),
    installFlag(process.argv),
  );
  if (!selected.ok) {
    console.error(selected.message);
    process.exit(1);
  }
  let meta = currentMetadata(selected.meta);
  // The command to re-run after a stop before the admin was updated: an
  // explicitly requested host must survive it, or the retry would map the
  // admin's old host (codex review on #681).
  const { domainEnableRetryCommand } = await import("./staging-admin.js");
  let retry = domainEnableRetryCommand(command, null);
  const rotatePassword = process.argv.includes("--rotate-staging-password");
  const showPassword = process.argv.includes("--show-staging-password");
  if (kind === "staging") {
    // #678 — the admin's stored host is the truth; `--staging-domain` is the
    // operator's explicit change of it. Without the flag a gcp-firebase
    // install maps the host the admin actually renders (and records it in
    // install.json), so a host changed under Settings → Domains is never
    // undone here. Validated either way: the recorded/default host may
    // predate a check (e.g. a long default a Cloud Run mapping refuses).
    const requested = arg("staging-domain");
    const { normalizeStagingHost, stagingHostProblem } = await import("@caelo-cms/shared");
    let adminHost: string | null = null;
    if (!requested && meta.provider === "gcp-firebase" && meta.projectId && meta.region) {
      const { inspectStagingAdmin } = await import("./staging-admin.js");
      const inspected = await inspectStagingAdmin({
        projectId: meta.projectId,
        region: meta.region,
      });
      if (!inspected.ok) {
        console.error(
          `${command}: could not read the admin's staging host: ${inspected.error}\n` +
            "Fix that, or pass --staging-domain <host> to set the host explicitly.",
        );
        process.exit(1);
      }
      adminHost = inspected.value.stagingHost;
    }
    const host = requested ?? adminHost ?? installStagingHost(meta);
    const problem = stagingHostProblem(
      host,
      { liveHosts: [meta.domain, `www.${meta.domain}`], adminHosts: [`admin.${meta.domain}`] },
      { provider: meta.provider },
    );
    if (problem) {
      console.error(
        requested
          ? `--staging-domain: ${problem}`
          : `the install's staging host: ${problem}. Pass --staging-domain <host>.`,
      );
      process.exit(1);
    }
    const recorded = normalizeStagingHost(host);
    if (requested) retry = domainEnableRetryCommand(command, recorded);
    // The host may come from the admin's answer (inspect): only a bare host
    // name — already checked by stagingHostProblem above — reaches
    // install.json, and only the value the allow-list hands back is written.
    const stagingDomain = recordableStagingHost(recorded);
    if (stagingDomain === null) {
      console.error(`${command}: refusing to record staging host ${JSON.stringify(recorded)}.`);
      process.exit(1);
    }
    meta = { ...meta, stagingDomain };
    writeMetadata(meta.installId, meta);
  }
  if (!meta.projectId) process.exit(1);
  if (!meta.region) {
    console.error(
      `install ${meta.installId} has no region recorded in install.json; re-run the wizard to record it.`,
    );
    process.exit(1);
  }
  if (meta.provider !== "gcp-firebase") {
    console.log(
      kind === "admin"
        ? meta.provider === "gcp"
          ? `Nothing to do: on gcp the load balancer already serves admin.${meta.domain}.`
          : `admin-domain is for gcp-firebase installs; this one is ${meta.provider}.`
        : meta.provider === "self-hosted"
          ? `Recorded staging host ${installStagingHost(meta)}; Caddy serves it after \`cms-provision regenerate-caddy\`.`
          : `staging-domain is for gcp-firebase installs; on ${meta.provider} the protected staging domain is not available yet (issue #650 follow-up).`,
    );
    return;
  }
  const target = { projectId: meta.projectId, region: meta.region, domain: meta.domain };
  const r =
    kind === "admin"
      ? await enableAdminDomain(target)
      : await enableStagingDomain({ ...target, stagingHost: installStagingHost(meta) });
  if (r.status === "failed") {
    console.error(`${command}: ${r.error}`);
    process.exit(1);
  }
  if (r.status === "needs-verification") {
    console.log(
      `Google only maps ${r.hostname} for a verified owner of ${r.verifyDomain}.\n` +
        "Search Console was opened for you: add the TXT record it shows at your registrar,\n" +
        `click Verify, then run \`${retry}\` again.`,
    );
    process.exit(3);
  }
  const mappedTo = kind === "admin" ? "the admin" : "the gateway (protected staging site)";
  console.log(
    `${r.hostname} ${r.created ? "is now mapped" : "was already mapped"} to ${mappedTo}.`,
  );
  if (kind === "staging") {
    // #678 — the operator's decision reaches the admin here: the host is
    // set there, password protection is switched on the first time, and
    // the password is printed once (never stored by the CLI).
    const { applyStagingAdmin, describeStagingApply } = await import("./staging-admin.js");
    const applied = await applyStagingAdmin(
      { projectId: meta.projectId, region: meta.region },
      {
        host: r.hostname,
        ...(rotatePassword ? { rotateBasicAuth: true } : {}),
        ...(showPassword ? { revealBasicAuth: true } : {}),
      },
    );
    if (!applied.ok) {
      console.error(
        `${command}: ${r.hostname} is mapped, but the admin could not be updated: ${applied.error}\n` +
          `Run \`${retry}\` again once that is fixed (it is idempotent).`,
      );
      process.exit(5);
    }
    // Prints the staging basic-auth password ON PURPOSE (#678): the operator
    // asked for it to be shown once; it is never written to disk or logs.
    console.log(describeStagingApply(applied.value).join("\n"));
  }
  if (r.records.length === 0) {
    console.log(
      `Google has not published the DNS records yet; run \`cms-provision ${command} enable\` again in a minute.`,
    );
    return;
  }
  const waited = await waitForDomainMappingCert({
    command,
    hostname: r.hostname,
    records: r.records,
    projectId: meta.projectId,
    region: meta.region,
  });
  if (!waited) process.exit(4);
  console.log(
    kind === "admin"
      ? `Admin login: https://${r.hostname}/login`
      : `Protected staging site: https://${r.hostname}/`,
  );
}

/**
 * After `<kind>-domain enable` mapped the host: print the DNS records, then
 * poll the mapping until Google has issued its certificate (cert-wait.ts),
 * with a spinner. Returns false on timeout or a gcloud failure, after saying
 * how to check the status. Ctrl-C is safe: the command is idempotent, and
 * re-running it finds the mapping and resumes the wait.
 */
async function waitForDomainMappingCert(target: {
  command: string;
  hostname: string;
  records: readonly { name: string; type: string; value: string }[];
  projectId: string;
  region: string;
}): Promise<boolean> {
  const { spinner } = await import("@clack/prompts");
  const { CERT_WAIT_TIMEOUT_MS, domainMappingProbe, waitForCert } = await import("./cert-wait.js");
  const { gcloud } = await import("./gcloud.js");
  const width = Math.max(...target.records.map((d) => d.name.length));
  console.log(
    `\nSet this DNS record at your registrar (if you have not already):\n${target.records
      .map((d) => `  ${d.type.padEnd(6)} ${d.name.padEnd(width)} → ${d.value}`)
      .join("\n")}\n` +
      "Google issues the TLS certificate once the record resolves — usually 15-60 minutes.\n" +
      `Safe to stop with Ctrl-C: \`cms-provision ${target.command} enable\` again resumes waiting.\n`,
  );
  // clack's spinner swallows SIGINT; exit explicitly so Ctrl-C stops the wait.
  const s = spinner({
    cancelMessage: `Stopped. Run \`cms-provision ${target.command} enable\` again to resume waiting.`,
    onCancel: () => process.exit(130),
  });
  s.start(`Waiting for the certificate of ${target.hostname} (DNS set? this takes 15-60 min)`);
  const r = await waitForCert({
    probe: () =>
      domainMappingProbe(gcloud, {
        hostname: target.hostname,
        region: target.region,
        projectId: target.projectId,
      }),
    timeoutMs: CERT_WAIT_TIMEOUT_MS,
    intervalMs: 30 * 1000,
    onUpdate: (detail) => s.message(`${target.hostname}: ${detail}`),
  });
  if (r.ok) {
    s.stop(`Certificate for ${target.hostname} is ready.`);
    return true;
  }
  const check = `gcloud beta run domain-mappings describe --domain=${target.hostname} --region=${target.region} --project=${target.projectId}`;
  if (r.reason === "error") {
    s.error(`Could not read the domain mapping: ${r.error}`);
    console.error(`Check it by hand with:\n  ${check}`);
    return false;
  }
  s.error(`No certificate for ${target.hostname} after 60 minutes.`);
  console.error(
    [
      r.lastDetail ? `Google reports: ${r.lastDetail}` : "",
      `Check that the record resolves: dig +short ${target.hostname} ${target.records[0]?.type ?? "CNAME"}`,
      `Check the mapping's status:    ${check}`,
      `Once DNS resolves, run \`cms-provision ${target.command} enable\` again to resume waiting.`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return false;
}

/**
 * §11.C — interactive wizard. Loaded lazily so the bare-CLI startup
 * cost stays small (clack + kleur are pulled in only when needed).
 * Reads `--provider`, `--domain`, `--owner-email`, `--project-id`, `--region`,
 * `--non-interactive` and the run mode (`--local` / `--install-job`, default:
 * the install job in Cloud Shell, local elsewhere — run-mode.ts) from argv.
 */
async function wizardCommand(): Promise<void> {
  const { runWizard } = await import("./wizard.js");
  const { chooseRunMode } = await import("./run-mode.js");
  await runWizard({
    runMode: chooseRunMode(process.argv, process.env),
    nonInteractive: process.argv.includes("--non-interactive"),
    provider: arg("provider") as Provider | undefined,
    domain: arg("domain"),
    stagingDomain: arg("staging-domain"),
    ownerEmail: arg("owner-email"),
    projectId: arg("project-id"),
    region: arg("region"),
  });
}

// §11.C — flags-only invocations (`--provider gcp --domain …`, the
// documented one-command form) and a bare `cms-provision` drop into the
// wizard. `--no-wizard` / `--help` keep the legacy "print usage" shape.
const route = resolveCliRoute(process.argv, Object.keys(handlers));
if (route.kind === "handler" || route.kind === "wizard") {
  try {
    if (route.kind === "handler") await handlers[route.name]?.();
    else await wizardCommand();
  } catch (e) {
    // #656 — an error from Pulumi, gcloud or a database client can quote a
    // connection URL; print it with any password masked.
    console.error(redactCredentials(e instanceof Error ? (e.stack ?? e.message) : String(e)));
    process.exit(1);
  }
} else {
  console.log(cliUsage());
  process.exit(cmd && !cmd.startsWith("-") ? 2 : 0);
}
