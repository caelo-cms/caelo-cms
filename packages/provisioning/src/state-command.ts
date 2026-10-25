// SPDX-License-Identifier: MPL-2.0

/**
 * CLI wiring for `cms-provision state migrate` and `cms-provision attach`
 * (#696): parses the flags, picks the install, and hands the engines
 * (state-migrate.ts, state-attach.ts) the real gcloud, Pulumi and file
 * system.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { confirm, isCancel, log, note } from "@clack/prompts";
import { bold, red } from "kleur/colors";
import { ADC_LOGIN_COMMAND, ADC_PROBE_ARGS, adcProbeFromResult } from "./adc-check.js";
import { checkAdcImpersonation } from "./adc-impersonation.js";
import { adoptionCandidates, existingCandidates } from "./adopt-existing.js";
import { checkGcloudAuth, gcloud } from "./gcloud.js";
import { GCP_STACK_ENV } from "./gcp-names.js";
import {
  adoptStateBackend,
  currentMetadata,
  ensureInstallDir,
  installFlag,
  installRoot,
  installStagingHost,
  listInstalls,
  readSecret,
  recordedImageDigests,
  selectInstall,
  writeSecret,
} from "./install-state.js";
import { installIapAllowlist } from "./operator-access.js";
import { ensureOpsBackend } from "./ops-backend.js";
import { writePlanFile } from "./preview-plan.js";
import { provisionerServiceAccountEmail } from "./provisioner-identity.js";
import {
  findRemoteMcpTarget,
  type RemoteMcpTarget,
  resolveStackRemoteMcpIdentity,
} from "./remote-mcp.js";
import { selfCommand } from "./self-command.js";
import type { RemoteMcpIdentity } from "./stack-contract.js";
import { attachInstall } from "./state-attach.js";
import {
  gcsBackendRecord,
  hasLocalPulumiState,
  installBackend,
  localStateDir,
  parseStateBackend,
  resolveBackend,
} from "./state-backend.js";
import { migrateState } from "./state-migrate.js";
import { realStatePulumiOps } from "./state-pulumi.js";
import { acquireStateLock, GcsStateStore, realSyncGcloud, type SyncGcloud } from "./state-store.js";
import { clackReporter } from "./upgrade/reporter.js";
import { GCP_STACK_KNOB_DEFAULTS } from "./wizards/gcp-pulumi.js";

/** Where install-dir archives go: `~/.caelo-backups/` (mode 700). */
export function backupsDir(home: string = homedir()): string {
  return join(home, ".caelo-backups");
}

/**
 * Archive `~/.caelo-<id>/` (secrets and state included) to
 * `~/.caelo-backups/<id>-<time>.tar.zst`, or `.tar.gz` when `zstd` is not
 * installed. The archive and its directory are private (600 / 700): it
 * holds the passphrase. Throws when the archive can't be made.
 *
 * @returns the archive's path
 */
export function backupInstallDir(
  installId: string,
  opts: { home?: string; now?: Date; hasZstd?: boolean } = {},
): string {
  const home = opts.home ?? homedir();
  const dir = backupsDir(home);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const base = join(dir, `${installId}-${stamp}`);
  const zstd = opts.hasZstd ?? spawnSync("zstd", ["--version"], { stdio: "ignore" }).status === 0;
  const source = ["-C", home, `.caelo-${installId}`];
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(
        `${cmd} failed while archiving ~/.caelo-${installId}: ${(r.stderr ?? "").trim()}`,
      );
    }
  };
  if (zstd) {
    const tar = `${base}.tar`;
    try {
      run("tar", ["-cf", tar, ...source]);
      chmodSync(tar, 0o600);
      run("zstd", ["-q", "--rm", "-o", `${tar}.zst`, tar]);
    } finally {
      rmSync(tar, { force: true });
    }
    chmodSync(`${tar}.zst`, 0o600);
    return `${tar}.zst`;
  }
  const out = `${base}.tar.gz`;
  run("tar", ["-czf", out, ...source]);
  chmodSync(out, 0o600);
  return out;
}

