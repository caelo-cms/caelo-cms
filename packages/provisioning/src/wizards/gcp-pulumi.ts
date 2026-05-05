// SPDX-License-Identifier: MPL-2.0

/**
 * Pulumi Automation SDK wrapper for the GCP wizard. Replaces the
 * shell-out `pulumi up` flow with a programmatic equivalent that
 * streams progress events into the wizard's UI.
 *
 * Per CLAUDE.md §11.C: end-users never see `pulumi` directly. The
 * wizard handles passphrase + state location + config + up; failures
 * surface inline with provider errors.
 */

import { join, resolve as resolvePath } from "node:path";
import * as pulumi from "@pulumi/pulumi/automation";

export interface PulumiUpInputs {
  installId: string;
  installRoot: string;
  secretsDir: string;
  projectId: string;
  domain: string;
  ownerEmail: string;
  region: string;
  saKeyPath: string;
  pulumiPassphrase: string;
  anthropicApiKey: string;
  cloudSqlTier: string;
  cloudSqlHa: boolean;
  adminMinInstances: number;
  gatewayMinInstances: number;
  wafAdaptiveProtection: boolean;
  iapAllowlist: string[];
  /** Resolved sha256 digests per service (admin, gateway). The wizard
   *  pre-resolves the floating `:main` tag to a fixed digest so each
   *  pulumi up rolls Cloud Run to the freshest published image. */
  imageDigests: Record<string, string>;
}

export interface PulumiUpResult {
  outputs: Record<string, unknown>;
  resourceCount: { created: number; updated: number; deleted: number };
}

/**
 * Resolve the GCP stack workdir relative to the installed package.
 * Works whether the CLI runs from source (apps/admin/scripts/...)
 * or from the published npm tarball (node_modules/@caelo-cms/...).
 */
function gcpStackWorkDir(): string {
  // The Pulumi.yaml + stacks/gcp/index.ts ship in the npm tarball
  // under `stacks/gcp/`. From this file's location at runtime
  // (dist/wizards/gcp-pulumi.js), the stack dir is two levels up
  // + into stacks/gcp/.
  return resolvePath(import.meta.dir, "../../stacks/gcp");
}

/**
 * Run `pulumi up` against the GCP stack via the Automation SDK.
 * Streams resource-create events to the supplied onEvent callback so
 * the wizard can render a live progress bar.
 */
export async function pulumiUpGcp(
  inputs: PulumiUpInputs,
  onEvent: (kind: "resource" | "error" | "log", message: string) => void,
): Promise<PulumiUpResult> {
  // Pulumi's local backend reads the passphrase from
  // PULUMI_CONFIG_PASSPHRASE; we set it for this process scope only.
  // Same for the GOOGLE_APPLICATION_CREDENTIALS pointing at the SA key.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PULUMI_CONFIG_PASSPHRASE: inputs.pulumiPassphrase,
    GOOGLE_APPLICATION_CREDENTIALS: inputs.saKeyPath,
    // Pulumi local-backend state lives under the install's state dir.
    PULUMI_BACKEND_URL: `file://${join(inputs.installRoot, "state")}`,
  };

  const stackName = "production";
  const workDir = gcpStackWorkDir();

  const stack = await pulumi.LocalWorkspace.createOrSelectStack(
    {
      stackName,
      workDir,
    },
    {
      envVars: env,
    },
  );

  // Set every config value the stack reads. Secrets via setConfig with
  // {value, secret: true}; Pulumi encrypts them in state.
  await stack.setAllConfig({
    "caelo-gcp:project": { value: inputs.projectId },
    "caelo-gcp:domain": { value: inputs.domain },
    "caelo-gcp:ownerEmail": { value: inputs.ownerEmail },
    "caelo-gcp:region": { value: inputs.region },
    "caelo-gcp:cloudSqlTier": { value: inputs.cloudSqlTier },
    "caelo-gcp:cloudSqlHa": { value: String(inputs.cloudSqlHa) },
    "caelo-gcp:adminMinInstances": { value: String(inputs.adminMinInstances) },
    "caelo-gcp:gatewayMinInstances": { value: String(inputs.gatewayMinInstances) },
    "caelo-gcp:wafAdaptiveProtection": { value: String(inputs.wafAdaptiveProtection) },
    "caelo-gcp:iapAllowlist": { value: inputs.iapAllowlist.join(",") },
    "caelo-gcp:anthropicApiKey": { value: inputs.anthropicApiKey, secret: true },
    ...Object.fromEntries(
      Object.entries(inputs.imageDigests).map(([service, digest]) => [
        `caelo-gcp:image-digest-${service}`,
        { value: digest },
      ]),
    ),
  });

  // Refresh state first to detect drift from any out-of-band changes.
  await stack.refresh({ onOutput: (msg) => onEvent("log", msg) });

  // Run `up`. The onEvent callback receives the same JSON-RPC events
  // Pulumi prints to stdout in --json mode.
  const result = await stack.up({
    onOutput: (msg) => onEvent("log", msg),
    onEvent: (event) => {
      // We only care about resource start/finish events for the
      // progress UI — diagnostics surface via onOutput already.
      if (event.resOpFailedEvent) {
        onEvent(
          "error",
          `${event.resOpFailedEvent.metadata.urn}: ${event.resOpFailedEvent.status}`,
        );
      } else if (event.resOutputsEvent) {
        onEvent("resource", event.resOutputsEvent.metadata.urn);
      }
    },
  });

  const summary = result.summary;
  const changes = summary.resourceChanges ?? {};
  const outputs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result.outputs)) {
    outputs[k] = v.value;
  }

  return {
    outputs,
    resourceCount: {
      created: changes.create ?? 0,
      updated: changes.update ?? 0,
      deleted: changes.delete ?? 0,
    },
  };
}
