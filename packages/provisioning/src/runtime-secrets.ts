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
 *   - {@link ensureDatabaseRolePassword}: a database role's password set
 *     from its secret (`DATABASE_ROLE_SECRET`), through the Cloud SQL Admin
 *     API — how `gateway_role` (created by migration 0248, without a
 *     password) and `public_role` (moved off admin_role's password, #613)
 *     get theirs.
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
  DATABASE_ROLE_SECRET,
  type DatabaseRole,
  type RuntimeSecret,
  SERVICE_SECRET_ENV,
  serviceSecrets,
} from "./stack-contract.js";
import { liveContainerEnv } from "./stack-converge.js";

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

/**
 * Values of CLI-generated secrets a service runs with as plain env vars,
 * for {@link ensureGeneratedSecrets}'s `seed`.
 */
export function plainGeneratedSecretSeed(
  liveEnv: ReadonlyMap<string, { readonly kind: string; readonly value?: string }>,
): Partial<Record<(typeof CLI_GENERATED_SECRETS)[number], string>> {
  const seed: Partial<Record<(typeof CLI_GENERATED_SECRETS)[number], string>> = {};
  for (const [name, secret] of Object.entries(SERVICE_SECRET_ENV.admin)) {
    const generated = CLI_GENERATED_SECRETS.find((g) => g === secret);
    const live = liveEnv.get(name);
    if (generated && live?.kind === "value" && live.value) seed[generated] = live.value;
  }
  return seed;
}

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
 *
 * `seed` carries values a service already runs with as plain env vars (an
 * operator-set `CAELO_INTERNAL_SECRET`): the new secret starts with that
 * value, so moving the var to Secret Manager migrates the credential
 * instead of silently rotating it under callers that sign with it.
 */
