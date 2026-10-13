// SPDX-License-Identifier: MPL-2.0

/**
 * `cms-provision agent <install|status|logs|uninstall>` and the two entry
 * points the agent's own units use (`run`, `apply`) — the self-hosted host
 * agent of #696 Phase 4c. The CLI hands in what it owns (config.json, the
 * Compose renderer, the superuser psql) through {@link AgentCliContext};
 * everything decided here is in agent/run.ts, agent/apply.ts and
 * agent/systemd.ts, which are tested against fakes.
 */

import { hostname } from "node:os";
import { dirname } from "node:path";
import { CAELO_VERSION, PLATFORM_UPDATE_TRIGGERS } from "@caelo-cms/shared";
import { z } from "zod";
import type { ReleaseImages } from "../compose.js";
import { compareSemver, fetchVerifiedReleaseManifest } from "../release-manifest.js";
import { selfCommand } from "../self-command.js";
import { bunHostRunner, type HostRunner, readRelease } from "../self-hosted-release.js";
import type { ConvergeOutcome } from "../self-hosted-roles.js";
import type { JobLog } from "../upgrader-reporter.js";
import { applyAgentUpdate } from "./apply.js";
import { type AgentConfig, agentConfigFor, agentDbConnection } from "./config.js";
import { acquireUpgradeLock } from "./lock.js";
import { loadAgentQueueOpener } from "./queue.js";
import { type AgentApplyOutcome, type AgentApplyRequest, runAgentOnce } from "./run.js";
import {
  type AgentHost,
  agentHostProblem,
  agentLogsArgv,
  agentUnitStatus,
  currentAgentHost,
  installAgentUnits,
  installedAgentVersion,
  repinAgentUnits,
  uninstallAgentUnits,
} from "./systemd.js";
import { type AgentUnitSpec, agentPackageRef, agentUnitName } from "./units.js";

/** What the CLI owns that the agent commands need. */
export interface AgentCliContext {
  readonly caeloDir: string;
  readonly domain: string;
  readonly imageMode: "release" | "dev" | undefined;
  /** config.json → agent. */
  agent(): AgentConfig | undefined;
  /** Persist config.json → agent (undefined removes it). */
  saveAgent(agent: AgentConfig | undefined): void;
  /** Re-write the Compose file (with the agent's port) and bootstrap.sh. */
  emitConfig(): void;
  /** The role convergence as the superuser, including the agent's login. */
  convergeRoles(): Promise<ConvergeOutcome>;
  /** The Compose file for `images` from config.json. */
  renderCompose(images: ReleaseImages): string;
  randomSecret(): string;
}

const say = (m: string) => console.log(m);

/** The agent's log lines, for journald. */
const journalLog: JobLog = (entry) => {
  const line = `[${entry.severity}] ${entry.message}`;
  if (entry.severity === "ERROR") console.error(line);
  else console.log(line);
};

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

/** The unit spec for this install, pinned to `version`. */
function unitSpec(ctx: AgentCliContext, version: string): AgentUnitSpec {
  return {
    name: agentUnitName(ctx.domain, ctx.caeloDir),
    domain: ctx.domain,
    version,
    bunPath: process.execPath,
    caeloDir: ctx.caeloDir,
    workDir: dirname(ctx.caeloDir),
    path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(process.env.DOCKER_HOST ? { dockerHost: process.env.DOCKER_HOST } : {}),
  };
}

/** `docker compose -f <file> …`. */
function composeArgv(ctx: AgentCliContext, ...args: string[]): string[] {
  return ["docker", "compose", "-f", `${ctx.caeloDir}/docker-compose.yml`, ...args];
}

async function postgresReady(ctx: AgentCliContext, runner: HostRunner): Promise<boolean> {
  const r = await runner.run(
    composeArgv(ctx, "exec", "-T", "postgres", "pg_isready", "-U", "caelo"),
  );
  return r.exitCode === 0;
}

/**
 * Apply the agent's database side to a RUNNING install: the role, then
 * `up -d postgres` so the loopback port (and its removal) takes effect —
 * Compose recreates the container only when its definition changed, a few
 * seconds the admin's pool rides out.
 */
