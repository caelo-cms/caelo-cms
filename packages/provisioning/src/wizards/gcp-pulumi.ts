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
import { checkpointableOutputs } from "../checkpoint-secrets.js";
import { GCP_STACK_ENV } from "../gcp-names.js";
import type { ImageDigests } from "../install-state.js";
import {
  AMBIENT_GOOGLE_CREDENTIAL_ENV,
  withoutAmbientGoogleCredentials,
} from "../provisioner-identity.js";
import { ensureGeneratedSecrets, stackSecretReplication } from "../runtime-secrets.js";

export interface PulumiUpInputs {
  installId: string;
  installRoot: string;
  secretsDir: string;
  projectId: string;
  domain: string;
  /** #650 — the protected staging site's host (install setting). */
  stagingDomain: string;
  ownerEmail: string;
  region: string;
  /**
   * #696 — the service account Pulumi's GCP provider impersonates
   * (`caelo-provisioner@<project>`), with the operator's Application Default
   * Credentials as the source. No key file.
   */
  impersonateServiceAccount: string;
  pulumiPassphrase: string;
  cloudSqlTier: string;
  cloudSqlHa: boolean;
  adminMinInstances: number;
  /** #553 — admin memory (`2Gi`): it runs the Lighthouse quality audit. */
  adminMemory: string;
  gatewayMinInstances: number;
  wafAdaptiveProtection: boolean;
  iapAllowlist: string[];
  /** Resolved sha256 digests per service (admin, gateway). The wizard
   *  pre-resolves the floating `:latest` release tag to a fixed digest
   *  so each pulumi up rolls Cloud Run to the newest release image. */
  imageDigests: ImageDigests;
  /**
   * v0.3.1 — provider variant. Selects which stack dir to apply
   * + which config namespace (caelo-gcp vs caelo-gcp-firebase).
   * Defaults to 'gcp' for backwards compatibility.
   */
  provider?: "gcp" | "gcp-firebase";
}

