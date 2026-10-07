// SPDX-License-Identifier: MPL-2.0

/**
 * Converge an existing GCP install to what its Pulumi stack would produce,
 * through gcloud (`cms-provision upgrade` does not run Pulumi). The desired
 * state comes from stack-contract.ts, which the stacks use too.
 *
 *   - {@link planEnvUpdate}: the env-var flags for the `services update` that
 *     rolls the image, so env changes ride the same new revision.
 *   - {@link ensureStackInvariants}: IAM bindings + CDN settings. Each binding
 *     is checked against the resource's policy first and only added when
 *     missing, so an operator without IAM-admin rights can still upgrade an
 *     install that is already in shape.
 */

import { gcloud as defaultGcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import { gcpBucketName, gcpSecretId } from "./gcp-names.js";
import {
  type AdminEnvInputs,
  adminEnvContract,
  type CloudRunEnvVar,
  type CloudRunSlug,
  type GcpProvider,
  gatewayEnvContract,
  type IamInvariant,
  type IamTarget,
  iamMember,
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
        ? { kind: "secret", secret: ref.name, version: ref.key }
        : { kind: "value", value: e.value ?? "" },
    );
  }
  return out;
}

export interface EnvChange {
  readonly name: string;
  /** `undefined` when the service does not have the var yet. */
  readonly from: string | undefined;
  readonly to: string;
}

export type EnvUpdatePlan =
  | { readonly ok: true; readonly changes: EnvChange[]; readonly flags: string[] }
  | { readonly ok: false; readonly error: string };

function describeLive(v: LiveEnvValue): string {
  return v.kind === "value" ? v.value : `secret:${v.secret}:${v.version}`;
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
 * Only vars that differ are touched; vars the contract does not own (the
 * database URLs, the KEK, operator additions) are left alone.
 *
 * A var that would switch between a plain value and a Secret Manager
 * reference is refused: Cloud Run rejects that change inside one update, so
 * it needs a deliberate migration step rather than a silent attempt.
 */
export function planEnvUpdate(
  live: ReadonlyMap<string, LiveEnvValue>,
  desired: readonly CloudRunEnvVar[],
): EnvUpdatePlan {
  const changes: EnvChange[] = [];
  const plain: string[] = [];
  const secrets: string[] = [];
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
      changes.push({ name: entry.name, from: current?.value, to: entry.value });
    } else {
      const { secret, version } = entry.valueSource.secretKeyRef;
      if (current?.kind === "value") {
        return {
          ok: false,
          error: `${entry.name} is a plain value on the service but a Secret Manager reference in the contract`,
        };
      }
      if (current?.secret === secret && current.version === version) continue;
      secrets.push(`${entry.name}=${secret}:${version}`);
      changes.push({
        name: entry.name,
        from: current ? describeLive(current) : undefined,
        to: `secret:${secret}:${version}`,
      });
    }
  }
  const flags = [
    ...(plain.length > 0 ? [listFlag("--update-env-vars", plain)] : []),
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
 * The env changes that bring both deployed services to their env contract
 * (stack-contract.ts — the contract the stacks deploy). Values Pulumi
 * generated at install time are read from the live services. Fails instead
 * of guessing when one can't be determined.
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
      ...install,
      provider: "gcp-firebase",
      firebaseSiteId: site.value,
      gatewayService: services.gateway.serviceName,
    };
  } else {
    inputs = { ...install, provider: "gcp" };
  }
  const skip = new Set(opts.leaveUntouched ?? []);
  const owned = (contract: readonly CloudRunEnvVar[]) => contract.filter((e) => !skip.has(e.name));
  const admin = planEnvUpdate(services.admin.liveEnv, owned(adminEnvContract(inputs)));
  if (!admin.ok) return { ok: false, error: `admin: ${admin.error}` };
  const gateway = planEnvUpdate(services.gateway.liveEnv, owned(gatewayEnvContract(inputs)));
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
  verb: "get-iam-policy" | "add-iam-policy-binding",
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
 * declares (stack-contract.ts). Additive only — nothing is removed. Never
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

  return {
    outcomes,
    mustAbort: outcomes.some((o) => o.status === "failed" && o.onFailure === "abort"),
  };
}

/**
 * The single `gcloud run services update` that rolls a service to a new
 * image and applies its env changes, so both land in one new revision.
 */
export function serviceRollArgs(roll: {
  readonly serviceName: string;
  readonly region: string;
  readonly projectId: string;
  readonly imageRef: string;
  readonly envFlags: readonly string[];
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
    ...roll.envFlags,
    "--quiet",
  ];
}
