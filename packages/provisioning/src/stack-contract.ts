// SPDX-License-Identifier: MPL-2.0

/**
 * What a GCP install looks like, declared once for both ways of producing
 * one: the Pulumi stacks (`stacks/gcp`, `stacks/gcp-firebase`) for new
 * installs and `pulumi up`, and `cms-provision upgrade` (stack-converge.ts)
 * for existing installs, which rolls images through gcloud without running
 * Pulumi.
 *
 * Before this contract, everything added to the stacks after an install was
 * created never reached that install: `CAELO_SITE_URL` (so `site_base_url`
 * stayed unset and Stage failed), the run SA's `run.viewer` on the gateway
 * (Firebase Hosting deploys 403'd), the telemetry roles, the one-year CDN
 * TTLs. Three parts close that gap:
 *
 *   - {@link adminEnvContract} / {@link gatewayEnvContract}: the complete
 *     env of the two Cloud Run services — plain values and Secret Manager
 *     references. The stacks deploy them as the Cloud Run `envs`; upgrade
 *     applies them (`--update-env-vars` / `--update-secrets`) in the same
 *     `services update` that rolls the image.
 *   - {@link stackIamInvariants} + {@link STATIC_CDN_POLICY}: the IAM
 *     bindings and CDN settings upgrade ensures with gcloud.
 *   - {@link STACK_IAM_NOT_ENSURED}: bindings upgrade deliberately leaves to
 *     Pulumi, each with the reason. The parity test
 *     (stack-contract-parity.test.ts) fails when a stack declares an IAM
 *     binding that is in neither list, so a new binding cannot ship without
 *     a decision about existing installs.
 *
 * No secret value is ever a plain env var: database URLs carry no password
 * (the apps add it from the `<NAME>_PASSWORD` var, @caelo-cms/shared
 * `databaseUrlFromEnv`), and every secret is a `secretKeyRef` to Secret
 * Manager. Anyone with `run.services.get` sees secret names, never values.
 *
 * Pure module — the stacks import it from `dist/`.
 */

import {
  gatewayServiceAccountEmail,
  gcpBucketName,
  gcpNamePrefix,
  gcpSecretId,
  mcpIapServiceAccountEmail,
  runServiceAccountEmail,
  staticPublisherServiceAccountId,
} from "./gcp-names.js";

export type GcpProvider = "gcp" | "gcp-firebase";
export type CloudRunSlug = "admin" | "gateway";

/**
 * One container env var, in the shape Pulumi's `gcp.cloudrunv2.Service`
 * `envs` accepts. `V` is the value type: `pulumi.Input<string>` in the
 * stacks, `string` in upgrade.
 */
export type CloudRunEnvVar<V = string> =
  | { readonly name: string; readonly value: V }
  | {
      readonly name: string;
      readonly valueSource: {
        readonly secretKeyRef: { readonly secret: V; readonly version: string };
      };
    };

/** Install metadata every service's env derives from. */
export interface ServiceEnvInputs {
  readonly provider: GcpProvider;
  readonly projectId: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  /** Install domain; the public site is served at its apex. */
  readonly domain: string;
  readonly region: string;
}

/** The password-less connection URLs of the install's Cloud SQL databases. */
export interface DatabaseUrls<V = string> {
  /** admin_role on cms_admin — the admin's primary pool. */
  readonly admin: V;
  /** admin_role on cms_public — the admin's second pool (DDL, migrations). */
  readonly publicAdmin: V;
  /** public_role on cms_public — the gateway's visitor-write pool. */
  readonly public: V;
}

/** Port Cloud SQL Postgres listens on (private IP). */
const DATABASE_PORT = 5432;

/**
 * Password-less connection URLs for a Cloud SQL instance at `host`. The
 * password reaches the apps separately, as a Secret Manager reference
 * ({@link SERVICE_SECRET_ENV}).
 */
export function databaseUrls(host: string): DatabaseUrls {
  const url = (role: string, db: string) =>
    `postgresql://${role}@${host}:${DATABASE_PORT}/${db}?sslmode=require`;
  return {
    admin: url("admin_role", "cms_admin"),
    publicAdmin: url("admin_role", "cms_public"),
    public: url("public_role", "cms_public"),
  };
}

/** What a running service's env derives from: install metadata + the database. */
export interface RuntimeEnvInputs<V = string> extends ServiceEnvInputs {
  /** From the Cloud SQL private IP — an Output in the stacks. */
  readonly databaseUrls: DatabaseUrls<V>;
}

/**
 * What the admin's env derives from. Most values come from install metadata;
 * the few Pulumi generates (database host, Firebase site id, the gateway's
 * auto-named Cloud Run service) are passed in — as Outputs by the stack, as
 * discovered strings by upgrade.
 */