async function applyDatabaseSide(
  ctx: AgentCliContext,
  runner: HostRunner,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const roles = await ctx.convergeRoles();
  if (!roles.ok) {
    return { ok: false, error: `could not create the agent's database login: ${roles.error}` };
  }
  const up = await runner.run(composeArgv(ctx, "up", "-d", "postgres"));
  if (up.exitCode !== 0) {
    return {
      ok: false,
      error: `docker compose up -d postgres failed: ${up.stderr.trim().slice(0, 400)}`,
    };
  }
  for (let i = 0; i < 30; i++) {
    if (await postgresReady(ctx, runner)) return { ok: true };
    await Bun.sleep(1000);
  }
  return { ok: false, error: "Postgres did not come back within 30 seconds" };
}

export type SetUpAgentResult =
  | {
      readonly kind: "installed";
      readonly unit: string;
      readonly version: string;
      readonly warnings: readonly string[];
    }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Set the agent up, or bring it up to date — idempotent, for `agent
 * install`, `init` and `upgrade`. With `database: "live"` the install's
 * Postgres runs and gets the login + port now; with `"fresh"` (init) the
 * volume is new and bootstrap.sh creates the login on first start.
 *
 * Never pins an older release than the one already installed.
 */
export async function setUpAgent(
  ctx: AgentCliContext,
  opts: {
    readonly database: "live" | "fresh";
    readonly requestedPort?: number;
    /** `agent install` re-enables an uninstalled agent; init/upgrade respect it. */
    readonly explicit: boolean;
    readonly runner?: HostRunner;
    readonly host?: AgentHost;
  },
): Promise<SetUpAgentResult> {
  const runner = opts.runner ?? bunHostRunner;
  const host = opts.host ?? currentAgentHost(runner);
  const problem = await agentHostProblem(host);
  if (problem) return { kind: "skipped", reason: problem };
  if (ctx.imageMode === "dev") {
    return {
      kind: "skipped",
      reason:
        "this is a DEV MODE install (it runs a Caelo checkout); there are no releases to install.",
    };
  }
  const existing = ctx.agent();
  if (existing?.disabled && !opts.explicit) {
    return {
      kind: "skipped",
      reason: `the update agent was uninstalled; \`${selfCommand("agent", "install")}\` sets it up again.`,
    };
  }
  let agent: AgentConfig;
  try {
    agent = agentConfigFor(existing, {
      ...(opts.requestedPort !== undefined ? { requestedPort: opts.requestedPort } : {}),
      randomSecret: () => ctx.randomSecret(),
    });
  } catch (e) {
    return { kind: "failed", error: (e as Error).message };
  }
  ctx.saveAgent(agent);
  try {
    ctx.emitConfig();
  } catch (e) {
    return { kind: "failed", error: (e as Error).message };
  }
  const warnings: string[] = [];
  if (opts.database === "live") {
    if (await postgresReady(ctx, runner)) {
      const db = await applyDatabaseSide(ctx, runner);
      if (!db.ok) return { kind: "failed", error: db.error };
    } else {
      warnings.push(
        `Postgres is not running, so the agent's database login was not created yet. Start the install (\`docker compose -f ${ctx.caeloDir}/docker-compose.yml up -d\`) and run \`${selfCommand("agent", "install")}\` again.`,
      );
    }
  }
  const name = agentUnitName(ctx.domain, ctx.caeloDir);
  const pinned = installedAgentVersion(host, name);
  const version = pinned && compareSemver(pinned, CAELO_VERSION) > 0 ? pinned : CAELO_VERSION;
  const units = await installAgentUnits(unitSpec(ctx, version), host);
  if (!units.ok) return { kind: "failed", error: units.error };
  return { kind: "installed", unit: name, version, warnings: [...warnings, ...units.warnings] };
}

/** Print what {@link setUpAgent} did, for init / upgrade / agent install. */
export function reportAgentSetup(result: SetUpAgentResult): void {
  if (result.kind === "installed") {
    say(
      `Update agent: ${result.unit}.timer runs Caelo ${result.version}'s agent every minute; Settings → Updates can install updates.`,
    );
    for (const w of result.warnings) console.warn(`  ! ${w}`);
  } else if (result.kind === "skipped") {
    say(`Update agent: not set up — ${result.reason}`);
  } else {
    console.warn(
      `Update agent: could not be set up — ${result.error}\n  Retry with \`${selfCommand("agent", "install")}\`; updates still install with the upgrade command.`,
    );
  }
}

