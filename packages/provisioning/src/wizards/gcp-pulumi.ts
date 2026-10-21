// SPDX-License-Identifier: MPL-2.0

/**
 * Pulumi Automation SDK wrapper for the GCP wizard. Replaces the
 * shell-out `pulumi up` flow with a programmatic equivalent that
 * streams progress events into the wizard's UI.
 *
 * Per CLAUDE.md §11.C: end-users never see `pulumi` directly. The
 * wizard handles the state backend (state-backend.ts: the install's ops
 * bucket + KMS key, or the local dir + passphrase of an older install),
 * config and up; failures surface inline with provider errors.
 */

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import * as pulumi from "@pulumi/pulumi/automation";
import { AUDIT_PARALLELISM_DEFAULT } from "../audit-job-setup.js";
import { checkpointableOutputs } from "../checkpoint-secrets.js";
import { GCP_STACK_ENV } from "../gcp-names.js";
import { type ImageDigests, stackWorkDir } from "../install-state.js";
import {
  AMBIENT_GOOGLE_CREDENTIAL_ENV,
  withoutAmbientGoogleCredentials,
} from "../provisioner-identity.js";
import { ensureGeneratedSecrets, stackSecretReplication } from "../runtime-secrets.js";
import { ADMIN_MEMORY_DEFAULT } from "../stack-contract.js";
import type { ResolvedBackend } from "../state-backend.js";

/**
 * The §11.B knobs every wizard run sets (and the cost table prices). One
 * place, so `state migrate`'s verification previews set the same config the
 * wizard does.
 */
export const GCP_STACK_KNOB_DEFAULTS = {
  cloudSqlTier: "db-f1-micro",
  cloudSqlHa: false,
  adminMinInstances: 0,
  adminMemory: ADMIN_MEMORY_DEFAULT,
  gatewayMinInstances: 0,
  wafAdaptiveProtection: false,
  /**
   * #875 — audit tasks at once. Not stack config: the audit job is
   * CLI-owned (audit-job-setup.ts), so the wizard passes it to the job and
   * `upgrade` keeps whatever the job has.
   */
  auditParallelism: AUDIT_PARALLELISM_DEFAULT,
} as const;

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
   * Credentials as the source. No key file. Null when this process runs AS
   * the provisioner (the install job, install-job.ts): its ambient
   * metadata-server credentials are the provisioner's own.
   */
  impersonateServiceAccount: string | null;
  /** #696 — where the stack's state lives (state-backend.ts resolveBackend). */
  backend: ResolvedBackend;
  /**
   * #696 — the install is deployed, so its stack must already be in
   * `backend`; never create an empty one in its place.
   */
  stackMustExist?: boolean;
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
 * The stack program shipped in the package (`stacks/<provider>/`: its
 * Pulumi.yaml and index.ts), whether the CLI runs from source or from the
 * published tarball. Read-only at runtime: Pulumi runs in the install's own
 * work dir (install-state.ts `stackWorkDir`, {@link prepareStackWorkDir}),
 * never here.
 */
export function packageStackDir(provider: "gcp" | "gcp-firebase"): string {
  // From this file at runtime (src/ or dist/wizards/), two levels up.
  return resolvePath(import.meta.dir, `../../stacks/${provider}`);
}

/**
 * The package's project file with `main` pointing from `workDir` at the
 * package's stack program, so Pulumi runs that program (its relative
 * imports, tsconfig and node_modules resolve from the package) while the
 * stack settings file stays in `workDir`. Pulumi joins `main` to the
 * project dir, so it must be relative — and computed between real paths:
 * Pulumi resolves the project dir through symlinks (macOS `/var` →
 * `/private/var`, a symlinked home or package cache), so a path relative to
 * the symlinked spelling points nowhere.
 *
 * @param programDir the package's stack dir, symlinks resolved
 * @param workDir the install's work dir, symlinks resolved
 */
export function workDirProjectFile(
  projectYaml: string,
  programDir: string,
  workDir: string,
): string {
  const mains = [...projectYaml.matchAll(/^main:\s*(\S+)\s*$/gm)];
  if (mains.length !== 1) {
    throw new Error(
      `${join(programDir, "Pulumi.yaml")} must name its program in exactly one top-level "main:" line (found ${mains.length}); the CLI points the install's stack work dir at it.`,
    );
  }
  const program = resolvePath(programDir, (mains[0] as RegExpMatchArray)[1] as string);
  return projectYaml.replace(/^main:\s*\S+\s*$/m, `main: ${relative(workDir, program)}`);
}

/**
 * Create or refresh the install's stack work dir (install-state.ts
 * `stackWorkDir`) and
 * return it. The project file is rewritten on every run: each `bunx`
 * version unpacks the package somewhere else. The settings file is left as
 * it is (it is the install's own). Atomic (temp file + rename), so two runs
 * for the same install never leave a half-written project file.
 */