export type AdminEnvInputs<V = string> =
  | (RuntimeEnvInputs<V> & { readonly provider: "gcp" })
  | (RuntimeEnvInputs<V> & {
      readonly provider: "gcp-firebase";
      readonly firebaseSiteId: V;
      readonly gatewayService: V;
    });

/** The public site's base URL, as the admin seeds `site_base_url` from it (#551). */
export function publicSiteUrl(domain: string): string {
  return `https://${domain}`;
}

/** Where the admin image ships the static-generator CLI. */
const GENERATOR_CLI = "/app/apps/static-generator/src/cli.ts";

// ===========================================================================
// Runtime secrets
// ===========================================================================

/**
 * The Secret Manager secrets admin + gateway read at runtime, by logical
 * name ({@link gcpSecretId} gives the secret id).
 */
export type RuntimeSecret =
  | "postgres-password"
  | "secret-kek"
  | "internal-secret"
  | "tool-approval-secret";

/**
 * Secrets the CLI generates and stores (runtime-secrets.ts
 * `ensureGeneratedSecrets`) rather than Pulumi: the wizard creates them
 * before `pulumi up`, upgrade creates them on installs that predate them.
 * Pulumi only references them, so a `pulumi up` after an upgrade never
 * collides with a secret upgrade created.
 */
export const CLI_GENERATED_SECRETS = [
  "internal-secret",
  "tool-approval-secret",
] as const satisfies readonly RuntimeSecret[];

/**
 * Each service's Secret Manager-backed env vars and the secret each reads.
 * The services' run SAs get `secretAccessor` on exactly these secrets
 * ({@link runtimeSecretBindings}), so this table is also the least-privilege
 * boundary between the two services.
 */
export const SERVICE_SECRET_ENV: Readonly<
  Record<CloudRunSlug, Readonly<Record<string, RuntimeSecret>>>
> = {
  admin: {
    ADMIN_DATABASE_PASSWORD: "postgres-password",
    PUBLIC_ADMIN_DATABASE_PASSWORD: "postgres-password",
    // P18 — encrypts AI provider keys and other at-rest secrets in cms_admin.
    CAELO_SECRET_KEK: "secret-kek",
    // P15.1 — HMAC key of the /api/internal/* bearer tokens (internal-jwt.ts).
    CAELO_INTERNAL_SECRET: "internal-secret",
    // Binds an AI tool-approval to the exact call the operator approved
    // (admin-core ai/providers/_sdk-shared.ts).
    CAELO_TOOL_APPROVAL_SECRET: "tool-approval-secret",
  },
  gateway: {
    // Known gap against CLAUDE.md §2 ("never let the API Gateway hold
    // admin_role credentials"): the gateway reads site_settings, rate
    // limits, captcha challenges, the request log and the plugin registry
    // through an admin_role pool (apps/api-gateway/src/server.ts), and fails
    // to boot without it. Until that moves behind a narrower role the
    // gateway needs this credential; it is no longer a plain env var.
    ADMIN_DATABASE_PASSWORD: "postgres-password",
    PUBLIC_DATABASE_PASSWORD: "postgres-password",
  },
};

/** The secrets `service` reads (deduplicated, table order). */
export function serviceSecrets(service: CloudRunSlug): RuntimeSecret[] {
  return [...new Set(Object.values(SERVICE_SECRET_ENV[service]))];
}

/**
 * Env vars an older stack set that the contract no longer gives a service;
 * upgrade removes them. The gateway never used the KEK, and its run SA
 * cannot read it.
 */
export const RETIRED_SERVICE_ENV: Readonly<Record<CloudRunSlug, readonly string[]>> = {
  admin: [],
  gateway: ["CAELO_SECRET_KEK"],
};

function secretEnv(service: CloudRunSlug, env: string): CloudRunEnvVar[] {
  return Object.entries(SERVICE_SECRET_ENV[service]).map(([name, secret]) => ({
    name,
    valueSource: { secretKeyRef: { secret: gcpSecretId(env, secret), version: "latest" } },
  }));
}

// ===========================================================================
// Env contracts
// ===========================================================================

/** Env vars both services carry. */
function commonEnv(inputs: ServiceEnvInputs): CloudRunEnvVar[] {
  return [
    { name: "CAELO_PROVIDER", value: inputs.provider },
    { name: "CAELO_ENV", value: inputs.env },
    {
      name: "MEDIA_STORAGE_URL",
      value: `gs://${gcpBucketName(inputs.projectId, inputs.env, "media")}`,
    },
  ];
}

