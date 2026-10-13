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
import { rmSync, writeFileSync } from "node:fs";
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

  return {
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
      const resources = ((await stack.exportStack()).deployment?.resources ??
        []) as StateResource[];
      await applyStackConfig(stack, inputs.stackConfig, resources);
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
}