export async function ensureGeneratedSecrets(
  install: {
    readonly projectId: string;
    readonly env: string;
    readonly replication: SecretReplication;
    readonly seed?: Readonly<Partial<Record<(typeof CLI_GENERATED_SECRETS)[number], string>>>;
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
        { stdin: install.seed?.[name] || generate() },
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
    const add = await addVersion(run, secretId, project, install.seed?.[name] || generate());
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
  "public-role-password",
  "gateway-role-password",
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

/** The database roles whose password `secret` is (none for a non-database secret). */
export function rolesOfSecret(secret: RuntimeSecret): DatabaseRole[] {
  return (Object.entries(DATABASE_ROLE_SECRET) as [DatabaseRole, RuntimeSecret][])
    .filter(([, s]) => s === secret)
    .map(([role]) => role);
}

/**
 * The env vars each reader of `secret` must take from Secret Manager at
 * `latest` for a new revision to pick up a rotated value. An install
 * `upgrade` hasn't moved over still has the password inline in its URLs (a
 * label-only roll would copy it unchanged), and a reference pinned to an
 * older version would keep the old value — rotating either would report
 * success and leave the services on a value the database no longer accepts.
 */
async function checkRotationReaders(
  run: GcloudRunner,
  target: RotationTarget,
  secret: RotatableSecret,
): Promise<string | null> {
  const secretId = gcpSecretId(target.env, secret);
  const isSecret = (live: { kind: string; secret?: string } | undefined) =>
    live?.kind === "secret" &&
    (live.secret === secretId || (live.secret?.endsWith(`/secrets/${secretId}`) ?? false));
  for (const service of ["admin", "gateway"] as const) {
    const vars = Object.entries(SERVICE_SECRET_ENV[service])
      .filter(([, s]) => s === secret)
      .map(([name]) => name);
    const name = target.services[service];
    const describe = await run([
      "run",
      "services",
      "describe",
      name,
      "--region",
      target.region,
      `--project=${target.projectId}`,
      "--format=json",
    ]);
    if (!describe.ok) return `read the ${service} (${name}): ${describe.stderr.trim()}`;
    const env = liveContainerEnv(describe.stdout);
    // A var the contract no longer gives this service but it still reads
    // from the secret (the gateway's ADMIN_DATABASE_PASSWORD before #613):
    // it would not be rolled, so it would keep a password the database
    // stopped accepting.
    const stale = [...env].filter(([v, live]) => !vars.includes(v) && isSecret(live));
    if (stale.length > 0) {
      return `the ${service} (${name}) still reads ${stale.map(([v]) => v).join(", ")} from ${secretId}, which its env contract no longer gives it. Run \`cms-provision upgrade\` first, then rotate. Nothing was changed.`;
    }
    const wrong = vars.filter((v) => {
      const live = env.get(v);
      return (
        live?.kind !== "secret" ||
        !(live.secret === secretId || live.secret.endsWith(`/secrets/${secretId}`)) ||
        live.version !== "latest"
      );
    });
    if (wrong.length > 0) {
      return `the ${service} (${name}) does not read ${wrong.join(", ")} from ${secretId} at latest, so a rotated value would not reach it. Run \`cms-provision upgrade\` first (it moves the services onto Secret Manager references), then rotate. Nothing was changed.`;
    }
  }
  return null;
}

/** Minimal `fetch` the Cloud SQL Admin API calls need (injectable for tests). */
export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const SQL_ADMIN = "https://sqladmin.googleapis.com/v1";
const SQL_OPERATION_POLLS = 60;

/**
 * Set a Cloud SQL user's password through the Cloud SQL Admin API, with the
 * password in the request body. `gcloud sql users set-password` only takes
 * it on argv (visible in process listings and exec logs) or from a tty
 * prompt, so it is not used. The bearer token comes from the operator's
 * gcloud session, like every other call here.
 */
async function setSqlUserPassword(
  run: GcloudRunner,
  http: HttpFetch,
  sleep: Sleep,
  user: { projectId: string; instance: string; role: string; password: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = await run(["auth", "print-access-token"]);
  const bearer = token.ok ? token.stdout.trim() : "";
  if (!bearer) {
    return {
      ok: false,
      error: `gcloud auth print-access-token: ${token.stderr.trim() || "empty"}`,
    };
  }
  const headers = { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" };
  const project = `${SQL_ADMIN}/projects/${encodeURIComponent(user.projectId)}`;
  const failed = async (what: string, res: { status: number; text(): Promise<string> }) => ({
    ok: false as const,
    error: `${what}: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`,
  });
  const put = await http(
    `${project}/instances/${encodeURIComponent(user.instance)}/users?name=${encodeURIComponent(user.role)}`,
    { method: "PUT", headers, body: JSON.stringify({ name: user.role, password: user.password }) },
  );
  if (!put.ok) return failed("update the user", put);
  type Operation = {
    name?: string;
    status?: string;
    error?: { errors?: { message?: string }[] };
  };
  let op = JSON.parse(await put.text()) as Operation;
  for (let i = 0; op.status !== "DONE" && i < SQL_OPERATION_POLLS; i++) {
    if (!op.name) return { ok: false, error: "the Cloud SQL API returned no operation name" };
    await sleep(2_000);
    const poll = await http(`${project}/operations/${encodeURIComponent(op.name)}`, {
      method: "GET",
      headers,
    });
    if (!poll.ok) return failed(`poll operation ${op.name}`, poll);
    op = JSON.parse(await poll.text()) as Operation;
  }
  if (op.status !== "DONE") {
    return { ok: false, error: `operation ${op.name ?? "?"} did not finish in time` };
  }
  if (op.error) {
    return {
      ok: false,
      error: (op.error.errors ?? []).map((e) => e.message ?? "?").join("; ") || "operation failed",
    };
  }
  return { ok: true };
}

/** The two gcloud calls that roll `name` onto the `latest` version of its secrets. */
function rollArgs(name: string, region: string, projectId: string): string[][] {
  const location = ["--region", region, `--project=${projectId}`];
  return [
    // A label change copies to the revision template, so it creates a new
    // revision, which resolves `latest` again.
    [
      "run",
      "services",
      "update",
      name,
      ...location,
      `--update-labels=caelo-secret-rotated=${Date.now()}`,
      "--quiet",
    ],
    ["run", "services", "update-traffic", name, ...location, "--to-latest", "--quiet"],
  ];
}

/**
 * Rotate one runtime secret: store a new value as a new Secret Manager
 * version and roll every service that reads it, so new revisions resolve
 * `latest` to the new value.
 *
 * Nothing changes unless every reader takes the secret from Secret Manager
 * at `latest` ({@link checkRotationReaders}).
 *
 * `postgres-password` also changes the password of both database roles,
 * first, so the new version never holds a password the database rejects.
 * The password goes to the Cloud SQL Admin API in a request body, never on
 * argv. If a step before the new version is stored fails, the roles are
 * set back to the previous value. Between the password change and the
 * roll, instances of the old revision keep their open connections but
 * cannot open new ones — the roll follows immediately, and it is attempted
 * for every reader even when one fails, so one failed service never leaves
 * the other behind. A failed roll is resumed with the printed commands
 * (rolling again picks up the stored value; it does not rotate again).
 */
export async function rotateRuntimeSecret(
  target: RotationTarget,
  secret: RotatableSecret,
  deps: RuntimeDeps & { readonly http?: HttpFetch } = {},
): Promise<RotationReport> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const http = deps.http ?? (fetch as unknown as HttpFetch);
  const generate = deps.generate ?? generateSecretValue;
  const project = `--project=${target.projectId}`;
  const secretId = gcpSecretId(target.env, secret);
  const steps: string[] = [];

  const notReady = await checkRotationReaders(run, target, secret);
  if (notReady) return { ok: false, steps, error: notReady };
  const value = generate();

  if (rolesOfSecret(secret).length > 0) {
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
      setSqlUserPassword(run, http, sleep, {
        projectId: target.projectId,
        instance,
        role,
        password,
      });
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
    for (const role of rolesOfSecret(secret)) {
      const r = await setPassword(role, value);
      if (!r.ok) {
        const restored = changed.length > 0 ? `; ${await restore()}` : "";
        return {
          ok: false,
          steps,
          error: `set the ${role} password: ${r.error}${restored}`,
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

  const failures: string[] = [];
  for (const service of ["admin", "gateway"] as const) {
    if (!serviceSecrets(service).includes(secret)) continue;
    const name = target.services[service];
    const [update, flip] = rollArgs(name, target.region, target.projectId) as [string[], string[]];
    const rolled = await run(update);
    const flipped = rolled.ok ? await run(flip) : rolled;
    if (flipped.ok) {
      steps.push(`rolled the ${service} onto the new value`);
      continue;
    }
    failures.push(
      `roll the ${service} (${name}) onto the new value: ${flipped.stderr.trim()}\n  resume with:\n    gcloud ${update.join(" ")}\n    gcloud ${flip.join(" ")}`,
    );
  }
  if (failures.length > 0) {
    return {
      ok: false,
      steps,
      error: `The new value is stored${rolesOfSecret(secret).length > 0 ? " and the database uses it" : ""}, but not every service runs on it yet. Do not rotate again — roll the remaining services onto it:\n${failures.join("\n")}`,
    };
  }
  return { ok: true, steps };
}

// ===========================================================================
// Database role passwords
// ===========================================================================

/** The deployed install whose database role passwords are set. */
export interface DatabaseRoleTarget {
  readonly projectId: string;
  readonly env: string;
  /** Cloud SQL instance name. */
  readonly sqlInstance: string;
}

/**
 * The latest value of a runtime secret. Read through gcloud (the operator's
 * session) into memory only; never logged.
 */
export async function readSecretValue(
  run: GcloudRunner,
  install: { readonly projectId: string; readonly env: string },
  secret: RuntimeSecret,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const secretId = gcpSecretId(install.env, secret);
  const r = await run([
    "secrets",
    "versions",
    "access",
    "latest",
    `--secret=${secretId}`,
    `--project=${install.projectId}`,
  ]);
  if (!r.ok) return { ok: false, error: `read ${secretId}: ${r.stderr.trim()}` };
  if (!r.stdout) return { ok: false, error: `${secretId} has an empty latest version` };
  return { ok: true, value: r.stdout };
}

/**
 * Set `role`'s password to its secret's latest value
 * ({@link DATABASE_ROLE_SECRET}), or to `password` when given (used to put
 * a role back on the value an older revision still uses). Setting the value
 * the role already has is a no-op for every client, so upgrade runs this on
 * every roll and an install converges whatever state it was left in.
 *
 * The role must exist: `gateway_role` is created by migration 0248, so this
 * runs after migrations.
 */
export async function ensureDatabaseRolePassword(
  target: DatabaseRoleTarget,
  role: DatabaseRole,
  deps: RuntimeDeps & { readonly http?: HttpFetch; readonly password?: string } = {},
): Promise<EnsureOutcome> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const http = deps.http ?? (fetch as unknown as HttpFetch);
  const id = `database role ${role}`;
  let password = deps.password;
  if (password === undefined) {
    const value = await readSecretValue(run, target, DATABASE_ROLE_SECRET[role]);
    if (!value.ok) return { id, status: "failed", error: value.error };
    password = value.value;
  }
  const set = await setSqlUserPassword(run, http, sleep, {
    projectId: target.projectId,
    instance: target.sqlInstance,
    role,
    password,
  });
  return set.ok ? { id, status: "applied" } : { id, status: "failed", error: set.error };
}
