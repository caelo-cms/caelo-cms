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
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { log, note } from "@clack/prompts";
import { bold, red } from "kleur/colors";
import { activeAccount } from "./gcloud.js";
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
import { provisionerServiceAccountEmail } from "./provisioner-identity.js";
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
import { GcsStateStore, realSyncGcloud, type SyncGcloud } from "./state-store.js";
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

/**
 * Take `gs://<bucket>/install/migrate.lock`, created only if absent
 * (`--if-generation-match=0`), so two machines can't migrate one install at
 * once. A lock left by a crashed run is reported with the command to remove
 * it — never broken automatically.
 *
 * @returns the release function
 */
export function migrationLock(bucket: string, run: SyncGcloud): () => Promise<void> {
  const url = `gs://${bucket}/install/migrate.lock`;
  const body = JSON.stringify({
    host: hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  const r = run(["storage", "cp", "-", url, "--if-generation-match=0"], body);
  if (!r.ok) {
    if (/PreconditionFailed|412|At least one of the pre-conditions/i.test(r.stderr)) {
      const held = run(["storage", "cat", url]);
      throw new Error(
        `Another state migration of this install is running (${held.ok ? held.stdout.trim() : url}). If none is, remove the stale lock: gcloud storage rm ${url}`,
      );
    }
    throw new Error(`Could not take the migration lock ${url}: ${r.stderr.trim()}`);
  }
  return async () => {
    const rm = run(["storage", "rm", url]);
    if (!rm.ok) throw new Error(`Could not release ${url}; remove it: gcloud storage rm ${url}`);
  };
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
  "Usage: cms-provision state migrate [--install <install-id or domain>] [--to remote|local] [--dry-run]";

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
        `install.json of ${installId} records no image digests. Run ${bold(`bunx @caelo-cms/provisioning upgrade --install ${installId}`)} first, then migrate.`,
      ),
    );
    process.exit(1);
  }
  const operator = await activeAccount();
  if (!operator) {
    log.error(red("No active gcloud account. Run `gcloud auth login`, then re-run."));
    process.exit(1);
  }
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
      }),
      report: clackReporter(),
      resolve: (record) =>
        resolveBackend(
          { installId, stateBackend: record },
          { installRoot: root, readPassphrase: () => readSecret(installId, "pulumi-passphrase") },
        ),
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
      lock: async () => migrationLock(gcsBackendRecord(projectId, region).bucket, realSyncGcloud),
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
  log.info(
    "Infrastructure runs need Application Default Credentials once on this machine: gcloud auth application-default login",
  );
}