/** `agent <sub>`. */
export async function agentCommand(argv: readonly string[], ctx: AgentCliContext): Promise<number> {
  const sub = argv[3];
  switch (sub) {
    case "install":
      return agentInstall(argv, ctx);
    case "status":
      return agentStatus(ctx);
    case "logs":
      return agentLogs(argv, ctx);
    case "uninstall":
      return agentUninstall(ctx);
    case "run":
      return agentRun(ctx);
    case "apply":
      return agentApply(argv, ctx);
    default:
      console.error(
        "Usage: cms-provision agent install [--port <loopback port>] | status | logs [--lines N] [--follow] | uninstall\n" +
          "The update agent lets Settings → Updates install Caelo updates on this server (Linux + systemd).",
      );
      return 2;
  }
}

async function agentInstall(argv: readonly string[], ctx: AgentCliContext): Promise<number> {
  const portArg = flag(argv, "port");
  const requestedPort = portArg === undefined ? undefined : Number(portArg);
  const result = await setUpAgent(ctx, {
    database: "live",
    explicit: true,
    ...(requestedPort !== undefined ? { requestedPort } : {}),
  });
  reportAgentSetup(result);
  if (result.kind !== "installed") return result.kind === "skipped" ? 2 : 1;
  say(`Logs: \`${selfCommand("agent", "logs")}\` — status: \`${selfCommand("agent", "status")}\``);
  return 0;
}

async function agentStatus(ctx: AgentCliContext): Promise<number> {
  const host = currentAgentHost(bunHostRunner);
  const name = agentUnitName(ctx.domain, ctx.caeloDir);
  const agent = ctx.agent();
  const version = installedAgentVersion(host, name);
  say(`Install:      ${ctx.domain} (${ctx.caeloDir})`);
  say(
    `Agent:        ${version ? `${name} — runs Caelo ${version}` : agent?.disabled ? "uninstalled" : "not installed"}`,
  );
  if (agent && !agent.disabled) say(`Database:     127.0.0.1:${agent.dbPort} (login caelo_agent)`);
  if (!version) {
    say(`Set it up with \`${selfCommand("agent", "install")}\`.`);
    return 1;
  }
  say("");
  say(await agentUnitStatus(host, name));
  return 0;
}

async function agentLogs(argv: readonly string[], ctx: AgentCliContext): Promise<number> {
  const lines = Number(flag(argv, "lines") ?? "200");
  const proc = Bun.spawn(
    agentLogsArgv(agentUnitName(ctx.domain, ctx.caeloDir), {
      lines: Number.isInteger(lines) && lines > 0 ? lines : 200,
      follow: argv.includes("--follow") || argv.includes("-f"),
    }),
    { stdout: "inherit", stderr: "inherit" },
  );
  return proc.exited;
}

async function agentUninstall(ctx: AgentCliContext): Promise<number> {
  const runner = bunHostRunner;
  const host = currentAgentHost(runner);
  const result = await uninstallAgentUnits(host, agentUnitName(ctx.domain, ctx.caeloDir));
  for (const w of result.ok ? result.warnings : []) console.warn(`  ! ${w}`);
  const agent = ctx.agent();
  if (agent) {
    // Off until `agent install`: init/upgrade leave it alone, and the
    // Compose file stops publishing the port.
    ctx.saveAgent({ ...agent, disabled: true });
    ctx.emitConfig();
    if (await postgresReady(ctx, runner)) {
      const up = await runner.run(composeArgv(ctx, "up", "-d", "postgres"));
      if (up.exitCode !== 0) console.warn(`  ! docker compose up -d postgres: ${up.stderr.trim()}`);
    }
  }
  say(
    "Update agent removed. Settings → Updates shows the upgrade command again; " +
      `\`${selfCommand("agent", "install")}\` brings the agent back.`,
  );
  return 0;
}

/** Why an install would fail on this host right now (the heartbeat's `problem`). */
async function hostPreflight(ctx: AgentCliContext, runner: HostRunner): Promise<string | null> {
  if (ctx.imageMode === "dev") {
    return "This is a DEV MODE install (it runs a Caelo checkout); update the checkout instead.";
  }
  const docker = await runner.run(["docker", "info", "--format", "{{.ServerVersion}}"]);
  if (docker.exitCode !== 0) {
    return `Docker is not reachable for the agent's user (${docker.stderr.trim().slice(0, 300) || `exit ${docker.exitCode}`}). The user that runs the agent must be able to run \`docker\` (the docker group).`;
  }
  const cosign = await runner.run(["cosign", "version"]);
  if (cosign.exitCode !== 0) {
    return "cosign is not installed on the server (or not on the agent's PATH), so release signatures cannot be verified. Install cosign, then run the agent install command again.";
  }
  return null;
}