/**
 * The env of the gateway service. Order is stable so the stacks see no
 * spurious diffs.
 */
export function gatewayEnvContract<V>(inputs: RuntimeEnvInputs<V>): CloudRunEnvVar<V | string>[] {
  return [
    ...commonEnv(inputs),
    { name: "PUBLIC_DATABASE_URL", value: inputs.databaseUrls.public },
    // See the known gap noted on SERVICE_SECRET_ENV.gateway.
    { name: "ADMIN_DATABASE_URL", value: inputs.databaseUrls.admin },
    ...secretEnv("gateway", inputs.env),
  ];
}

/**
 * The env of the admin service.
 *
 * @example
 *   adminEnvContract({ provider: "gcp", projectId: "p", env: "production",
 *     domain: "example.com", region: "europe-west1",
 *     databaseUrls: databaseUrls("10.20.0.3") })
 *   // → [{ name: "CAELO_PROVIDER", value: "gcp" }, …,
 *   //    { name: "CAELO_SITE_URL", value: "https://example.com" }, …,
 *   //    { name: "CAELO_SECRET_KEK", valueSource: { secretKeyRef: … } }, …]
 */
export function adminEnvContract<V>(inputs: AdminEnvInputs<V>): CloudRunEnvVar<V | string>[] {
  const { projectId, env, domain } = inputs;
  const admin: CloudRunEnvVar<V | string>[] = [
    ...commonEnv(inputs),
    { name: "ADMIN_DATABASE_URL", value: inputs.databaseUrls.admin },
    // admin_role on cms_public: cross-DB reads, plugin DDL, migrations.
    // Not public_role (write-limited).
    { name: "PUBLIC_ADMIN_DATABASE_URL", value: inputs.databaseUrls.publicAdmin },
    // #551 — the admin seeds site_defaults.site_base_url from it (canonical,
    // og:url, sitemap) when it is not configured yet.
    { name: "CAELO_SITE_URL", value: publicSiteUrl(domain) },
    { name: "CAELO_GENERATOR_CLI", value: GENERATOR_CLI },
    // Issue #37 — shown in the /security/mcp `claude mcp add` command.
    { name: "CAELO_MCP_IAP_SERVICE_ACCOUNT", value: mcpIapServiceAccountEmail(projectId) },
  ];
  if (inputs.provider === "gcp") {
    // v0.2.78 — the GCS StaticPublisher: Stage uploads to staging,
    // Confirm-publish copies to static.
    admin.push(
      { name: "CAELO_STATIC_BUCKET", value: gcpBucketName(projectId, env, "static") },
      { name: "CAELO_STAGING_BUCKET", value: gcpBucketName(projectId, env, "staging") },
    );
  } else {
    // v0.3.1 — the Firebase publisher deploys to this site and declares
    // the /api/** rewrite to the gateway service.
    admin.push(
      { name: "CAELO_FIREBASE_SITE", value: inputs.firebaseSiteId },
      { name: "CAELO_GATEWAY_SERVICE", value: inputs.gatewayService },
      { name: "CAELO_GATEWAY_REGION", value: inputs.region },
    );
  }
  admin.push(...secretEnv("admin", env));
  return admin;
}

// ===========================================================================
// IAM + CDN invariants
// ===========================================================================

/**
 * Cloud CDN policy of the `gcp` stack's static backend bucket. The GCS
 * publisher sets an explicit Cache-Control on every object: content-hashed
 * assets `max-age=31536000, immutable`, pages `max-age=60` + SWR. In
 * CACHE_ALL_STATIC mode `clientTtl` clamps the max-age browsers see and
 * `maxTtl` caps the edge TTL, so both must allow a year or the immutable
 * policy is cut back to 1h (#555). `defaultTtl` applies only to responses
 * without a max-age.
 */
export const STATIC_CDN_POLICY = {
  cacheMode: "CACHE_ALL_STATIC",
  defaultTtl: 3600,
  maxTtl: 31536000,
  clientTtl: 31536000,
} as const;

/** Who an IAM invariant grants a role to. */
export type IamPrincipal =
  /** The runtime SA the admin (and the migration jobs) run as. */
  | "run-sa"
  /** The runtime SA the gateway runs as. */
  | "gateway-sa"
  /** The `gcp` stack's static-publisher SA. */
  | "static-publisher-sa"
  /** IAP's Google-managed service agent (forwards IAP traffic to Cloud Run). */
  | "iap-service-agent"
  | "allUsers";

/** The resource an IAM invariant's binding lives on. */
export type IamTarget =
  | { readonly kind: "project" }
  | { readonly kind: "secret"; readonly name: string }
  | { readonly kind: "bucket"; readonly bucket: "media" | "static" | "staging" }
  | { readonly kind: "run-service"; readonly service: CloudRunSlug };

