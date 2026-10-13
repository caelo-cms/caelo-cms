// SPDX-License-Identifier: MPL-2.0

/**
 * The real {@link StatePulumiOps} for `state migrate` (#696): the Pulumi CLI
 * (state operations) and the Automation API (previews), always in the
 * install's stack dir and with exactly the backend's environment. The
 * operator never runs `pulumi` by hand (CLAUDE.md §11.C).
 *
 * Secrets: outputs are read with `--show-secrets` only to hash them; the
 * values never leave {@link outputsDigest}. The export/import fallback
 * writes the deployment without `--show-secrets` (ciphertext only) to a
 * mode-600 file in the install dir and deletes it afterwards.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as automation from "@pulumi/pulumi/automation";
import { redactCredentials } from "./checkpoint-secrets.js";
import { GCP_STACK_ENV } from "./gcp-names.js";
import type { ResolvedBackend } from "./state-backend.js";
import type { StatePulumiOps } from "./state-migrate.js";
import {
  alignStackSettingsFile,
  applyStackConfig,
  gcpStackWorkDir,
  pulumiGcpEnv,
  type StackConfigInputs,
  type StateResource,
  stateOnlyEnv,
} from "./wizards/gcp-pulumi.js";

/** Every file below `dir`. */
function listFilesRecursive(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

/** Canonical JSON (sorted keys) so equal outputs hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Steps of a preview's change summary other than "same". */
export function changeCount(summary: Readonly<Record<string, number | undefined>>): number {
  return Object.entries(summary)
    .filter(([op]) => op !== "same")
    .reduce((n, [, c]) => n + (c ?? 0), 0);
}

interface Deployment {
  pending_operations?: unknown[];
  secrets_providers?: {
    type?: string;
    state?: { salt?: string; url?: string; encryptedkey?: string };
  };
  resources?: StateResource[];
}

export interface RealPulumiOpsInputs {
  readonly provider: "gcp" | "gcp-firebase";
  readonly installRoot: string;
  /** The service account the GCP provider impersonates during previews. */
  readonly impersonateServiceAccount: string;
  /** The config a wizard run sets, so a preview shows real drift only. */
  readonly stackConfig: StackConfigInputs;
}

/** {@link StatePulumiOps} backed by the `pulumi` CLI + Automation API. */
export function realStatePulumiOps(inputs: RealPulumiOpsInputs): StatePulumiOps {
  const workDir = gcpStackWorkDir(inputs.provider);

  const cli = async (
    args: string[],
    env: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string }> => {
    const p = Bun.spawn(["pulumi", ...args, "--cwd", workDir, "--non-interactive"], {
      env: { ...process.env, ...env, PULUMI_SKIP_UPDATE_CHECK: "true" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    if ((await p.exited) !== 0) {
      throw new Error(
        `pulumi ${args[0]} ${args[1] ?? ""} failed: ${redactCredentials(stderr.trim().split("\n").slice(-3).join(" "))}`,
      );
    }
    return { stdout, stderr };
  };

  // The read-only steps (preflight, verification) align the package's
  // stack settings file and may set config to run a preview; the file is
  // put back exactly as it was afterwards, so a refused migration or a dry
  // run leaves it untouched.
  const settingsFile = join(workDir, `Pulumi.${GCP_STACK_ENV}.yaml`);
  const preserved = async <T>(fn: () => Promise<T>): Promise<T> => {
    // Read without a separate existence check (no check-then-use race), and
    // put the file back atomically (temp file + rename).
    let before: Buffer | null;
    try {
      before = readFileSync(settingsFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      before = null;
    }
    try {
      return await fn();
    } finally {
      if (before === null) rmSync(settingsFile, { force: true });
      else {
        const tmp = `${settingsFile}.restore-${process.pid}`;
        writeFileSync(tmp, before, { flag: "w" });
        renameSync(tmp, settingsFile);
      }
    }
  };

  const exportDeployment = async (b: ResolvedBackend): Promise<Deployment> => {
    await alignStackSettingsFile(b, inputs.provider);
    const { stdout } = await cli(["stack", "export", "--stack", GCP_STACK_ENV], stateOnlyEnv(b));
    return ((JSON.parse(stdout) as { deployment?: Deployment }).deployment ?? {}) as Deployment;
  };

  /** Env for an operation that reads one backend and writes another. */
  const bothEnv = (from: ResolvedBackend, to: ResolvedBackend): Record<string, string> => ({
    ...stateOnlyEnv(from),
    ...stateOnlyEnv(to),
  });

  const ops: StatePulumiOps = {
    async cliVersion() {
      const p = Bun.spawnSync(["pulumi", "version"], { stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) return null;
      return new TextDecoder().decode(p.stdout).trim().replace(/^v/, "") || null;
    },

    async stackExists(b) {
      const { stdout } = await cli(["stack", "ls", "--json"], stateOnlyEnv(b));
      const stacks = JSON.parse(stdout || "[]") as { name?: string }[];
      return stacks.some((s) => s.name === GCP_STACK_ENV || s.name?.endsWith(`/${GCP_STACK_ENV}`));
    },

    async locked(b) {
      // Pulumi's DIY backends keep one lock file per running operation under
      // .pulumi/locks/ (file:// and gs:// alike).
      if (b.url.startsWith("file://")) {
        const dir = join(b.url.slice("file://".length), ".pulumi", "locks");
        return existsSync(dir) && listFilesRecursive(dir).length > 0;
      }
      const r = Bun.spawnSync(["gcloud", "storage", "ls", `${b.url}/.pulumi/locks/**`], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" },
      });
      if (r.exitCode === 0) return new TextDecoder().decode(r.stdout).trim().length > 0;
      const err = new TextDecoder().decode(r.stderr);
      if (/matched no objects|No URLs matched|NotFound|404/i.test(err)) return false;
      throw new Error(`Could not check the stack lock in ${b.url}: ${err.trim()}`);
    },

    async stateDigest(b) {
      const deployment = await exportDeployment(b);
      return createHash("sha256").update(canonicalJson(deployment)).digest("hex");
    },

    async pendingOperations(b) {
      return (await exportDeployment(b)).pending_operations?.length ?? 0;
    },

    async previewChanges(b) {
      await alignStackSettingsFile(b, inputs.provider);
      const stack = await automation.LocalWorkspace.selectStack(
        { stackName: GCP_STACK_ENV, workDir },
        {
          envVars: pulumiGcpEnv(process.env, {
            backend: b,
            impersonateServiceAccount: inputs.impersonateServiceAccount,
          }),
        },
      );
      // The stack's own config wins: an operator may have tuned a knob
      // (`pulumi config set`), and resetting it would show as drift. Only a
      // stack dir without the install's config (a fresh `bunx` version)
      // gets what the wizard sets — as does one holding another install's
      // config (installs of one provider share the package's stack dir).
      const config: automation.ConfigMap = await stack.getAllConfig().catch(() => ({}));
      if (config[`caelo-${inputs.provider}:project`]?.value !== inputs.stackConfig.projectId) {
        const resources = ((await stack.exportStack()).deployment?.resources ??
          []) as StateResource[];
        await applyStackConfig(stack, inputs.stackConfig, resources);
      }
      const r = await stack.preview({ refresh: true });
      return changeCount(r.changeSummary);
    },

    async outputsDigest(b) {
      await alignStackSettingsFile(b, inputs.provider);
      const { stdout } = await cli(
        ["stack", "output", "--stack", GCP_STACK_ENV, "--json", "--show-secrets"],
        stateOnlyEnv(b),
      );
      return createHash("sha256")
        .update(canonicalJson(JSON.parse(stdout || "{}")))
        .digest("hex");
    },

    async stackMigrate(from, to) {
      await alignStackSettingsFile(from, inputs.provider);
      await cli(
        [
          "stack",
          "migrate",
          from.url,
          GCP_STACK_ENV,
          "--secrets-provider",
          to.secretsProvider,
          "--yes",
        ],
        bothEnv(from, to),
      );
    },

    async exportImport(from, to) {
      const deployment = await exportDeployment(from);
      const file = join(inputs.installRoot, `.migrate-export-${process.pid}.json`);
      try {
        const { stdout } = await cli(
          ["stack", "export", "--stack", GCP_STACK_ENV],
          stateOnlyEnv(from),
        );
        writeFileSync(file, stdout, { mode: 0o600 });
        // The target stack starts with the source's secrets manager, so the
        // imported ciphertext decrypts; change-secrets-provider re-encrypts.
        const ws = await automation.LocalWorkspace.create({ workDir, envVars: stateOnlyEnv(to) });
        const settings = await ws.stackSettings(GCP_STACK_ENV).catch(() => ({}));
        const sp = deployment.secrets_providers;
        const {
          secretsProvider: _p,
          encryptedKey: _k,
          encryptionSalt: _s,
          ...rest
        } = settings as automation.StackSettings;
        await ws.saveStackSettings(GCP_STACK_ENV, {
          ...rest,
          ...(sp?.type === "passphrase" && sp.state?.salt ? { encryptionSalt: sp.state.salt } : {}),
          ...(sp?.type === "cloud" && sp.state?.url
            ? { secretsProvider: sp.state.url, encryptedKey: sp.state.encryptedkey }
            : {}),
        });
        await cli(
          ["stack", "init", GCP_STACK_ENV, "--secrets-provider", from.secretsProvider],
          bothEnv(from, to),
        );
        await cli(["stack", "import", "--stack", GCP_STACK_ENV, "--file", file], bothEnv(from, to));
        await cli(
          ["stack", "change-secrets-provider", "--stack", GCP_STACK_ENV, to.secretsProvider],
          bothEnv(from, to),
        );
      } finally {
        rmSync(file, { force: true });
      }
    },

    async removeStack(b) {
      await cli(
        ["stack", "rm", GCP_STACK_ENV, "--force", "--yes", "--preserve-config"],
        stateOnlyEnv(b),
      );
    },
  };
  return {
    ...ops,
    pendingOperations: (b) => preserved(() => ops.pendingOperations(b)),
    stateDigest: (b) => preserved(() => ops.stateDigest(b)),
    previewChanges: (b) => preserved(() => ops.previewChanges(b)),
    outputsDigest: (b) => preserved(() => ops.outputsDigest(b)),
  };
}