export interface PulumiUpResult {
  /**
   * The stack outputs safe to checkpoint: no output Pulumi marks secret and
   * none holding a credential (the Owner setup link). Code that needs a
   * secret output reads it with {@link readStackOutput} when it needs it
   * (#656).
   */
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
 * The stack config keys that pin each Cloud Run service's image
 * (`<ns>:image-digest-<service>`, read by `imageRef` / `imageTag` in the
 * stacks). Shared by the wizard and by `upgrade`'s write-back so both pin
 * the same keys.
 */
export function imageDigestConfig(
  provider: "gcp" | "gcp-firebase",
  digests: ImageDigests,
): Record<string, { value: string }> {
  return Object.fromEntries(
    Object.entries(digests).map(([service, digest]) => [
      `caelo-${provider}:image-digest-${service}`,
      { value: digest },
    ]),
  );
}

/**
 * Write the digests `upgrade` rolled to into the install's Pulumi stack
 * config, without running `pulumi up`, so a later `pulumi up` keeps them
 * instead of re-resolving the floating tag. On `gcp`, an `image-<service>`
 * override wins over the digest pin (stacks/gcp `imageTag`), so any such
 * override is removed: it no longer describes what the service runs.
 * Needs the `pulumi` CLI (the Automation API shells out to it); throws when
 * the CLI or the stack is missing — the caller reports that.
 *
 * @returns the override keys it removed.
 */
export async function writeImageDigestsToStack(inputs: {
  installRoot: string;
  pulumiPassphrase: string;
  provider: "gcp" | "gcp-firebase";
  digests: ImageDigests;
}): Promise<{ removedOverrides: string[] }> {
  const stack = await pulumi.LocalWorkspace.selectStack(
    { stackName: GCP_STACK_ENV, workDir: gcpStackWorkDir(inputs.provider) },
    {
      envVars: {
        PULUMI_CONFIG_PASSPHRASE: inputs.pulumiPassphrase,
        PULUMI_BACKEND_URL: `file://${join(inputs.installRoot, "state")}`,
      },
    },
  );
  await stack.setAllConfig(imageDigestConfig(inputs.provider, inputs.digests));
  const config = await stack.getAllConfig();
  const removedOverrides = imageOverrideKeys(inputs.provider).filter((k) => k in config);
  if (removedOverrides.length > 0) await stack.removeAllConfig(removedOverrides);
  return { removedOverrides };
}

/**
 * One output of the install's stack, secrets included (the Automation API's
 * `pulumi stack output --show-secrets`). Read at the moment of use, never
 * checkpointed (#656). Needs the `pulumi` CLI and the stack's state.
 *
 * @returns the output's value, or undefined when the stack has no such output
 */
export async function readStackOutput(inputs: {
  installRoot: string;
  pulumiPassphrase: string;
  provider: "gcp" | "gcp-firebase";
  name: string;
}): Promise<unknown> {
  const stack = await pulumi.LocalWorkspace.selectStack(
    { stackName: GCP_STACK_ENV, workDir: gcpStackWorkDir(inputs.provider) },
    {
      envVars: {
        PULUMI_CONFIG_PASSPHRASE: inputs.pulumiPassphrase,
        PULUMI_BACKEND_URL: `file://${join(inputs.installRoot, "state")}`,
      },
    },
  );
  const outputs = await stack.outputs();
  return outputs[inputs.name]?.value;
}

/**
 * Stack config keys that override the image a service runs, ahead of the
 * digest pin. Only the `gcp` stack reads them.
 */
function imageOverrideKeys(provider: "gcp" | "gcp-firebase"): string[] {
  return provider === "gcp" ? ["caelo-gcp:image-admin", "caelo-gcp:image-gateway"] : [];
}

/**
 * Pick the stack's `secretReplication` (see stacks/<provider>/index.ts).
 * A value already in config wins. Otherwise secrets that already exist
 * in state with `auto` replication keep it — switching would replace
 * them — and everything else (new stacks) gets `regional`.
 */
export function resolveSecretReplication(
  configured: string | undefined,
  stateResources: ReadonlyArray<{ type?: string; outputs?: Record<string, unknown> }>,
): "auto" | "regional" {
  if (configured === "auto" || configured === "regional") return configured;
  if (configured !== undefined) {
    throw new Error(`secretReplication must be "auto" or "regional", got "${configured}"`);
  }
  const hasAutoSecret = stateResources.some((r) => {
    if (r.type !== "gcp:secretmanager/secret:Secret") return false;
    const replication = r.outputs?.replication as { auto?: unknown } | undefined;
    return replication?.auto != null;
  });
  return hasAutoSecret ? "auto" : "regional";
}

/** A resource as `pulumi stack export` lists it. */
interface StateResource {
  type?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

/**
 * The region an existing stack was deployed in, read from its state (the
 * stacks' explicit `gcp.Provider` carries it), or null for a stack with
 * nothing deployed. State, not stack config: the config file lives in the
 * package's stack dir, which a newer `bunx` version doesn't share.
 */
export function deployedStackRegion(resources: ReadonlyArray<StateResource>): string | null {
  const regions = new Set(
    resources
      .filter((r) => r.type === "pulumi:providers:gcp")
      .map((r) => r.inputs?.region)
      .filter((v): v is string => typeof v === "string" && v.length > 0),
  );
  if (regions.size > 1) {
    throw new Error(
      `the Pulumi state holds GCP providers for several regions (${[...regions].join(", ")}); fix the stack before re-running.`,
    );
  }
  return [...regions][0] ?? null;
}

/**
 * Refuse to `up` a stack into another region than it was deployed in
 * (#607): Pulumi would replace Cloud SQL, the buckets and the services.
 */
export function assertStackRegion(deployed: string | null, requested: string): void {
  if (deployed && deployed !== requested) {
    throw new Error(
      `this install's stack is deployed in ${deployed}, but the run asks for ${requested}. The region is fixed after install — moving it would replace the database, buckets and services. Set "region": "${deployed}" in install.json and re-run.`,
    );
  }
}

/**
 * The environment `pulumi refresh` / `pulumi up` run with (#696).
 *
 * Pulumi's GCP provider impersonates the provisioner service account
 * (`GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`, read by the provider plugin itself,
 * so it also applies to the stacks' explicit `gcp.Provider` and never enters
 * the stack's state or its provider inputs). The source credential is the
 * operator's Application Default Credentials — refreshable, so the provider
 * re-mints the impersonated token whenever it expires and a run longer than
 * an hour keeps working. Ambient credential variables are dropped so neither
 * a key file (`GOOGLE_APPLICATION_CREDENTIALS`) nor a static token that dies
 * after an hour can take the place of that chain. They are set to "" rather
 * than left out: the Automation API (execa) merges this process's environment
 * into the child's, and Google's libraries treat an empty value as unset. The
 * passphrase and backend are scoped to the child process only.
 */
export function pulumiGcpEnv(
  base: NodeJS.ProcessEnv,
  inputs: Pick<PulumiUpInputs, "installRoot" | "pulumiPassphrase" | "impersonateServiceAccount">,
): Record<string, string> {
  return {
    ...withoutAmbientGoogleCredentials(base),
    ...Object.fromEntries(AMBIENT_GOOGLE_CREDENTIAL_ENV.map((k) => [k, ""])),
    PULUMI_CONFIG_PASSPHRASE: inputs.pulumiPassphrase,
    GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: inputs.impersonateServiceAccount,
    // Pulumi local-backend state lives under the install's state dir.
    PULUMI_BACKEND_URL: `file://${join(inputs.installRoot, "state")}`,
  };
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
  const env = pulumiGcpEnv(process.env, inputs);

  const provider = inputs.provider ?? "gcp";
  const stackName = GCP_STACK_ENV;
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

  const stateResources = ((await stack.exportStack()).deployment?.resources ??
    []) as StateResource[];
  assertStackRegion(deployedStackRegion(stateResources), inputs.region);

  // Set every config value the stack reads. Secrets via setConfig with
  // {value, secret: true}; Pulumi encrypts them in state.
  // wafAdaptiveProtection is gcp-only; the gcp-firebase stack has no
  // Cloud Armor + ignores the key, but setting it does no harm.
  await stack.setAllConfig({
    [`${ns}:project`]: { value: inputs.projectId },
    [`${ns}:domain`]: { value: inputs.domain },
    [`${ns}:stagingDomain`]: { value: inputs.stagingDomain },
    [`${ns}:ownerEmail`]: { value: inputs.ownerEmail },
    [`${ns}:region`]: { value: inputs.region },
    [`${ns}:cloudSqlTier`]: { value: inputs.cloudSqlTier },
    [`${ns}:cloudSqlHa`]: { value: String(inputs.cloudSqlHa) },
    [`${ns}:adminMinInstances`]: { value: String(inputs.adminMinInstances) },
    [`${ns}:adminMemory`]: { value: inputs.adminMemory },
    [`${ns}:gatewayMinInstances`]: { value: String(inputs.gatewayMinInstances) },
    ...(provider === "gcp"
      ? { [`${ns}:wafAdaptiveProtection`]: { value: String(inputs.wafAdaptiveProtection) } }
      : {}),
    [`${ns}:iapAllowlist`]: { value: inputs.iapAllowlist.join(",") },
    // v0.3.2 — anthropicApiKey config dropped. Runtime path is
    // /settings/ai → ai_providers (KEK-encrypted). The pre-v0.3.2
    // Secret + SecretVersion in Secret Manager were never mounted
    // on Cloud Run, so the config was dead.
    ...imageDigestConfig(provider, inputs.imageDigests),
  });

  // Read back only after the required keys are set: `pulumi config` refuses to
  // list a stack that lacks them, which is every fresh stack.
  const configuredReplication = await stack.getConfig(`${ns}:secretReplication`).then(
    (v) => v.value,
    (e: unknown) => {
      if (/not found/i.test(String(e))) return undefined;
      throw e;
    },
  );
  const secretReplication = resolveSecretReplication(configuredReplication, stateResources);
  await stack.setConfig(`${ns}:secretReplication`, { value: secretReplication });

  // The stack references the CLI-generated runtime secrets (stack-contract.ts
  // CLI_GENERATED_SECRETS) by id, so they must exist before `up`.
  const generated = await ensureGeneratedSecrets({
    projectId: inputs.projectId,
    env: stackName,
    region: inputs.region,
    replication: stackSecretReplication(secretReplication, inputs.region),
  });
  const notEnsured = generated.filter((o) => o.status === "failed");
  if (notEnsured.length > 0) {
    throw new Error(
      `could not create the runtime secrets: ${notEnsured.map((o) => `${o.id}: ${o.error ?? ""}`).join("; ")}`,
    );
  }
  for (const o of generated) {
    if (o.detail) onEvent("log", `created ${o.id} (${o.detail})\n`);
  }

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
  return {
    outputs: checkpointableOutputs(result.outputs),
    resourceCount: {
      created: changes.create ?? 0,
      updated: changes.update ?? 0,
      deleted: changes.delete ?? 0,
    },
  };
}
