// SPDX-License-Identifier: MPL-2.0

/**
 * Converge an existing GCP install to what its Pulumi stack would produce,
 * through gcloud (`cms-provision upgrade` does not run Pulumi). The desired
 * state comes from stack-contract.ts, which the stacks use too.
 *
 *   - {@link planEnvUpdate}: the env-var flags for the `services update` that
 *     rolls the image, so env changes ride the same new revision — including
 *     moving a plain var to a Secret Manager reference.
 *   - {@link ensureStackInvariants}: IAM bindings + CDN settings. Each binding
 *     is checked against the resource's policy first and only added when
 *     missing, so an operator without IAM-admin rights can still upgrade an
 *     install that is already in shape.
 *   - {@link ensureStackInvariants} also deletes the internet-open SSH/RDP
 *     firewall rules GCP auto-creates on the `default` network
 *     (default-firewall.ts), the one thing it removes.
 *   - {@link planMediaVolume}: the admin's media bucket volume (gen2 + Cloud
 *     Storage volume + mount), added in the same `services update` when
 *     missing.
 */

import { removeDefaultIngressRules } from "./default-firewall.js";
import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import { gcpBucketName, gcpSecretId } from "./gcp-names.js";
import {
  ADMIN_MEMORY_DEFAULT,
  type AdminEnvInputs,
  adminEnvContract,
  type CloudRunEnvVar,
  type CloudRunSlug,
  databaseUrls,
  type GcpProvider,
  gatewayEnvContract,
  type IamInvariant,
  type IamTarget,
  iamMember,
  type MediaVolumeContract,
  memoryQuantityMiB,
  RETIRED_IAM_BINDINGS,
  RETIRED_SERVICE_ENV,
  type RetiredIamBinding,
  type RuntimeEnvInputs,
  type ServiceEnvInputs,
  STATIC_CDN_POLICY,
  stackIamInvariants,
  staticBackendBucketPrefix,
} from "./stack-contract.js";

// ===========================================================================
// Env vars
// ===========================================================================

/** An env var as a deployed Cloud Run service carries it. */
export type LiveEnvValue =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "secret"; readonly secret: string; readonly version: string };

/**
 * Env vars of the first container in `gcloud run services describe
 * --format=json` output (Knative `serving.knative.dev/v1` Service).
 */
export function liveContainerEnv(serviceJson: string): Map<string, LiveEnvValue> {
  const svc = JSON.parse(serviceJson) as {
    spec?: {
      template?: {
        spec?: {
          containers?: {
            env?: {
              name: string;
              value?: string;
              valueFrom?: { secretKeyRef?: { name: string; key: string } };
            }[];
          }[];
        };
      };
    };
  };
  const env = svc.spec?.template?.spec?.containers?.[0]?.env ?? [];
  const out = new Map<string, LiveEnvValue>();
  for (const e of env) {
    const ref = e.valueFrom?.secretKeyRef;
    out.set(
      e.name,
      ref
        ? { kind: "secret", secret: secretIdOf(ref.name), version: ref.key }
        : { kind: "value", value: e.value ?? "" },
    );
  }
  return out;
}