export function prepareStackWorkDir(
  installRoot: string,
  provider: "gcp" | "gcp-firebase",
  programDir: string = packageStackDir(provider),
): string {
  const workDir = stackWorkDir(installRoot, provider);
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const project = workDirProjectFile(
    readFileSync(join(programDir, "Pulumi.yaml"), "utf8"),
    realpathSync(programDir),
    realpathSync(workDir),
  );
  const target = join(workDir, "Pulumi.yaml");
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, project, { mode: 0o600 });
  renameSync(tmp, target);
  return workDir;
}

/**
 * Refuse to run Pulumi when the stack config names another project than
 * the install's (#736, CLAUDE.md §2): a preview or `up` would plan the
 * install's state against another install's project — replacing its
 * Firebase site, buckets and IAM members. Defense in depth: each install
 * has its own work dir, so nothing should ever put another project there.
 */
export async function assertStackProject(
  stack: pulumi.Stack,
  provider: "gcp" | "gcp-firebase",
  projectId: string,
): Promise<void> {
  const key = `caelo-${provider}:project`;
  const configured = await stack.getConfig(key).then(
    (v) => v.value,
    (e: unknown) => {
      if (/not found/i.test(String(e))) return undefined;
      throw e;
    },
  );
  if (configured !== projectId) {
    throw new Error(
      `the stack config ${join(stack.workspace.workDir, `Pulumi.${GCP_STACK_ENV}.yaml`)} names project ${configured ?? "(none)"}, but this install is ${projectId}. Nothing was run. Delete that file and re-run: the CLI writes the install's config again.`,
    );
  }
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
  backend: ResolvedBackend;
  provider: "gcp" | "gcp-firebase";
  digests: ImageDigests;
}): Promise<{ removedOverrides: string[] }> {
  const stack = await selectInstallStack(inputs.installRoot, inputs.backend, inputs.provider);
  await stack.setAllConfig(imageDigestConfig(inputs.provider, inputs.digests));
  // Read the settings file, not `getAllConfig()`: `pulumi config` refuses
  // to list a stack whose required keys (domain, project, …) are unset, and
  // a settings file the installer never wrote (an install from before the
  // per-install work dir, #736) holds only what this call just wrote.
  const settings = await stack.workspace.stackSettings(stack.name);
  const removedOverrides = presentImageOverrides(inputs.provider, settings.config);
  if (removedOverrides.length > 0) await stack.removeAllConfig(removedOverrides);
  return { removedOverrides };
}

/**
 * The image-override keys set in a stack settings file's `config`.
 *
 * @param config the settings file's `config` map (absent when the file has none)
 */
export function presentImageOverrides(
  provider: "gcp" | "gcp-firebase",
  config: Record<string, unknown> | undefined,
): string[] {
  return imageOverrideKeys(provider).filter((k) => config !== undefined && k in config);
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
  backend: ResolvedBackend;
  provider: "gcp" | "gcp-firebase";
  name: string;
}): Promise<unknown> {
  const stack = await selectInstallStack(inputs.installRoot, inputs.backend, inputs.provider);
  const outputs = await stack.outputs();
  return outputs[inputs.name]?.value;
}

/**
 * The install's stack settings file with secrets settings that can't
 * contradict its state, or null when it is already fine (#696).
 *
 * That file (`Pulumi.production.yaml`, in the install's work dir) is not
 * the state: `state migrate` moves the state to another backend and secrets
 * provider, and the file can still name the old passphrase salt or KMS key.
 * A file naming anything but the install's own
 * KMS key loses its secrets-provider fields and the `secure:` values
 * encrypted under them (no stack config the CLI sets is secret);
 * `PULUMI_FALLBACK_TO_STATE_SECRETS_MANAGER` (resolveBackend) then makes
 * Pulumi take the provider — KMS key or passphrase salt — from the
 * install's own state. A local install's salt can't be checked without
 * reading its state, so any secrets settings in the file are dropped and
 * re-read from the state on every run.
 */
export function alignedStackSettings(
  settings: pulumi.StackSettings,
  backend: Pick<ResolvedBackend, "kind" | "secretsProvider">,
): pulumi.StackSettings | null {
  const hasSecretsSettings =
    settings.secretsProvider !== undefined ||
    settings.encryptedKey !== undefined ||
    settings.encryptionSalt !== undefined;
  const fine =
    backend.kind === "gcs"
      ? settings.secretsProvider === backend.secretsProvider &&
        settings.encryptionSalt === undefined
      : !hasSecretsSettings;
  if (fine) return null;
  const { secretsProvider: _p, encryptedKey: _k, encryptionSalt: _s, config, ...rest } = settings;
  const kept = Object.fromEntries(
    Object.entries(config ?? {}).filter(
      ([, v]) => !(v !== null && typeof v === "object" && "secure" in (v as object)),
    ),
  );
  return { ...rest, config: kept };
}

/**
 * Bring the install's stack settings file in line with its backend
 * ({@link alignedStackSettings}) before Pulumi reads it.
 *
 * @param workDir the install's prepared work dir ({@link prepareStackWorkDir})
 */
export async function alignStackSettingsFile(
  workDir: string,
  backend: ResolvedBackend,
): Promise<void> {
  const ws = await pulumi.LocalWorkspace.create({ workDir, envVars: stateOnlyEnv(backend) });
  let settings: pulumi.StackSettings;
  try {
    settings = await ws.stackSettings(GCP_STACK_ENV);
  } catch (e) {
    if (/failed to find stack settings file/.test(String(e))) return;
    throw e;
  }
  const aligned = alignedStackSettings(settings, backend);
  if (aligned) await ws.saveStackSettings(GCP_STACK_ENV, aligned);
}

