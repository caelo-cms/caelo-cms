// SPDX-License-Identifier: MPL-2.0

/**
 * The runtime identities and secrets of a GCP install that the CLI (not
 * Pulumi) creates and maintains, through gcloud:
 *
 *   - {@link ensureGatewayServiceAccount}: the gateway's own run SA, so it
 *     can be granted only the secrets the gateway reads.
 *   - {@link ensureGeneratedSecrets}: the secrets in
 *     `CLI_GENERATED_SECRETS` (stack-contract.ts). The wizard runs it before
 *     `pulumi up`, upgrade on every roll, so installs that predate a secret
 *     get it without operator action. Values are generated here and go to
 *     Secret Manager on stdin — never on argv, never to disk.
 *   - {@link rotateRuntimeSecret}: `cms-provision rotate-secret`.
 *
 * Every function reports instead of throwing on a gcloud failure.
 */

import { randomBytes } from "node:crypto";
import { gcloud as defaultGcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import { gatewayServiceAccountEmail, gatewayServiceAccountId, gcpSecretId } from "./gcp-names.js";
import {
  CLI_GENERATED_SECRETS,
  type CloudRunSlug,
  type RuntimeSecret,
  serviceSecrets,
} from "./stack-contract.js";

export interface RuntimeDeps {
  readonly run?: GcloudRunner;
  readonly sleep?: Sleep;
  /** Generates a new secret value (default: 32 random bytes, hex). */
  readonly generate?: () => string;
}

/** 32 random bytes as hex — the shape of every secret the stacks generate. */
export function generateSecretValue(): string {
  return randomBytes(32).toString("hex");
}

export interface EnsureOutcome {
  readonly id: string;
  readonly status: "present" | "applied" | "failed";
  readonly error?: string;
}

const NOT_FOUND = /NOT_FOUND|not found|does not exist/i;
const ALREADY_EXISTS = /ALREADY_EXISTS|already exists/i;

// ===========================================================================
// Gateway service account
// ===========================================================================

/** Create the gateway's run SA unless it exists. */
export async function ensureGatewayServiceAccount(
  install: { readonly projectId: string; readonly env: string },
  deps: RuntimeDeps = {},
): Promise<EnsureOutcome> {
  const run = deps.run ?? defaultGcloud;
  const email = gatewayServiceAccountEmail(install.projectId, install.env);
  const id = `service account ${email}`;
  const project = `--project=${install.projectId}`;
  const describe = await run([
    "iam",
    "service-accounts",
    "describe",
    email,
    project,
    "--format=value(email)",
  ]);
  if (describe.ok) return { id, status: "present" };
  if (!NOT_FOUND.test(describe.stderr)) {
    return { id, status: "failed", error: describe.stderr.trim() };
  }
  const create = await run([
    "iam",
    "service-accounts",
    "create",
    gatewayServiceAccountId(install.env),
    project,
    `--display-name=Caelo ${install.env} gateway`,
    "--quiet",
  ]);
  if (create.ok || ALREADY_EXISTS.test(create.stderr)) return { id, status: "applied" };
  return { id, status: "failed", error: create.stderr.trim() };
}

// ===========================================================================
// Generated secrets
// ===========================================================================

/** Where Secret Manager keeps a secret's payload. */
export type SecretReplication =
  | { readonly kind: "automatic" }
  | { readonly kind: "user-managed"; readonly locations: readonly string[] };

/** The stacks' `secretReplication` config value as a {@link SecretReplication}. */
export function stackSecretReplication(
  mode: "auto" | "regional",
  region: string,
): SecretReplication {
  return mode === "auto" ? { kind: "automatic" } : { kind: "user-managed", locations: [region] };
}

/**
 * The replication of the install's existing `postgres-password` secret, so
 * secrets created later match what the stack pinned (orgs with a
 * `gcp.resourceLocations` policy reject `automatic`).
 */
export async function readSecretReplication(
  install: { readonly projectId: string; readonly env: string },
  deps: RuntimeDeps = {},
): Promise<{ ok: true; replication: SecretReplication } | { ok: false; error: string }> {
  const run = deps.run ?? defaultGcloud;
  const secretId = gcpSecretId(install.env, "postgres-password");
  const r = await run([
    "secrets",
    "describe",
    secretId,
    `--project=${install.projectId}`,
    "--format=json",
  ]);
  if (!r.ok) return { ok: false, error: `describe ${secretId}: ${r.stderr.trim()}` };
  const replication = (
    JSON.parse(r.stdout) as {
      replication?: {
        automatic?: unknown;
        userManaged?: { replicas?: { location?: string }[] };
      };
    }
  ).replication;
  if (replication?.automatic) return { ok: true, replication: { kind: "automatic" } };
  const locations = (replication?.userManaged?.replicas ?? [])
    .map((r) => r.location)
    .filter((l): l is string => Boolean(l));
  if (locations.length > 0) {
    return { ok: true, replication: { kind: "user-managed", locations } };
  }
  return { ok: false, error: `${secretId} has no replication policy gcloud reports` };
}

function replicationArgs(replication: SecretReplication): string[] {
  return replication.kind === "automatic"
    ? ["--replication-policy=automatic"]
    : ["--replication-policy=user-managed", `--locations=${replication.locations.join(",")}`];
}

/**
 * Create each secret in `CLI_GENERATED_SECRETS` that is missing, and give
 * one that exists without an enabled version a first version. A secret that
 * already has an enabled version is never touched, so re-runs keep values.
 */
export async function ensureGeneratedSecrets(
  install: {
    readonly projectId: string;
    readonly env: string;
    readonly replication: SecretReplication;
  },
  deps: RuntimeDeps = {},
): Promise<EnsureOutcome[]> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const generate = deps.generate ?? generateSecretValue;
  const project = `--project=${install.projectId}`;
  const outcomes: EnsureOutcome[] = [];

  for (const name of CLI_GENERATED_SECRETS) {
    const secretId = gcpSecretId(install.env, name);
    const id = `secret ${secretId}`;
    const describe = await run(["secrets", "describe", secretId, project, "--format=value(name)"]);
    if (!describe.ok && !NOT_FOUND.test(describe.stderr)) {
      outcomes.push({ id, status: "failed", error: describe.stderr.trim() });
      continue;
    }
    if (!describe.ok) {
      const create = await run(
        [
          "secrets",
          "create",
          secretId,
          project,
          ...replicationArgs(install.replication),
          "--data-file=-",
          "--quiet",
        ],
        { stdin: generate() },
      );
      if (create.ok) {
        outcomes.push({ id, status: "applied" });
        continue;
      }
      if (!ALREADY_EXISTS.test(create.stderr)) {
        outcomes.push({ id, status: "failed", error: create.stderr.trim() });
        continue;
      }
      // Created concurrently — fall through to the version check.
    }
    const versions = await runWithRetry(run, sleep, [
      "secrets",
      "versions",
      "list",
      secretId,
      project,
      "--filter=state:ENABLED",
      "--limit=1",
      "--format=value(name)",
    ]);
    if (!versions.ok) {
      outcomes.push({ id, status: "failed", error: versions.stderr.trim() });
      continue;
    }
    if (versions.stdout.trim()) {
      outcomes.push({ id, status: "present" });
      continue;
    }
    const add = await addVersion(run, secretId, project, generate());
    outcomes.push(add.ok ? { id, status: "applied" } : { id, status: "failed", error: add.error });
  }
  return outcomes;
}