/** The value of `--<name> <v>` / `--<name>=<v>` on argv. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

const USAGE =
  "Usage: cms-provision state migrate [--install <install-id or domain>] [--to remote|local] [--dry-run] [--yes]";

/** `cms-provision state migrate …`. */
export async function stateCommand(argv: readonly string[]): Promise<void> {
  if (argv[3] !== "migrate") {
    console.log(USAGE);
    process.exit(2);
  }
  const to = flagValue(argv, "to") ?? "remote";
  if (to !== "remote" && to !== "local") {
    console.error(`--to must be remote or local.\n${USAGE}`);
    process.exit(2);
  }
  const dryRun = argv.includes("--dry-run");
  const selected = selectInstall(listInstalls(), installFlag(argv));
  if (!selected.ok) {
    console.error(selected.message);
    process.exit(1);
  }
  const meta = currentMetadata(selected.meta);
  const { installId } = meta;
  const root = installRoot(installId);
  if (
    (meta.provider !== "gcp" && meta.provider !== "gcp-firebase") ||
    !meta.projectId ||
    !meta.region
  ) {
    log.error(
      red(
        `${installId} (${meta.provider}) keeps its state on the host or has no project/region recorded; state migrate is for gcp and gcp-firebase installs.`,
      ),
    );
    process.exit(1);
  }
  const { projectId, region, provider } = meta;
  const imageDigests = recordedImageDigests(meta);
  if (!imageDigests) {
    log.error(
      red(
        `install.json of ${installId} records no image digests. Run ${bold(selfCommand("upgrade", "--install", installId))} first, then migrate.`,
      ),
    );
    process.exit(1);
  }
  const auth = await checkGcloudAuth();
  if (!auth.ok) {
    log.error(red(`Nothing was changed: ${auth.error}`));
    process.exit(1);
  }
  const operator = auth.account;
  const provisioner = provisionerServiceAccountEmail(projectId);
  note(
    [
      `Install:   ${bold(meta.domain)} (${installId}, project ${projectId}, ${region})`,
      `Direction: ${to === "remote" ? `this machine → gs://${gcsBackendRecord(projectId, region).bucket} + Cloud KMS` : "the install's bucket → this machine"}`,
      dryRun
        ? "Dry run:   nothing will be changed"
        : "The source stays in use until the copy is verified.",
    ].join("\n"),
    "state migrate",
  );

  const result = await migrateState(
    meta,
    { to, dryRun },
    {
      pulumi: realStatePulumiOps({
        provider,
        installRoot: root,
        impersonateServiceAccount: provisioner,
        stackConfig: {
          ...GCP_STACK_KNOB_DEFAULTS,
          provider,
          projectId,
          domain: meta.domain,
          stagingDomain: installStagingHost(meta),
          ownerEmail: meta.ownerEmail,
          region,
          iapAllowlist: installIapAllowlist(meta.ownerEmail),
          imageDigests,
        },
        resolveRemoteMcpIdentity: () =>
          resolveRemoteMcpIdentityForPreview({
            provider,
            projectId,
            region,
            env: GCP_STACK_ENV,
            domain: meta.domain,
          }),
      }),
      report: clackReporter(),
      checkAdc: () =>
        checkAdcImpersonation({ projectId, operatorAccount: operator, freshGrant: false }),
      resolve: (record) =>
        resolveBackend(
          { installId, stateBackend: record },
          { installRoot: root, readPassphrase: () => readSecret(installId, "pulumi-passphrase") },
        ),
      confirmCost: async (costNote) => {
        log.info(costNote);
        if (argv.includes("--yes")) return true;
        if (!process.stdin.isTTY) {
          log.error(red("Not a terminal: pass --yes to accept the cost above."));
          return false;
        }
        const yes = await confirm({ message: "Create them and continue?", initialValue: true });
        return !isCancel(yes) && yes === true;
      },
      ensureRemote: (dry) =>
        ensureOpsBackend(
          { projectId, region, operatorAccount: operator, provisionerEmail: provisioner },
          { dryRun: dry },
        ),
      backup: async () => backupInstallDir(installId),
      localStateEmpty: () => !hasLocalPulumiState(root),
      prepareLocalTarget: () => {
        mkdirSync(localStateDir(root), { recursive: true, mode: 0o700 });
        if (!readSecret(installId, "pulumi-passphrase")) {
          writeSecret(installId, "pulumi-passphrase", randomBytes(32).toString("hex"));
        }
      },
      lock: async () => {
        // The source's lock (local file or bucket object) keeps installer
        // runs out; the bucket's also keeps out a migration started on
        // another machine when the bucket is the target.
        const source = meta.stateBackend ?? { kind: "local" as const };
        const releases = [acquireStateLock(source, root, "state migrate")];
        if (source.kind === "local" && to === "remote") {
          try {
            releases.push(
              acquireStateLock(gcsBackendRecord(projectId, region), root, "state migrate"),
            );
          } catch (e) {
            for (const r of releases) r();
            throw e;
          }
        }
        return async () => {
          for (const r of releases.reverse()) r();
        };
      },
      remoteRecordedBackend: () => {
        const text = new GcsStateStore(gcsBackendRecord(projectId, region).bucket, root).peek(
          "install.json",
        );
        if (text === null) return null;
        return installBackend({ stateBackend: parseStateBackend(JSON.parse(text).stateBackend) })
          .kind;
      },
      adopt: (record) => {
        adoptStateBackend(installId, record);
      },
      retireLocalState: () => {
        const dir = localStateDir(root);
        if (!existsSync(dir)) return null;
        const moved = `${dir}.migrated-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        renameSync(dir, moved);
        return moved;
      },
      writePlan: (label, steps) => writePlanFile(root, label, steps),
      existingInProject: async (steps) =>
        (await existingCandidates(adoptionCandidates(steps, projectId), gcloud)).map(
          (c) => `${c.label} ${c.display}`,
        ),
    },
  );
  if (!result.ok) {
    log.error(red(result.error));
    process.exit(1);
  }
}

/** `cms-provision attach --project <id>`. */
export async function attachCommand(argv: readonly string[]): Promise<void> {
  const projectId = flagValue(argv, "project");
  if (!projectId || projectId.startsWith("-")) {
    console.log("Usage: cms-provision attach --project <gcp-project-id>");
    process.exit(2);
  }
  attachProject(projectId);
}

/**
 * Attach the install whose records live in `projectId`'s ops bucket (or
 * refresh this machine's copy of them); exits with the reason when that
 * fails. `upgrade --project` runs it first, so the break-glass upgrade
 * needs nothing to survive in $HOME between runs (#816).
 *
 * @returns the attached install's id
 */
export function attachProject(projectId: string): string {
  const r = attachInstall(projectId, {
    run: realSyncGcloud,
    rootFor: installRoot,
    hasLocalState: hasLocalPulumiState,
  });
  if (!r.ok) {
    log.error(red(r.error));
    process.exit(1);
  }
  ensureInstallDir(r.installId);
  log.success(
    r.status === "refreshed"
      ? `${r.domain} was already attached; its local copy of install.json is up to date.`
      : `Attached ${bold(r.domain)} (${r.installId}). status, upgrade, backup and re-running the installer now work from this machine.`,
  );
  const adc = adcNote(realSyncGcloud);
  if (adc) log.info(adc);
  return r.installId;
}

/**
 * The note `attach` prints about Application Default Credentials, or null
 * when this machine has working ones. Only infrastructure runs (re-running
 * the installer, `state migrate`) use ADC; `upgrade`, `status` and `backup`
 * do not, so a note on every attach sent Owners on a detour (#816).
 */
export function adcNote(run: SyncGcloud): string | null {
  const probe = adcProbeFromResult(run([...ADC_PROBE_ARGS]));
  if (probe.ok) return null;
  const state =
    probe.reason === "expired"
      ? "The Application Default Credentials on this machine have expired."
      : "No Application Default Credentials on this machine.";
  return `${state} upgrade, status and backup don't need them; re-running the installer or \`state migrate\` does: ${ADC_LOGIN_COMMAND}`;
}

/**
 * #1082 — the remote-MCP identity a preview gives the stack, read from the
 * live install exactly as the installer reads it before `up`
 * (remote-mcp.ts resolveStackRemoteMcpIdentity). Unreadable: null, with a
 * warning — the stack's recorded config then stands, and the preview shows
 * any difference from what the services carry.
 */
async function resolveRemoteMcpIdentityForPreview(
  base: Omit<RemoteMcpTarget, "services">,
): Promise<RemoteMcpIdentity | null> {
  const found = await findRemoteMcpTarget(base);
  const resolved = found.ok ? await resolveStackRemoteMcpIdentity(found.target) : found;
  if (resolved.ok) return resolved.identity;
  log.warn(`Could not read the remote-MCP URLs and IAP audience: ${resolved.error}`);
  return null;
}