/**
 * The environment for a Pulumi call that only touches the stack's state
 * (select, config, outputs): the backend's variables, with ambient Google
 * credentials blanked as in {@link pulumiGcpEnv} — reaching the ops bucket
 * and KMS key must use the operator's ADC, the same as provisioning did,
 * not a stray key file in the shell.
 */
export function stateOnlyEnv(backend: Pick<ResolvedBackend, "envVars">): Record<string, string> {
  return {
    ...Object.fromEntries(AMBIENT_GOOGLE_CREDENTIAL_ENV.map((k) => [k, ""])),
    ...backend.envVars,
  };
}

/** The install's existing stack, on its backend, in its own work dir. */
export async function selectInstallStack(
  installRoot: string,
  backend: ResolvedBackend,
  provider: "gcp" | "gcp-firebase",
): Promise<pulumi.Stack> {
  const workDir = prepareStackWorkDir(installRoot, provider);
  await alignStackSettingsFile(workDir, backend);
  return pulumi.LocalWorkspace.selectStack(
    { stackName: GCP_STACK_ENV, workDir },
    { envVars: stateOnlyEnv(backend) },
  );
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
export interface StateResource {
  type?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

/**
 * The region an existing stack was deployed in, read from its state (the
 * stacks' explicit `gcp.Provider` carries it), or null for a stack with
 * nothing deployed. State, not stack config: the state is authoritative,
 * and the settings file of an install from before #736 starts empty.
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

/** The inputs {@link applyStackConfig} sets as stack config. */
export type StackConfigInputs = Pick<
  PulumiUpInputs,
  | "projectId"
  | "domain"
  | "stagingDomain"
  | "ownerEmail"
  | "region"
  | "cloudSqlTier"
  | "cloudSqlHa"
  | "adminMinInstances"
  | "adminMemory"
  | "gatewayMinInstances"
  | "wafAdaptiveProtection"
  | "iapAllowlist"
  | "imageDigests"
> & { provider: "gcp" | "gcp-firebase" };

/**
 * Set every config value the stack reads, then its `secretReplication`
 * ({@link resolveSecretReplication}). The wizard sets all of it before every
 * `up`, so install.json stays the source of truth; `state migrate` sets it
 * before the previews that prove a migration changed nothing (#696) when
 * the install's settings file does not hold it yet.
 *
 * @returns the secret replication now configured
 */
export async function applyStackConfig(
  stack: pulumi.Stack,
  inputs: StackConfigInputs,
  stateResources: ReadonlyArray<StateResource>,
): Promise<"auto" | "regional"> {
  const { provider } = inputs;
  const ns = `caelo-${provider}`;
  // wafAdaptiveProtection is gcp-only; the gcp-firebase stack has no
  // Cloud Armor + ignores the key.
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
    // /settings/ai → ai_providers (KEK-encrypted).
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
  return secretReplication;
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
 * backend (and, for a local install, its passphrase) are scoped to the child
 * process only. Pulumi's CLI reaches an ops-bucket backend and its KMS key
 * with the operator's ADC itself — the impersonation variable is read by the
 * GCP provider plugin, not by the backend.
 */
export function pulumiGcpEnv(
  base: NodeJS.ProcessEnv,
  inputs: Pick<PulumiUpInputs, "backend" | "impersonateServiceAccount">,
): Record<string, string> {
  return {
    ...withoutAmbientGoogleCredentials(base),
    ...Object.fromEntries(AMBIENT_GOOGLE_CREDENTIAL_ENV.map((k) => [k, ""])),
    GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: inputs.impersonateServiceAccount ?? "",
    ...inputs.backend.envVars,
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
  const workDir = prepareStackWorkDir(inputs.installRoot, provider);

  await alignStackSettingsFile(workDir, inputs.backend);
  const workspaceOpts = {
    envVars: env,
    // Used when the stack is created: a new install's secrets are
    // encrypted with its own KMS key (or a local install's passphrase).
    secretsProvider: inputs.backend.secretsProvider,
  };
  const stack = inputs.stackMustExist
    ? await pulumi.LocalWorkspace.selectStack({ stackName, workDir }, workspaceOpts).catch(
        (e: unknown) => {
          throw new Error(
            `the install is deployed but its stack is not in ${inputs.backend.url} (${String(e).split("\n")[0]}). Its state may have moved (state migrate) or been lost; nothing was changed.`,
          );
        },
      )
    : await pulumi.LocalWorkspace.createOrSelectStack({ stackName, workDir }, workspaceOpts);

  const stateResources = ((await stack.exportStack()).deployment?.resources ??
    []) as StateResource[];
  assertStackRegion(deployedStackRegion(stateResources), inputs.region);

  const secretReplication = await applyStackConfig(stack, { ...inputs, provider }, stateResources);

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
  await assertStackProject(stack, provider, inputs.projectId);
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
