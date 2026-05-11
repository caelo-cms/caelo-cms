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
  /**
   * v0.3.1 — provider variant. Selects which stack dir to apply
   * + which config namespace (caelo-gcp vs caelo-gcp-firebase).
   * Defaults to 'gcp' for backwards compatibility.
   */
  provider?: "gcp" | "gcp-firebase";
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
function gcpStackWorkDir(provider: "gcp" | "gcp-firebase" = "gcp"): string {
  // The Pulumi.yaml + stacks/<provider>/index.ts ship in the npm
  // tarball under `stacks/<provider>/`. From this file's location at
  // runtime (dist/wizards/gcp-pulumi.js), the stack dir is two
  // levels up + into the provider-specific stack folder.
  return resolvePath(import.meta.dir, `../../stacks/${provider}`);
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

  const provider = inputs.provider ?? "gcp";
  const stackName = "production";
  const workDir = gcpStackWorkDir(provider);
  // Pulumi config namespace mirrors the stack's `name:` field in
  // Pulumi.yaml (caelo-gcp vs caelo-gcp-firebase).
  const ns = `caelo-${provider}`;

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
  // wafAdaptiveProtection is gcp-only; the gcp-firebase stack has no
  // Cloud Armor + ignores the key, but setting it does no harm.
  await stack.setAllConfig({
    [`${ns}:project`]: { value: inputs.projectId },
    [`${ns}:domain`]: { value: inputs.domain },
    [`${ns}:ownerEmail`]: { value: inputs.ownerEmail },
    [`${ns}:region`]: { value: inputs.region },
    [`${ns}:cloudSqlTier`]: { value: inputs.cloudSqlTier },
    [`${ns}:cloudSqlHa`]: { value: String(inputs.cloudSqlHa) },
    [`${ns}:adminMinInstances`]: { value: String(inputs.adminMinInstances) },
    [`${ns}:gatewayMinInstances`]: { value: String(inputs.gatewayMinInstances) },
    ...(provider === "gcp"
      ? { [`${ns}:wafAdaptiveProtection`]: { value: String(inputs.wafAdaptiveProtection) } }
      : {}),
    [`${ns}:iapAllowlist`]: { value: inputs.iapAllowlist.join(",") },
    // v0.3.2 — anthropicApiKey config dropped. Runtime path is
    // /security/ai → ai_providers (KEK-encrypted). The pre-v0.3.2
    // Secret + SecretVersion in Secret Manager were never mounted
    // on Cloud Run, so the config was dead.
    ...Object.fromEntries(
      Object.entries(inputs.imageDigests).map(([service, digest]) => [
        `${ns}:image-digest-${service}`,
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