async function addVersion(
  run: GcloudRunner,
  secretId: string,
  project: string,
  value: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await run(["secrets", "versions", "add", secretId, project, "--data-file=-"], {
    stdin: value,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
}

// ===========================================================================
// rotate-secret
// ===========================================================================

/** The secrets `rotate-secret` can rotate. */
export const ROTATABLE_SECRETS = [
  "postgres-password",
  "internal-secret",
  "tool-approval-secret",
] as const satisfies readonly RuntimeSecret[];
export type RotatableSecret = (typeof ROTATABLE_SECRETS)[number];

/**
 * Why `name` cannot be rotated, or `null` when it can.
 *
 * The KEK is refused: AI provider keys and other at-rest secrets in
 * cms_admin are encrypted under it, and a new KEK without re-encrypting
 * them would make them unreadable.
 */
export function rotationRefusal(name: string): string | null {
  if ((ROTATABLE_SECRETS as readonly string[]).includes(name)) return null;
  if (name === "secret-kek") {
    return "secret-kek encrypts the AI provider keys and other at-rest secrets in cms_admin; a new KEK would make them unreadable. Rotating it needs a re-encryption step that does not exist yet.";
  }
  return `${name} is not a runtime secret of this install. Rotatable: ${ROTATABLE_SECRETS.join(", ")}.`;
}

/** The deployed install `rotateRuntimeSecret` works on. */
export interface RotationTarget {
  readonly projectId: string;
  readonly region: string;
  readonly env: string;
  /** Deployed (Pulumi-suffixed) Cloud Run service names. */
  readonly services: Readonly<Record<CloudRunSlug, string>>;
  /** Cloud SQL instance name — needed for `postgres-password`. */
  readonly sqlInstance?: string;
}

export interface RotationReport {
  readonly ok: boolean;
  /** What happened, in order, for the operator. */
  readonly steps: string[];
  readonly error?: string;
}

/** The database roles that authenticate with `postgres-password`. */
const DATABASE_ROLES = ["admin_role", "public_role"] as const;

/**
 * Rotate one runtime secret: store a new value as a new Secret Manager
 * version and roll every service that reads it, so new revisions resolve
 * `latest` to the new value.
 *
 * `postgres-password` also changes the password of both database roles,
 * first, so the new version never holds a password the database rejects.
 * If a step fails the roles are set back to the previous value. Between
 * the password change and the roll, instances of the old revision keep
 * their open connections but cannot open new ones — the roll follows
 * immediately.
 */
export async function rotateRuntimeSecret(
  target: RotationTarget,
  secret: RotatableSecret,
  deps: RuntimeDeps = {},
): Promise<RotationReport> {
  const run = deps.run ?? defaultGcloud;
  const generate = deps.generate ?? generateSecretValue;
  const project = `--project=${target.projectId}`;
  const secretId = gcpSecretId(target.env, secret);
  const steps: string[] = [];
  const value = generate();

  if (secret === "postgres-password") {
    if (!target.sqlInstance) {
      return { ok: false, steps, error: "the Cloud SQL instance was not found" };
    }
    const instance = target.sqlInstance;
    const current = await run([
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${secretId}`,
      project,
    ]);
    if (!current.ok) {
      return { ok: false, steps, error: `read the current password: ${current.stderr.trim()}` };
    }
    const previous = current.stdout;
    const setPassword = (role: string, password: string) =>
      run([
        "sql",
        "users",
        "set-password",
        role,
        `--instance=${instance}`,
        project,
        `--password=${password}`,
        "--quiet",
      ]);
    const changed: string[] = [];
    const restore = async (): Promise<string> => {
      const failed: string[] = [];
      for (const role of changed) {
        if (!(await setPassword(role, previous)).ok) failed.push(role);
      }
      return failed.length === 0
        ? "the database roles were set back to the previous password"
        : `could NOT set ${failed.join(", ")} back to the previous password — set it to the latest version of ${secretId} by hand`;
    };
    for (const role of DATABASE_ROLES) {
      const r = await setPassword(role, value);
      if (!r.ok) {
        const restored = changed.length > 0 ? `; ${await restore()}` : "";
        return {
          ok: false,
          steps,
          error: `set the ${role} password: ${r.stderr.trim()}${restored}`,
        };
      }
      changed.push(role);
      steps.push(`set a new password on database role ${role}`);
    }
    const add = await addVersion(run, secretId, project, value);
    if (!add.ok) {
      return {
        ok: false,
        steps,
        error: `store the new password in ${secretId}: ${add.error}; ${await restore()}`,
      };
    }
  } else {
    const add = await addVersion(run, secretId, project, value);
    if (!add.ok) return { ok: false, steps, error: `add a version to ${secretId}: ${add.error}` };
  }
  steps.push(`added a new version to ${secretId}`);

  for (const service of ["admin", "gateway"] as const) {
    if (!serviceSecrets(service).includes(secret)) continue;
    const name = target.services[service];
    const location = ["--region", target.region, project];
    // A label change copies to the revision template, so it creates a new
    // revision, which resolves `latest` again.
    const roll = await run([
      "run",
      "services",
      "update",
      name,
      ...location,
      `--update-labels=caelo-secret-rotated=${Date.now()}`,
      "--quiet",
    ]);
    const flip = roll.ok
      ? await run([
          "run",
          "services",
          "update-traffic",
          name,
          ...location,
          "--to-latest",
          "--quiet",
        ])
      : roll;
    if (!flip.ok) {
      return {
        ok: false,
        steps,
        error: `roll the ${service} (${name}) onto the new value: ${flip.stderr.trim()}. The new value is stored; re-running \`cms-provision rotate-secret ${secret}\` rotates again and rolls the services.`,
      };
    }
    steps.push(`rolled the ${service} onto the new value`);
  }
  return { ok: true, steps };
}