/**
 * One IAM binding a stack declares and upgrade ensures.
 *
 * `onFailure` decides what upgrade does when it can neither find nor add the
 * binding: `abort` (before any traffic shifts) when the install cannot work
 * without it, `warn` when only something non-essential degrades.
 */
export interface IamInvariant {
  /**
   * Logical name of the stack resource that declares the binding, without
   * the `${namePrefix}-` prefix — the parity test finds it in the stack by
   * this name.
   */
  readonly stackResource: string;
  readonly role: string;
  readonly member: IamPrincipal;
  readonly target: IamTarget;
  readonly onFailure: "abort" | "warn";
  readonly why: string;
}

const SECRET_ACCESSOR = "roles/secretmanager.secretAccessor";

/** One `secretAccessor` binding a stack declares for a service's run SA. */
export interface RuntimeSecretBinding {
  readonly service: CloudRunSlug;
  readonly secret: RuntimeSecret;
  /** Logical stack resource name, without the `${namePrefix}-` prefix. */
  readonly stackResource: string;
}

/**
 * The `secretAccessor` bindings both stacks declare: each service's run SA
 * on exactly the secrets its env reads ({@link SERVICE_SECRET_ENV}).
 */
export function runtimeSecretBindings(): RuntimeSecretBinding[] {
  return (["admin", "gateway"] as const).flatMap((service) =>
    serviceSecrets(service).map((secret) => ({
      service,
      secret,
      // The admin's keep the names they had when one SA served both.
      stackResource: service === "admin" ? `${secret}-binding` : `gateway-${secret}-binding`,
    })),
  );
}

function secretAccessors(): IamInvariant[] {
  return runtimeSecretBindings().map((b) => ({
    stackResource: b.stackResource,
    role: SECRET_ACCESSOR,
    member: b.service === "admin" ? "run-sa" : "gateway-sa",
    target: { kind: "secret", name: b.secret },
    onFailure: "abort",
    why: `the ${b.service} reads ${b.secret} from Secret Manager at boot`,
  }));
}

/** v0.6.6 — a custom runtime SA gets no telemetry roles implicitly. */
const TELEMETRY: readonly IamInvariant[] = [
  {
    stackResource: "run-log-writer",
    role: "roles/logging.logWriter",
    member: "run-sa",
    target: { kind: "project" },
    onFailure: "warn",
    why: "container logs reach Cloud Logging",
  },
  {
    stackResource: "run-metric-writer",
    role: "roles/monitoring.metricWriter",
    member: "run-sa",
    target: { kind: "project" },
    onFailure: "warn",
    why: "CPU/memory metrics reach Cloud Monitoring (autoscaling signals)",
  },
  {
    stackResource: "gateway-log-writer",
    role: "roles/logging.logWriter",
    member: "gateway-sa",
    target: { kind: "project" },
    onFailure: "warn",
    why: "gateway container logs reach Cloud Logging",
  },
  {
    stackResource: "gateway-metric-writer",
    role: "roles/monitoring.metricWriter",
    member: "gateway-sa",
    target: { kind: "project" },
    onFailure: "warn",
    why: "gateway CPU/memory metrics reach Cloud Monitoring (autoscaling signals)",
  },
];

const GCP_ONLY: readonly IamInvariant[] = [
  {
    stackResource: "static-public-read",
    role: "roles/storage.objectViewer",
    member: "allUsers",
    target: { kind: "bucket", bucket: "static" },
    onFailure: "abort",
    why: "Cloud CDN fetches the public site from the static bucket",
  },
  {
    stackResource: "media-rw",
    role: "roles/storage.objectAdmin",
    member: "run-sa",
    target: { kind: "bucket", bucket: "media" },
    onFailure: "abort",
    why: "the admin stores and serves media",
  },
  {
    stackResource: "admin-static-rw",
    role: "roles/storage.objectAdmin",
    member: "run-sa",
    target: { kind: "bucket", bucket: "static" },
    onFailure: "abort",
    why: "Confirm-publish copies the staged build into the static bucket",
  },
  {
    stackResource: "admin-staging-rw",
    role: "roles/storage.objectAdmin",
    member: "run-sa",
    target: { kind: "bucket", bucket: "staging" },
    onFailure: "abort",
    why: "Stage uploads builds to the private staging bucket (v0.2.78)",
  },
  {
    stackResource: "static-publisher-rw",
    role: "roles/storage.objectAdmin",
    member: "static-publisher-sa",
    target: { kind: "bucket", bucket: "static" },
    onFailure: "warn",
    why: "manual `deploy` uploads as the static-publisher SA (the admin publishes without it)",
  },
  {
    stackResource: "iap-invoke-admin",
    role: "roles/run.invoker",
    member: "iap-service-agent",
    target: { kind: "run-service", service: "admin" },
    onFailure: "abort",
    why: "IAP forwards admin traffic to Cloud Run as its service agent",
  },
];