/** The last `limit` characters of a stream, while copying it to `out`. */
async function teeTail(
  stream: ReadableStream<Uint8Array>,
  out: (chunk: Uint8Array) => void,
  limit: number,
): Promise<string> {
  let tail = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    out(chunk);
    tail = (tail + decoder.decode(chunk, { stream: true })).slice(-limit);
  }
  return tail;
}

/** Start the target release's `agent apply` and wait for it. */
async function spawnApply(request: AgentApplyRequest): Promise<AgentApplyOutcome> {
  const argv = [
    process.execPath,
    "x",
    "--bun",
    agentPackageRef(request.targetVersion),
    "agent",
    "apply",
    "--request",
    request.requestId,
    "--version",
    request.targetVersion,
    "--trigger",
    request.trigger,
    "--admin-digest",
    request.digests.admin,
    "--gateway-digest",
    request.digests.gateway,
  ];
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: process.env });
    const [out, err] = await Promise.all([
      teeTail(proc.stdout, (c) => process.stdout.write(c), 1500),
      teeTail(proc.stderr, (c) => process.stderr.write(c), 1500),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, output: (err.trim() || out.trim()).slice(-1500) };
  } catch (e) {
    return { exitCode: 127, output: e instanceof Error ? e.message : String(e) };
  }
}

async function agentRun(ctx: AgentCliContext): Promise<number> {
  const agent = ctx.agent();
  if (!agent || agent.disabled) {
    console.error(
      `The update agent is not set up for ${ctx.domain}; run \`${selfCommand("agent", "install")}\`.`,
    );
    return 2;
  }
  const open = await loadAgentQueueOpener();
  let opened: Awaited<ReturnType<typeof open>>;
  try {
    opened = await open(agentDbConnection(agent));
  } catch (e) {
    journalLog({
      severity: "ERROR",
      message: `cannot reach the install's database on 127.0.0.1:${agent.dbPort} as caelo_agent: ${(e as Error).message}. Is the install running? (\`${selfCommand("agent", "install")}\` re-creates the login.)`,
    });
    return 1;
  }
  try {
    const result = await runAgentOnce({
      queue: opened.queue,
      agentVersion: CAELO_VERSION,
      host: hostname() || "server",
      preflight: () => hostPreflight(ctx, bunHostRunner),
      readInstalled: () => readRelease(ctx.caeloDir),
      fetchManifest: (version) => fetchVerifiedReleaseManifest(version),
      lock: () => acquireUpgradeLock(ctx.caeloDir, "the update agent"),
      applyTarget: spawnApply,
      now: () => new Date(),
      log: journalLog,
    });
    return result.exitCode;
  } finally {
    await opened.close();
  }
}

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const applyArgs = z.object({
  request: z.string().uuid(),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/),
  trigger: z.enum(PLATFORM_UPDATE_TRIGGERS),
  adminDigest: digest,
  gatewayDigest: digest,
});

async function agentApply(argv: readonly string[], ctx: AgentCliContext): Promise<number> {
  const parsed = applyArgs.safeParse({
    request: flag(argv, "request"),
    version: flag(argv, "version"),
    trigger: flag(argv, "trigger"),
    adminDigest: flag(argv, "admin-digest"),
    gatewayDigest: flag(argv, "gateway-digest"),
  });
  if (!parsed.success) {
    console.error(
      `agent apply is started by the update agent, not by hand (${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}).`,
    );
    return 2;
  }
  const args = parsed.data;
  const agent = ctx.agent();
  if (!agent) {
    console.error("The update agent is not set up for this install.");
    return 2;
  }
  const open = await loadAgentQueueOpener();
  const opened = await open(agentDbConnection(agent));
  try {
    const { upgradeSelfHosted } = await import("../self-hosted-upgrade.js");
    const host = currentAgentHost(bunHostRunner);
    const { exitCode } = await applyAgentUpdate({
      queue: opened.queue,
      request: { id: args.request, targetVersion: args.version, trigger: args.trigger },
      agentVersion: CAELO_VERSION,
      upgrade: (log) =>
        upgradeSelfHosted(
          {
            version: args.version,
            expectedDigests: { admin: args.adminDigest, gateway: args.gatewayDigest },
          },
          {
            caeloDir: ctx.caeloDir,
            runner: bunHostRunner,
            renderCompose: (images) => ctx.renderCompose(images),
            log,
          },
        ),
      selfUpdate: async () => {
        const r = await repinAgentUnits(unitSpec(ctx, CAELO_VERSION), host);
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
      log: journalLog,
    });
    return exitCode;
  } finally {
    await opened.close();
  }
}