/** `projects/<p>/secrets/<id>` → `<id>`; a bare id stays as it is. */
function secretIdOf(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

/** The service account the service's revisions run as (`undefined`: the default compute SA). */
export function liveServiceAccount(serviceJson: string): string | undefined {
  const svc = JSON.parse(serviceJson) as {
    spec?: { template?: { spec?: { serviceAccountName?: string } } };
  };
  return svc.spec?.template?.spec?.serviceAccountName || undefined;
}

export interface EnvChange {
  readonly name: string;
  /** `undefined` when the service does not have the var yet. */
  readonly from: string | undefined;
  /** `undefined` when the var is removed. */
  readonly to: string | undefined;
}

export type EnvUpdatePlan =
  | { readonly ok: true; readonly changes: EnvChange[]; readonly flags: string[] }
  | { readonly ok: false; readonly error: string };

/**
 * A live value as upgrade prints it. Passwords in URLs are masked: before
 * the move to Secret Manager the database URLs carried them inline.
 */
function describeLive(v: LiveEnvValue): string {
  return v.kind === "value" ? maskUrlPassword(v.value) : `secret:${v.secret}:${v.version}`;
}

/**
 * Whether a service still carries a URL with an inline password in a plain
 * var — the pre-Secret Manager shape. Such a password is in every revision
 * Cloud Run keeps, so it should be rotated once the services moved off it.
 */
export function liveEnvHasInlinePassword(liveEnv: ReadonlyMap<string, LiveEnvValue>): boolean {
  return [...liveEnv.values()].some(
    (v) => v.kind === "value" && maskUrlPassword(v.value) !== v.value,
  );
}

function maskUrlPassword(value: string): string {
  if (!value.includes("://")) return value;
  try {
    const url = new URL(value);
    if (!url.password) return value;
    url.password = "***";
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * gcloud's list flags split on `,`; a value containing one needs the
 * `^<delim>^` escape syntax (`gcloud topic escaping`).
 */
function listFlag(flag: string, pairs: string[]): string {
  const joined = pairs.join(",");
  if (!pairs.some((p) => p.includes(","))) return `${flag}=${joined}`;
  const delim = ["@", "|", "#", "~", ";"].find((d) => !pairs.some((p) => p.includes(d)));
  if (!delim) throw new Error(`${flag}: no free delimiter for ${pairs.join(" ")}`);
  return `${flag}=^${delim}^${pairs.join(delim)}`;
}

/**
 * The `gcloud run services update` flags that bring `live` to `desired`.
 * Only vars that differ are touched; vars the contract does not own
 * (operator additions) are left alone, and the `retired` ones are removed.
 *
 * A plain var that becomes a Secret Manager reference moves in the same
 * update: `--remove-env-vars=X --update-secrets=X=…`. gcloud applies all
 * literal env changes (removals included) before the secret changes of one
 * `services update` (googlecloudsdk/command_lib/run/flags.py
 * `_GetConfigurationChanges`), so the new revision has X as a secret and no
 * revision is ever without X. The reverse — a secret becoming a plain value
 * — cannot be expressed in one update (the literal is set while X is still
 * a secret, which gcloud rejects), so it is refused rather than attempted.
 */
export function planEnvUpdate(
  live: ReadonlyMap<string, LiveEnvValue>,
  desired: readonly CloudRunEnvVar[],
  retired: readonly string[] = [],
): EnvUpdatePlan {
  const changes: EnvChange[] = [];
  const plain: string[] = [];
  const secrets: string[] = [];
  const removePlain: string[] = [];
  const removeSecrets: string[] = [];
  for (const entry of desired) {
    const current = live.get(entry.name);
    if ("value" in entry) {
      if (current?.kind === "secret") {
        return {
          ok: false,
          error: `${entry.name} is a Secret Manager reference on the service but a plain value in the contract`,
        };
      }
      if (current?.value === entry.value) continue;
      plain.push(`${entry.name}=${entry.value}`);
      changes.push({
        name: entry.name,
        from: current ? describeLive(current) : undefined,
        to: entry.value,
      });
    } else {
      const { secret, version } = entry.valueSource.secretKeyRef;
      if (current?.kind === "secret" && current.secret === secret && current.version === version) {
        continue;
      }
      // Plain → secret: drop the literal in the same update (see above).
      // The old literal may be a secret value, so it is never printed.
      if (current?.kind === "value") removePlain.push(entry.name);
      secrets.push(`${entry.name}=${secret}:${version}`);
      changes.push({
        name: entry.name,
        from:
          current === undefined
            ? undefined
            : current.kind === "value"
              ? "(plain value)"
              : describeLive(current),
        to: `secret:${secret}:${version}`,
      });
    }
  }
  for (const name of retired) {
    if (desired.some((e) => e.name === name)) {
      return { ok: false, error: `${name} is both in the contract and retired` };
    }
    const current = live.get(name);
    if (!current) continue;
    (current.kind === "value" ? removePlain : removeSecrets).push(name);
    // A retired var may hold a secret value (a plain KEK), so a literal is
    // never printed.
    changes.push({
      name,
      from: current.kind === "value" ? "(plain value)" : describeLive(current),
      to: undefined,
    });
  }
  const flags = [
    ...(removePlain.length > 0 ? [listFlag("--remove-env-vars", removePlain)] : []),
    ...(plain.length > 0 ? [listFlag("--update-env-vars", plain)] : []),
    ...(removeSecrets.length > 0 ? [listFlag("--remove-secrets", removeSecrets)] : []),
    ...(secrets.length > 0 ? [listFlag("--update-secrets", secrets)] : []),
  ];
  return { ok: true, changes, flags };
}

/** A deployed Cloud Run service as upgrade found it. */
export interface DeployedService {
  /** Pulumi-suffixed service name. */
  readonly serviceName: string;
  readonly liveEnv: ReadonlyMap<string, LiveEnvValue>;
}

/**
 * The Cloud SQL host the admin connects to, from its live `ADMIN_DATABASE_URL`
 * (with or without an inline password — before and after the move to Secret
 * Manager).
 */
export function liveDatabaseHost(
  liveEnv: ReadonlyMap<string, LiveEnvValue>,
): { ok: true; host: string } | { ok: false; error: string } {
  const url = liveEnv.get("ADMIN_DATABASE_URL");
  if (url?.kind !== "value" || !url.value) {
    return { ok: false, error: "it has no plain ADMIN_DATABASE_URL" };
  }
  try {
    const host = new URL(url.value).hostname;
    if (host) return { ok: true, host };
  } catch {
    // falls through to the error below
  }
  return { ok: false, error: "its ADMIN_DATABASE_URL is not a valid URL" };
}

/**
 * The env changes that bring both deployed services to their env contract
 * (stack-contract.ts — the contract the stacks deploy). Values Pulumi
 * generated at install time (database host, Firebase site) are read from the
 * live services. Fails instead of guessing when one can't be determined.
 */
export function planContractEnv(
  install: ServiceEnvInputs,
  services: Readonly<Record<CloudRunSlug, DeployedService>>,
  opts: {
    /** Contract vars to leave exactly as the services have them. */
    readonly leaveUntouched?: readonly string[];
  } = {},
):
  | {
      readonly ok: true;
      readonly services: Record<CloudRunSlug, { flags: string[]; changes: EnvChange[] }>;
    }
  | { readonly ok: false; readonly error: string } {
  const host = liveDatabaseHost(services.admin.liveEnv);
  if (!host.ok) {
    return {
      ok: false,
      error: `the Cloud SQL host is unknown: the admin service (${services.admin.serviceName}) ${host.error}`,
    };
  }
  const runtime: RuntimeEnvInputs = { ...install, databaseUrls: databaseUrls(host.host) };
  let inputs: AdminEnvInputs;
  if (install.provider === "gcp-firebase") {
    // The site id carries a random suffix Pulumi generated at install time.
    const site = services.admin.liveEnv.get("CAELO_FIREBASE_SITE");
    if (site?.kind !== "value" || !site.value) {
      return {
        ok: false,
        error: `the admin service has no CAELO_FIREBASE_SITE, so the Firebase Hosting site is unknown. Set it (gcloud run services update ${services.admin.serviceName} --update-env-vars=CAELO_FIREBASE_SITE=<site-id>) and re-run.`,
      };
    }
    inputs = {
      ...runtime,
      provider: "gcp-firebase",
      firebaseSiteId: site.value,
      gatewayService: services.gateway.serviceName,
    };
  } else {
    inputs = { ...runtime, provider: "gcp" };
  }
  const skip = new Set(opts.leaveUntouched ?? []);
  const owned = (contract: readonly CloudRunEnvVar[]) => contract.filter((e) => !skip.has(e.name));
  const admin = planEnvUpdate(
    services.admin.liveEnv,
    owned(adminEnvContract(inputs)),
    RETIRED_SERVICE_ENV.admin,
  );
  if (!admin.ok) return { ok: false, error: `admin: ${admin.error}` };
  const gateway = planEnvUpdate(
    services.gateway.liveEnv,
    owned(gatewayEnvContract(runtime)),
    RETIRED_SERVICE_ENV.gateway,
  );
  if (!gateway.ok) return { ok: false, error: `gateway: ${gateway.error}` };
  return {
    ok: true,
    services: {
      admin: { flags: admin.flags, changes: admin.changes },
      gateway: { flags: gateway.flags, changes: gateway.changes },
    },
  };
}

// ===========================================================================
// IAM + CDN invariants
// ===========================================================================

/** The deployed install `ensureStackInvariants` works on. */
export interface InstallTarget {
  readonly provider: GcpProvider;
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  /** Deployed (Pulumi-suffixed) Cloud Run service names. */
  readonly services: Readonly<Record<CloudRunSlug, string>>;
}

export interface InvariantOutcome {
  /** Human-readable identity, e.g. `roles/run.viewer → serviceAccount:… on gateway`. */
  readonly id: string;
  readonly status: "present" | "applied" | "failed";
  /** What a failure means for the upgrade (from the invariant). */
  readonly onFailure: "abort" | "warn";
  readonly why: string;
  readonly error?: string;
}

export interface InvariantsReport {
  readonly outcomes: InvariantOutcome[];
  /** True when a failed invariant is one the install cannot work without. */
  readonly mustAbort: boolean;
}

function targetLabel(target: IamTarget): string {
  switch (target.kind) {
    case "project":
      return "project";
    case "secret":
      return `secret ${target.name}`;
    case "bucket":
      return `bucket ${target.bucket}`;
    case "run-service":
      return `${target.service} service`;
  }
}

/** gcloud argv (minus the trailing verb args) addressing an IAM target. */
function iamCommand(
  target: IamTarget,
  verb: "get-iam-policy" | "add-iam-policy-binding" | "remove-iam-policy-binding",
  install: InstallTarget,
): string[] {
  const project = `--project=${install.projectId}`;
  switch (target.kind) {
    case "project":
      return ["projects", verb, install.projectId];
    case "secret":
      return ["secrets", verb, gcpSecretId(install.env, target.name), project];
    case "bucket":
      return [
        "storage",
        "buckets",
        verb,
        `gs://${gcpBucketName(install.projectId, install.env, target.bucket)}`,
        project,
      ];
    case "run-service":
      return [
        "run",
        "services",
        verb,
        install.services[target.service],
        `--region=${install.region}`,
        project,
      ];
  }
}

/** Whether an IAM policy (JSON) grants `role` to `member` unconditionally. */
export function policyGrants(policyJson: string, role: string, member: string): boolean {
  const policy = JSON.parse(policyJson) as {
    bindings?: { role: string; members?: string[]; condition?: unknown }[];
  };
  return (policy.bindings ?? []).some(
    (b) => b.role === role && !b.condition && (b.members ?? []).includes(member),
  );
}

/** gcloud's error when the resource a binding targets does not exist. */
const RESOURCE_MISSING = /NOT_FOUND|not found|does not exist/i;

async function ensureIam(
  invariants: readonly IamInvariant[],
  install: InstallTarget,
  projectNumber: string,
  run: GcloudRunner,
  sleep: Sleep,
): Promise<InvariantOutcome[]> {
  const outcomes: InvariantOutcome[] = [];
  // One policy read per resource; several invariants share a resource.
  const policies = new Map<
    string,
    Promise<{ ok: true; json: string } | { ok: false; error: string }>
  >();
  const readPolicy = (target: IamTarget) => {
    const args = [...iamCommand(target, "get-iam-policy", install), "--format=json"];
    const key = args.join(" ");
    let p = policies.get(key);
    if (!p) {
      p = run(args).then((r) =>
        r.ok
          ? { ok: true as const, json: r.stdout }
          : { ok: false as const, error: r.stderr.trim() },
      );
      policies.set(key, p);
    }
    return p;
  };

  for (const inv of invariants) {
    const member = iamMember(inv.member, { ...install, projectNumber });
    const id = `${inv.role} → ${member} on ${targetLabel(inv.target)}`;
    const base = { id, onFailure: inv.onFailure, why: inv.why };
    const policy = await readPolicy(inv.target);
    if (policy.ok && policyGrants(policy.json, inv.role, member)) {
      outcomes.push({ ...base, status: "present" });
      continue;
    }
    // Policy unreadable or binding missing: add it. `--condition=None` only
    // where gcloud prompts for it (project policies with conditional bindings).
    const add = await runWithRetry(run, sleep, [
      ...iamCommand(inv.target, "add-iam-policy-binding", install),
      `--member=${member}`,
      `--role=${inv.role}`,
      ...(inv.target.kind === "project" ? ["--condition=None"] : []),
      "--quiet",
      "--format=none",
    ]);
    if (add.ok) {
      outcomes.push({ ...base, status: "applied" });
      continue;
    }
    const error = policy.ok ? add.stderr.trim() : `${policy.error}; ${add.stderr.trim()}`;
    outcomes.push({
      ...base,
      status: "failed",
      // upgrade only adds bindings; it never creates the resource itself.
      error: RESOURCE_MISSING.test(error)
        ? `${error}\n    The ${targetLabel(inv.target)} or the account it grants to does not exist on this install (the install predates it). Re-run the installer (bunx @caelo-cms/provisioning) to create it — it keeps the release this install runs — then re-run upgrade.`
        : error,
    });
  }
  return outcomes;
}

/** Bring the `gcp` stack's static backend bucket to {@link STATIC_CDN_POLICY}. */
async function ensureCdnPolicy(
  install: InstallTarget,
  run: GcloudRunner,
): Promise<InvariantOutcome> {
  const base = {
    id: `Cloud CDN policy of ${staticBackendBucketPrefix(install.env)}*`,
    onFailure: "warn" as const,
    why: "immutable assets stay cached for a year instead of 1h (#555)",
  };
  const project = `--project=${install.projectId}`;
  const list = await run([
    "compute",
    "backend-buckets",
    "list",
    project,
    `--filter=name~^${staticBackendBucketPrefix(install.env)}`,
    "--format=value(name)",
  ]);
  const name = list.ok ? list.stdout.trim().split("\n")[0]?.trim() : "";
  if (!name) {
    return {
      ...base,
      status: "failed",
      error: list.ok ? "static backend bucket not found" : list.stderr.trim(),
    };
  }
  const describe = await run([
    "compute",
    "backend-buckets",
    "describe",
    name,
    project,
    "--format=json",
  ]);
  if (describe.ok) {
    const cdn = (JSON.parse(describe.stdout) as { cdnPolicy?: Record<string, unknown> }).cdnPolicy;
    const inShape =
      cdn !== undefined &&
      (Object.keys(STATIC_CDN_POLICY) as (keyof typeof STATIC_CDN_POLICY)[]).every(
        (k) => String(cdn[k]) === String(STATIC_CDN_POLICY[k]),
      );
    if (inShape) return { ...base, status: "present" };
  }
  const update = await run([
    "compute",
    "backend-buckets",
    "update",
    name,
    project,
    `--cache-mode=${STATIC_CDN_POLICY.cacheMode}`,
    `--default-ttl=${STATIC_CDN_POLICY.defaultTtl}`,
    `--max-ttl=${STATIC_CDN_POLICY.maxTtl}`,
    `--client-ttl=${STATIC_CDN_POLICY.clientTtl}`,
    "--quiet",
  ]);
  return update.ok
    ? { ...base, status: "applied" }
    : { ...base, status: "failed", error: update.stderr.trim() };
}

/**
 * Idempotently ensure every IAM binding and CDN setting the install's stack
 * declares (stack-contract.ts), and that the default network's internet-open
 * SSH/RDP rules are gone (ABSENT_DEFAULT_FIREWALL_RULES). Bindings are only
 * added, never removed; the two firewall rules are the only deletion. Never
 * throws for a gcloud failure; the report says what failed and whether the
 * upgrade must stop.
 */
export async function ensureStackInvariants(
  install: InstallTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<InvariantsReport> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const invariants = stackIamInvariants(install.provider);

  const outcomes: InvariantOutcome[] = [];
  let projectNumber = "";
  if (invariants.some((i) => i.member === "iap-service-agent")) {
    const r = await run([
      "projects",
      "describe",
      install.projectId,
      "--format=value(projectNumber)",
    ]);
    projectNumber = r.ok ? r.stdout.trim() : "";
    if (!projectNumber) {
      // Without the project number the IAP agent's binding can't be checked;
      // report each of those invariants as failed instead of guessing.
      for (const inv of invariants.filter((i) => i.member === "iap-service-agent")) {
        outcomes.push({
          id: `${inv.role} → IAP service agent on ${targetLabel(inv.target)}`,
          status: "failed",
          onFailure: inv.onFailure,
          why: inv.why,
          error: `read project number: ${r.stderr.trim() || "empty"}`,
        });
      }
    }
  }
  const checkable = projectNumber
    ? invariants
    : invariants.filter((i) => i.member !== "iap-service-agent");
  outcomes.push(...(await ensureIam(checkable, install, projectNumber, run, sleep)));
  if (install.provider === "gcp") outcomes.push(await ensureCdnPolicy(install, run));
  outcomes.push(...(await removeDefaultIngressRules(install.projectId, { run })));

  return {
    outcomes,
    mustAbort: outcomes.some((o) => o.status === "failed" && o.onFailure === "abort"),
  };
}

/** What happened to one retired binding. */
export interface RetiredBindingOutcome {
  readonly id: string;
  /** `absent`: nothing to remove. */
  readonly status: "absent" | "removed" | "failed";
  readonly why: string;
  readonly error?: string;
}

/**
 * Remove the bindings older stacks declared and the contract retired
 * ({@link RETIRED_IAM_BINDINGS}) — run by upgrade AFTER the services rolled
 * off them. Checks the policy first, so an operator without IAM-admin
 * rights can still upgrade an install that is already clean. Never throws
 * for a gcloud failure; the caller decides how loudly to report it.
 */
export async function removeRetiredIamBindings(
  install: InstallTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep; retired?: readonly RetiredIamBinding[] } = {},
): Promise<RetiredBindingOutcome[]> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const outcomes: RetiredBindingOutcome[] = [];
  for (const b of deps.retired ?? RETIRED_IAM_BINDINGS) {
    // Retired bindings never name the IAP agent, so no project number.
    const member = iamMember(b.member, { ...install, projectNumber: "" });
    const id = `${b.role} → ${member} on ${targetLabel(b.target)}`;
    const policy = await run([...iamCommand(b.target, "get-iam-policy", install), "--format=json"]);
    if (policy.ok && !policyGrants(policy.stdout, b.role, member)) {
      outcomes.push({ id, status: "absent", why: b.why });
      continue;
    }
    if (!policy.ok && RESOURCE_MISSING.test(policy.stderr)) {
      outcomes.push({ id, status: "absent", why: b.why });
      continue;
    }
    const remove = await runWithRetry(run, sleep, [
      ...iamCommand(b.target, "remove-iam-policy-binding", install),
      `--member=${member}`,
      `--role=${b.role}`,
      ...(b.target.kind === "project" ? ["--condition=None"] : []),
      "--quiet",
      "--format=none",
    ]);
    outcomes.push(
      remove.ok
        ? { id, status: "removed", why: b.why }
        : { id, status: "failed", why: b.why, error: remove.stderr.trim() },
    );
  }
  return outcomes;
}

/** The memory limit of the service's container (`512Mi`, `2Gi`), or null
 *  when the service declares none (Cloud Run then runs it with 512Mi). */
export function liveContainerMemory(serviceJson: string): string | null {
  const svc = JSON.parse(serviceJson) as {
    spec?: {
      template?: {
        spec?: { containers?: { resources?: { limits?: { memory?: string } } }[] };
      };
    };
  };
  return svc.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory ?? null;
}

/** Cloud Run's memory when a service declares no limit. */
const CLOUD_RUN_DEFAULT_MEMORY = "512Mi";

/**
 * #553 — raise the admin's memory to the stack's default (it runs the
 * Lighthouse quality audit). Upgrade only ever RAISES: an operator who set
 * more keeps it, and a value this contract cannot parse is left alone and
 * reported, never overwritten blindly.
 */
export function planAdminMemory(
  live: string | null,
  desired: string = ADMIN_MEMORY_DEFAULT,
):
  | { readonly ok: true; readonly flags: readonly string[]; readonly from: string | null }
  | { readonly ok: false; readonly error: string } {
  const desiredMiB = memoryQuantityMiB(desired);
  if (desiredMiB === null) return { ok: false, error: `invalid desired memory "${desired}"` };
  const liveMiB = memoryQuantityMiB(live ?? CLOUD_RUN_DEFAULT_MEMORY);
  if (liveMiB === null) {
    return {
      ok: false,
      error: `the admin's memory "${live}" is not a quantity upgrade understands`,
    };
  }
  if (liveMiB >= desiredMiB) return { ok: true, flags: [], from: live };
  return { ok: true, flags: [`--memory=${desired}`], from: live };
}

// ===========================================================================
// Media volume
// ===========================================================================

/** The CSI driver Cloud Run reports for a Cloud Storage (gcsfuse) volume. */
const GCSFUSE_DRIVER = "gcsfuse.run.googleapis.com";
const EXECUTION_ENVIRONMENT_ANNOTATION = "run.googleapis.com/execution-environment";

interface KnativeVolume {
  readonly name: string;
  readonly csi?: {
    readonly driver?: string;
    readonly readOnly?: boolean;
    readonly volumeAttributes?: { readonly bucketName?: string; readonly mountOptions?: string };
  };
}

interface KnativeVolumeMount {
  readonly name: string;
  readonly mountPath: string;
}

/** The volume-related parts of a `gcloud run services describe --format=json` service. */
export interface LiveVolumes {
  /** `gen1`, `gen2`, or null when the service leaves it to Cloud Run. */
  readonly executionEnvironment: string | null;
  readonly volumes: readonly KnativeVolume[];
  /** Mounts of the first container. */
  readonly mounts: readonly KnativeVolumeMount[];
}

/** Read the execution environment, volumes and mounts of a described service. */
export function liveVolumes(serviceJson: string): LiveVolumes {
  const svc = JSON.parse(serviceJson) as {
    spec?: {
      template?: {
        metadata?: { annotations?: Record<string, string> };
        spec?: {
          volumes?: KnativeVolume[];
          containers?: { volumeMounts?: KnativeVolumeMount[] }[];
        };
      };
    };
  };
  const template = svc.spec?.template;
  return {
    executionEnvironment:
      template?.metadata?.annotations?.[EXECUTION_ENVIRONMENT_ANNOTATION] ?? null,
    volumes: template?.spec?.volumes ?? [],
    mounts: template?.spec?.containers?.[0]?.volumeMounts ?? [],
  };
}

export type MediaVolumePlan =
  | {
      readonly ok: true;
      /** Flags for the roll's `services update`; empty when converged. */
      readonly flags: string[];
      /** One line per change, for the upgrade log. */
      readonly changes: string[];
    }
  | { readonly ok: false; readonly error: string };

function describeVolume(v: KnativeVolume): string {
  if (v.csi?.driver === GCSFUSE_DRIVER) {
    return `Cloud Storage volume "${v.name}" of bucket ${v.csi.volumeAttributes?.bucketName ?? "(none)"}${v.csi.readOnly ? " (read-only)" : ""}`;
  }
  return `volume "${v.name}" (not a Cloud Storage volume)`;
}

/**
 * The flags that give the admin service its media volume
 * ({@link adminMediaVolume} in stack-contract.ts), adding only what is
 * missing: the gen2 execution environment, the volume, the mount. A service
 * that already has exactly that volume and mount — from the stack, an
 * earlier upgrade, or an operator's manual
 * `gcloud run services update … --execution-environment gen2
 *   --add-volume name=media,type=cloud-storage,bucket=<bucket>
 *   --add-volume-mount volume=media,mount-path=<path>` — is converged and
 * gets no volume flags. Mount options on that volume are left as they are.
 *
 * Something else at that name or path (another bucket, a read-only or
 * non-Cloud-Storage volume, the media volume mounted elsewhere) is refused
 * with what was found instead of being replaced: replacing it could point
 * the admin at different media than it has been serving.
 */
export function planMediaVolume(live: LiveVolumes, desired: MediaVolumeContract): MediaVolumePlan {
  const flags: string[] = [];
  const changes: string[] = [];
  const fix = `Remove it (gcloud run services update <admin-service> --remove-volume-mount=${desired.mountPath} --remove-volume=${desired.volumeName}) only if it is not the media you mean to keep, then re-run upgrade.`;

  const volume = live.volumes.find((v) => v.name === desired.volumeName);
  if (volume) {
    const inShape =
      volume.csi?.driver === GCSFUSE_DRIVER &&
      volume.csi.volumeAttributes?.bucketName === desired.bucket &&
      volume.csi.readOnly !== true;
    if (!inShape) {
      return {
        ok: false,
        error: `the admin has ${describeVolume(volume)}, but media must be the read-write Cloud Storage volume of bucket ${desired.bucket}. ${fix}`,
      };
    }
  }
  const atPath = live.mounts.find((m) => m.mountPath === desired.mountPath);
  if (atPath && atPath.name !== desired.volumeName) {
    return {
      ok: false,
      error: `the admin mounts volume "${atPath.name}" at ${desired.mountPath}, where the media bucket belongs. ${fix}`,
    };
  }
  const elsewhere = live.mounts.find(
    (m) => m.name === desired.volumeName && m.mountPath !== desired.mountPath,
  );
  if (elsewhere && !atPath) {
    return {
      ok: false,
      error: `the admin mounts the media volume at ${elsewhere.mountPath}, but the admin reads media from ${desired.mountPath}. ${fix}`,
    };
  }

  if (live.executionEnvironment !== "gen2") {
    flags.push("--execution-environment=gen2");
    changes.push(
      `execution environment: ${live.executionEnvironment ?? "(default)"} → gen2 (Cloud Storage volumes need it)`,
    );
  }
  if (!volume) {
    flags.push(
      `--add-volume=name=${desired.volumeName},type=cloud-storage,bucket=${desired.bucket}`,
    );
    changes.push(`volume ${desired.volumeName}: (none) → Cloud Storage bucket ${desired.bucket}`);
  }
  if (!atPath) {
    flags.push(`--add-volume-mount=volume=${desired.volumeName},mount-path=${desired.mountPath}`);
    changes.push(`volume mount: (none) → ${desired.volumeName} at ${desired.mountPath}`);
  }
  return { ok: true, flags, changes };
}

/**
 * The single `gcloud run services update` that rolls a service to a new
 * image, its run SA and its env changes, so all land in one new revision.
 */
export function serviceRollArgs(roll: {
  readonly serviceName: string;
  readonly region: string;
  readonly projectId: string;
  readonly imageRef: string;
  /** The SA the new revision runs as (stack-contract.ts per-service SAs). */
  readonly serviceAccount: string;
  readonly envFlags: readonly string[];
  /** Resource changes (`--memory=…`) that ride the same revision. */
  readonly resourceFlags?: readonly string[];
  /** The admin's media volume ({@link planMediaVolume}), in the same revision. */
  readonly volumeFlags?: readonly string[];
}): string[] {
  return [
    "run",
    "services",
    "update",
    roll.serviceName,
    "--region",
    roll.region,
    "--project",
    roll.projectId,
    "--image",
    roll.imageRef,
    `--service-account=${roll.serviceAccount}`,
    ...roll.envFlags,
    ...(roll.resourceFlags ?? []),
    ...(roll.volumeFlags ?? []),
    "--quiet",
  ];
}

/**
 * Cloud Run checks at deploy time that the revision's SA can read every
 * secret it references. A `secretAccessor` binding upgrade added seconds
 * earlier (a new secret, the new gateway SA) can take a while to reach that
 * check, so the deploy fails with a permission error that resolves itself.
 */
const SECRET_ACCESS_PROPAGATING = /Permission denied on secret|secretmanager\.versions\.access/i;
const ROLL_RETRY_DELAYS_MS: readonly number[] = [10_000, 20_000, 30_000, 60_000];

/**
 * Run a roll (`serviceRollArgs`), retrying while it fails only because a
 * fresh secret binding has not propagated yet. Any other failure returns at
 * once.
 */
export async function rollService(
  args: string[],
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<GcloudResult> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  let r = await run(args);
  for (const delay of ROLL_RETRY_DELAYS_MS) {
    if (r.ok || !SECRET_ACCESS_PROPAGATING.test(r.stderr)) break;
    await sleep(delay);
    r = await run(args);
  }
  return r;
}