const GCP_FIREBASE_ONLY: readonly IamInvariant[] = [
  {
    stackResource: "media-rw",
    role: "roles/storage.objectAdmin",
    member: "run-sa",
    target: { kind: "bucket", bucket: "media" },
    onFailure: "abort",
    why: "the admin stores and serves media",
  },
  {
    stackResource: "run-firebase-hosting",
    role: "roles/firebasehosting.admin",
    member: "run-sa",
    target: { kind: "project" },
    onFailure: "abort",
    why: "the admin publishes the site to Firebase Hosting",
  },
  {
    stackResource: "gateway-public-invoker",
    role: "roles/run.invoker",
    member: "allUsers",
    target: { kind: "run-service", service: "gateway" },
    onFailure: "abort",
    why: "Firebase Hosting rewrites /api/** to the public gateway",
  },
  {
    stackResource: "gateway-viewer-for-admin-sa",
    role: "roles/run.viewer",
    member: "run-sa",
    target: { kind: "run-service", service: "gateway" },
    onFailure: "abort",
    why: "Firebase Hosting checks run.services.get on the rewrite target at deploy time (v0.6.5; without it every publish 403s)",
  },
  {
    stackResource: "admin-iap-sa-invoker",
    role: "roles/run.invoker",
    member: "iap-service-agent",
    target: { kind: "run-service", service: "admin" },
    onFailure: "abort",
    why: "IAP forwards admin traffic to Cloud Run as its service agent",
  },
];

/** Every IAM binding upgrade ensures on an install of `provider`. */
export function stackIamInvariants(provider: GcpProvider): IamInvariant[] {
  return [
    ...secretAccessors(),
    ...(provider === "gcp" ? GCP_ONLY : GCP_FIREBASE_ONLY),
    ...TELEMETRY,
  ];
}

/**
 * IAM bindings the stacks declare that upgrade deliberately does not ensure,
 * keyed by provider and the stack resource's logical name as written in the
 * stack source, with each `${…}` placeholder written as `*`.
 */
export const STACK_IAM_NOT_ENSURED: Record<GcpProvider, Readonly<Record<string, string>>> = {
  gcp: {
    "admin-iap-allow-*":
      "The IAP allowlist is operator-managed membership from stack config; upgrade must not re-add principals an Owner removed.",
    "mcp-token-creator-*": "Ensured by ensureMcpIapAccess (mcp-iap.ts).",
    "admin-iap-mcp": "Ensured by ensureMcpIapAccess (mcp-iap.ts).",
    "edge-log-sink-bq-perms":
      "The member is the sink's generated writer identity, which only Pulumi knows; analytics only.",
  },
  "gcp-firebase": {
    "admin-iap-*":
      "The IAP allowlist is operator-managed membership from stack config; upgrade must not re-add principals an Owner removed.",
    "admin-invoker-*":
      "Per-principal invoker for the IAP allowlist (operator-managed, see admin-iap-*).",
    "mcp-token-creator-*": "Ensured by ensureMcpIapAccess (mcp-iap.ts).",
    "admin-iap-mcp": "Ensured by ensureMcpIapAccess (mcp-iap.ts).",
  },
};

/** The IAM member string for a principal on a concrete install. */
export function iamMember(
  principal: IamPrincipal,
  install: { readonly projectId: string; readonly projectNumber: string; readonly env: string },
): string {
  switch (principal) {
    case "run-sa":
      return `serviceAccount:${runServiceAccountEmail(install.projectId, install.env)}`;
    case "gateway-sa":
      return `serviceAccount:${gatewayServiceAccountEmail(install.projectId, install.env)}`;
    case "static-publisher-sa":
      return `serviceAccount:${staticPublisherServiceAccountId(install.env)}@${install.projectId}.iam.gserviceaccount.com`;
    case "iap-service-agent":
      return `serviceAccount:service-${install.projectNumber}@gcp-sa-iap.iam.gserviceaccount.com`;
    case "allUsers":
      return "allUsers";
  }
}

/** Name prefix of the `gcp` stack's static backend bucket (Pulumi auto-suffixed). */
export function staticBackendBucketPrefix(env: string): string {
  return `${gcpNamePrefix(env)}-static-backend`;
}
