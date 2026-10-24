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

import { z } from "zod";
import type { SupportedProvider } from "./adapter.js";
import {
  auditJobResource,
  convergeJobResource,
  gatewayServiceAccountEmail,
  gcpBucketName,
  gcpNamePrefix,
  gcpSecretId,
  mcpIapServiceAccountEmail,
  operatorAccessJobResource,
  runServiceAccountEmail,
  staticPublisherServiceAccountId,
  upgraderJobResource,
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
  /**
   * #650 — the protected staging site's host: the install's setting (the
   * wizard's answer / `--staging-domain`, {@link defaultStagingHost} when
   * the install predates it). Seeds the admin's staging host setting.
   */
  readonly stagingHost: string;
}

/** The password-less connection URLs of the install's Cloud SQL databases. */
export interface DatabaseUrls<V = string> {
  /** admin_role on cms_admin — the admin's primary pool. */
  readonly admin: V;
  /** admin_role on cms_public — the admin's second pool (DDL, migrations). */
  readonly publicAdmin: V;
  /**
   * public_role on cms_public — the gateway's only pool. The gateway has no
   * cms_admin login (#635, CLAUDE.md §2): what it needs from authoring
   * state the admin publishes into cms_public.
   */
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

/**
 * #650 — the staging host an install gets when the operator names none.
 * Same rule as @caelo-cms/shared `defaultStagingHost` (the stacks load this
 * module from `dist/` without the shared package, hence the local copy).
 */
export function defaultStagingHost(domain: string): string {
  return `staging.${domain.trim().toLowerCase().replace(/\.$/, "")}`;
}

/** Env var the admin seeds its staging host setting from. */
export const STAGING_HOST_ENV = "CAELO_STAGING_HOST";

/**
 * The admin env var naming the MCP service account (issue #37). `upgrade`
 * leaves it untouched when it could not set that account up.
 */
export const MCP_ENV_VAR = "CAELO_MCP_IAP_SERVICE_ACCOUNT";

/**
 * The admin env var naming the operator-access sync job. `upgrade` leaves it
 * untouched when it could not set the job up.
 */
export const OPERATOR_ACCESS_JOB_ENV_VAR = "CAELO_OPERATOR_ACCESS_JOB";

/**
 * The admin env var naming the upgrader job (#696) — what Settings →
 * Updates' "Install update" starts. `upgrade` leaves it untouched when it
 * could not set the job up.
 */
export const UPGRADER_JOB_ENV_VAR = "CAELO_UPGRADER_JOB";

/**
 * The admin env var naming the converge job (#819) — what "Install update"
 * starts for a release that changes the cloud setup. `upgrade` leaves it
 * untouched when it could not set the job up.
 */
export const CONVERGE_JOB_ENV_VAR = "CAELO_CONVERGE_JOB";

/**
 * #875 — the admin env vars naming the parallel quality-audit job and the
 * bucket its tasks write results into (admin-core quality/
 * gcp-audit-launcher.ts). `upgrade` leaves them untouched when it could not
 * set the job up.
 */
export const AUDIT_JOB_ENV_VAR = "CAELO_AUDIT_JOB";
export const AUDIT_RESULTS_BUCKET_ENV_VAR = "CAELO_AUDIT_RESULTS_BUCKET";

/** Where the admin image ships the static-generator CLI. */
const GENERATOR_CLI = "/app/apps/static-generator/src/cli.ts";

// ===========================================================================
// Media volume
// ===========================================================================

/**
 * Where the admin keeps media: the image's default media root
 * (`/app/apps/admin` + `data/media`), now the mount point of the media
 * bucket. The admin's `MEDIA_ROOT_DIR` and the static generator (a child
 * process of the admin, same env) both read this path.
 */
export const MEDIA_MOUNT_PATH = "/app/apps/admin/data/media";

/** Name of the admin's Cloud Storage volume. */
export const MEDIA_VOLUME_NAME = "media";

/**
 * The admin's media storage on GCP: the install's media bucket, mounted
 * read-write with Cloud Run's Cloud Storage (gcsfuse) volume at
 * {@link MEDIA_MOUNT_PATH}. Before this, media lived on the container's
 * in-memory filesystem: lost on every new revision and every scale-to-zero,
 * and different on every instance.
 *
 * Cloud Storage volumes need the second-generation execution environment.
 * The stacks deploy this shape ({@link adminMediaVolumeTemplate}); upgrade
 * adds whatever part of it a service is missing (stack-converge.ts
 * `planMediaVolume`).
 */
export interface MediaVolumeContract {
  readonly volumeName: string;
  readonly bucket: string;
  readonly mountPath: string;
}

/** The admin's media volume on an install. */
export function adminMediaVolume(projectId: string, env: string): MediaVolumeContract {
  return {
    volumeName: MEDIA_VOLUME_NAME,
    bucket: gcpBucketName(projectId, env, "media"),
    mountPath: MEDIA_MOUNT_PATH,
  };
}

/**
 * {@link adminMediaVolume} in the shape `gcp.cloudrunv2.Service` takes:
 * `executionEnvironment` + `volumes` on the template, `volumeMounts` on the
 * container.
 */
export function adminMediaVolumeTemplate(volume: MediaVolumeContract) {
  return {
    executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
    volumes: [{ name: volume.volumeName, gcs: { bucket: volume.bucket, readOnly: false } }],
    volumeMounts: [{ name: volume.volumeName, mountPath: volume.mountPath }],
  } as const;
}

// ===========================================================================
// Runtime secrets
// ===========================================================================

/**
 * The Secret Manager secrets admin + gateway read at runtime, by logical
 * name ({@link gcpSecretId} gives the secret id).
 */
export type RuntimeSecret =
  | "postgres-password"
  | "public-role-password"
  | "secret-kek"
  | "internal-secret"
  | "tool-approval-secret"
  | "staging-gate-secret"
  /**
   * #914 — the install's Google sign-in client: JSON
   * `{"client_id","client_secret"}`, `{}` while it is not set up. One client
   * for IAP browser login, IAP programmatic access and the remote-MCP broker
   * (#806 introduced it as `mcp-oauth-client`). The Owner writes it from
   * Settings → Google sign-in (the admin may add versions, never read them);
   * the gateway reads it from a file, the operator-access sync job reads it
   * to hand it to IAP.
   */
  | "operator-oauth-client"
  /**
   * #806 — the broker's AES-256-GCM key (base64, 32 bytes) that seals its
   * stateless OAuth state, codes and refresh tokens. Gateway only.
   */
  | "mcp-oauth-seal-key";

/** The Postgres roles Caelo's services log in as, with their passwords. */
export type DatabaseRole = "admin_role" | "public_role";

/**
 * Each database role's password secret — one per role (#613), so the
 * gateway's SA, which reads only the public_role password, can never read
 * admin_role's (or, since #635, gateway_role's). `postgres-password` keeps its
 * name: it has always been admin_role's (and, before #613, shared with
 * public_role). `rotate-secret` changes exactly the role(s) listed here.
 */
export const DATABASE_ROLE_SECRET: Readonly<Record<DatabaseRole, RuntimeSecret>> = {
  admin_role: "postgres-password",
  public_role: "public-role-password",
};

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
  // #613 — the gateway's own role password. Generated (never seeded from
  // `postgres-password`), so the gateway never learns admin_role's.
  "public-role-password",
  // #650 — the staging access gate's key: signs "Open staging" links and
  // session cookies, derives the crawler credentials. Read by the admin
  // (issues) and the gateway (verifies).
  "staging-gate-secret",
  // #914 / #806 — the Google sign-in client starts as the `{}` placeholder
  // (not configured; the Owner fills it under Settings → Google sign-in),
  // the broker's seal key as 32 random bytes in base64
  // ({@link GENERATED_SECRET_FORMAT}).
  "operator-oauth-client",
  "mcp-oauth-seal-key",
] as const satisfies readonly RuntimeSecret[];

/** A CLI-generated secret's first value: random hex, random base64, or a fixed placeholder. */
export type GeneratedSecretFormat =
  | { readonly kind: "hex32" }
  | { readonly kind: "base64-32" }
  | { readonly kind: "placeholder"; readonly value: string };

/**
 * How each CLI-generated secret's first version is made. Every secret not
 * listed is 32 random bytes as hex — the shape the stacks always generated.
 */
export const GENERATED_SECRET_FORMAT: Readonly<
  Record<(typeof CLI_GENERATED_SECRETS)[number], GeneratedSecretFormat>
> = {
  "internal-secret": { kind: "hex32" },
  "tool-approval-secret": { kind: "hex32" },
  "public-role-password": { kind: "hex32" },
  "staging-gate-secret": { kind: "hex32" },
  // The gateway's seal key contract (#806): base64 of exactly 32 bytes.
  "mcp-oauth-seal-key": { kind: "base64-32" },
  // "Not configured" until the Owner pastes a client (#914). A version must
  // exist from the start: Cloud Run refuses a revision whose secret volume
  // points at a secret without an enabled version.
  "operator-oauth-client": { kind: "placeholder", value: "{}" },
};

/**
 * Secrets an older contract created that nothing reads any more. Upgrade
 * deletes each once both services rolled onto revisions that no longer
 * reference it (stack-converge.ts `deleteRetiredSecrets`); deleting a
 * secret drops its IAM bindings with it. Pre-1.0 delete-don't-migrate: a
 * renamed secret is created fresh, never copied.
 */
export const RETIRED_RUNTIME_SECRETS: readonly { readonly name: string; readonly why: string }[] = [
  {
    // #914 — renamed to `operator-oauth-client`; nobody had configured
    // remote MCP when the rename shipped, so there is nothing to carry over.
    name: "mcp-oauth-client",
    why: "the Google sign-in client moved to operator-oauth-client (#914)",
  },
];

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
    // #650 — issues "Open staging" links, shows the Owner the crawler
    // credentials (admin-core ops/staging_access.ts).
    CAELO_STAGING_GATE_SECRET: "staging-gate-secret",
  },
  gateway: {
    // CLAUDE.md §2: no cms_admin credential of any role (#613, #635).
    // public_role on cms_public is the gateway's only login.
    PUBLIC_DATABASE_PASSWORD: "public-role-password",
    // #650 — verifies staging-host requests (api-gateway staging-proxy.ts).
    CAELO_STAGING_GATE_SECRET: "staging-gate-secret",
    // #806 — seals the remote-MCP broker's state, codes and refresh tokens.
    CAELO_MCP_OAUTH_SEAL_KEY: "mcp-oauth-seal-key",
  },
};

// ===========================================================================
// Secret files (#806)
// ===========================================================================

/** Env var naming the file that holds the install's Google sign-in client (#914). */
export const OPERATOR_OAUTH_CLIENT_FILE_ENV = "CAELO_OPERATOR_OAUTH_CLIENT_FILE";

/**
 * A Secret Manager secret mounted into a service as one file, at `latest`.
 *
 * Why a file and not an env var: Cloud Run resolves a secret env var once,
 * at instance start, but reads a secret volume from Secret Manager each
 * time the file is read ("When reading a volume, Cloud Run always fetches
 * the secret value from the Secret Manager to use the value with the latest
 * version" — cloud.google.com/run/docs/configuring/services/secrets). So the
 * client the Owner saves under Settings → Google sign-in reaches the running gateway
 * (which re-reads it within 60 s) without a new revision, and the admin
 * needs no right to deploy the gateway.
 */
export interface SecretFileContract {
  readonly secret: RuntimeSecret;
  /** Volume name the stacks give it (gcloud names the ones upgrade adds itself). */
  readonly volumeName: string;
  /** Directory the volume is mounted at; must not exist in the image. */
  readonly mountDir: string;
  readonly fileName: string;
  /** Always `latest`: a pinned version would never see the Owner's new client. */
  readonly version: "latest";
}

/** The gateway's Google sign-in client file, read by the remote-MCP broker (#806, #914). */
export const OPERATOR_OAUTH_CLIENT_FILE: SecretFileContract = {
  secret: "operator-oauth-client",
  volumeName: "operator-oauth-client",
  mountDir: "/secrets/operator-oauth-client",
  fileName: "client.json",
  version: "latest",
};

/** Full path of a secret file inside the container. */
export function secretFilePath(file: SecretFileContract): string {
  return `${file.mountDir}/${file.fileName}`;
}

/** Each service's secret files. The admin has none. */
export const SERVICE_SECRET_FILES: Readonly<Record<CloudRunSlug, readonly SecretFileContract[]>> = {
  admin: [],
  gateway: [OPERATOR_OAUTH_CLIENT_FILE],
};

/** A secret file an older contract mounted; upgrade unmounts it in the roll. */
export interface RetiredSecretFile {
  /**
   * The contract name of the secret the file was mounted from (gcp id
   * `caelo-<env>-<secret>`). Names the volume behind the mount — and a
   * volume left behind without one (#954) — so the roll removes it too.
   */
  readonly secret: string;
  readonly mountDir: string;
  readonly fileName: string;
  readonly why: string;
}

/**
 * Secret files older contracts mounted that nothing reads any more, per
 * service. The roll removes each mount (`--remove-secrets=<path>`) and the
 * volume of that secret (`--remove-volume=<name>`) in the same revision that
 * mounts its replacement (stack-converge.ts planSecretFiles).
 */
export const RETIRED_SECRET_FILES: Readonly<Record<CloudRunSlug, readonly RetiredSecretFile[]>> = {
  admin: [],
  gateway: [
    {
      secret: "mcp-oauth-client",
      mountDir: "/secrets/mcp-oauth-client",
      fileName: "client.json",
      why: "the Google sign-in client is mounted from operator-oauth-client now (#914)",
    },
  ],
};

/**
 * The secret files of `service` in the shape `gcp.cloudrunv2.Service`
 * takes: `volumes` on the template, `volumeMounts` on the container.
 */
export function secretFileVolumesTemplate(
  service: CloudRunSlug,
  env: string,
): {
  readonly volumes: {
    name: string;
    secret: { secret: string; items: { version: string; path: string }[] };
  }[];
  readonly volumeMounts: { name: string; mountPath: string }[];
} {
  const files = SERVICE_SECRET_FILES[service];
  return {
    volumes: files.map((f) => ({
      name: f.volumeName,
      secret: {
        secret: gcpSecretId(env, f.secret),
        items: [{ version: f.version, path: f.fileName }],
      },
    })),
    volumeMounts: files.map((f) => ({ name: f.volumeName, mountPath: f.mountDir })),
  };
}

/** The secrets `service` reads, as env or as files (deduplicated, table order). */
export function serviceSecrets(service: CloudRunSlug): RuntimeSecret[] {
  return [
    ...new Set([
      ...Object.values(SERVICE_SECRET_ENV[service]),
      ...SERVICE_SECRET_FILES[service].map((f) => f.secret),
    ]),
  ];
}

/**
 * Env vars an older stack set that the contract no longer gives a service;
 * upgrade removes them. The gateway never used the KEK, and its run SA
 * cannot read it. Its admin_role pool went with #613 and its gateway_role
 * pool with #635 — the gateway refuses to boot while any cms_admin
 * credential is in its env (apps/api-gateway `adminDatabaseAccessInEnv`).
 */
export const RETIRED_SERVICE_ENV: Readonly<Record<CloudRunSlug, readonly string[]>> = {
  // #914 — the sign-in client's store was renamed with its secret.
  admin: ["CAELO_MCP_OAUTH_CLIENT_STORE"],
  gateway: [
    // #914 — renamed to CAELO_OPERATOR_OAUTH_CLIENT_FILE with its secret.
    "CAELO_MCP_OAUTH_CLIENT_FILE",
    "CAELO_SECRET_KEK",
    "ADMIN_DATABASE_URL",
    "ADMIN_DATABASE_PASSWORD",
    // #635 — its gateway_role login on cms_admin is gone too.
    "GATEWAY_DATABASE_URL",
    "GATEWAY_DATABASE_PASSWORD",
  ],
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
 * The env var telling the gateway which `X-Forwarded-For` entry is the
 * visitor (apps/api-gateway client-ip.ts): the number of entries the proxies
 * in front of it append, counting the client's own.
 */
export const TRUSTED_PROXY_HOPS_ENV = "CAELO_TRUSTED_PROXY_HOPS";

/**
 * {@link TRUSTED_PROXY_HOPS_ENV} per provider — a property of each
 * adapter's topology (CLAUDE.md §11.B), so it is declared here once and every
 * adapter sets it on its gateway. The gateway refuses to boot without it.
 * A change to an adapter's path to the gateway must update its entry, or
 * rate limits pool every visitor (too high) or trust a forgeable entry (too
 * low).
 */
export const GATEWAY_TRUSTED_PROXY_HOPS: Readonly<Record<SupportedProvider, number>> = {
  // External Application LB appends `<client>,<LB IP>`; the gateway's
  // ingress is internal-and-LB only, so nothing reaches it around the LB.
  gcp: 2,
  // Cloud Run's front end appends its peer. Behind the Firebase Hosting
  // rewrite that peer is the Hosting CDN edge, and the entry Hosting adds
  // before it cannot be told apart from a forged one (the service is
  // invokable on *.run.app too) — so the edge address is the most that can
  // be trusted. Staging (Cloud Run domain mapping) gets the visitor.
  "gcp-firebase": 1,
  // Caddy without `trusted_proxies` replaces the header with its peer; the
  // gateway is reachable only on the Compose network.
  "self-hosted": 1,
  // CloudFront appends the viewer, the ALB appends CloudFront. (No ECS task
  // definition consumes it yet — see stacks/aws.)
  aws: 2,
  // Container Apps ingress appends its peer; the gateway's ingress is
  // internal to the environment (no Front Door route to it yet).
  azure: 1,
};

/**
 * The env of the gateway service. Order is stable so the stacks see no
 * spurious diffs.
 */
export function gatewayEnvContract<V>(inputs: RuntimeEnvInputs<V>): CloudRunEnvVar<V | string>[] {
  return [
    ...commonEnv(inputs),
    { name: TRUSTED_PROXY_HOPS_ENV, value: String(GATEWAY_TRUSTED_PROXY_HOPS[inputs.provider]) },
    { name: "PUBLIC_DATABASE_URL", value: inputs.databaseUrls.public },
    // #806 — where the remote-MCP broker reads its Google OAuth client
    // (the secret volume of SERVICE_SECRET_FILES).
    { name: OPERATOR_OAUTH_CLIENT_FILE_ENV, value: secretFilePath(OPERATOR_OAUTH_CLIENT_FILE) },
    ...secretEnv("gateway", inputs.env),
  ];
}

/**
 * #806 — the gateway's request timeout, in seconds: Cloud Run's maximum.
 * The gateway proxies remote-MCP requests to the admin, and a `caelo_chat`
 * turn streams for as long as the admin's own chat stream may (the admin
 * runs at 3600 s for the same reason). Visitor endpoints are unaffected: a
 * timeout is a ceiling, not a reservation, and Cloud Run bills request time,
 * not the allowed maximum. On `gcp` the load balancer in front adds no
 * shorter limit — the backend-service timeout does not apply to serverless
 * NEGs, which get a fixed 60 minutes
 * (cloud.google.com/load-balancing/docs/negs/serverless-neg-concepts).
 */
export const GATEWAY_TIMEOUT_SECONDS = 3600;

/** Admin env var naming the Secret Manager secret the Owner writes the Google sign-in client to. */
export const OPERATOR_OAUTH_CLIENT_STORE_ENV = "CAELO_OPERATOR_OAUTH_CLIENT_STORE";

/** `projects/<project>/secrets/<id>` of the Google sign-in client secret (#914). */
export function operatorOAuthClientSecretResource(projectId: string, env: string): string {
  return `projects/${projectId}/secrets/${gcpSecretId(env, "operator-oauth-client")}`;
}

// ===========================================================================
// Remote MCP identity env (#806)
// ===========================================================================

/**
 * The remote-MCP env vars that name generated identities of the install:
 * the admin's URL, the gateway's public origin, and the audience of the IAP
 * JWTs the admin verifies.
 *
 * They are not part of {@link adminEnvContract} / {@link gatewayEnvContract}
 * because the stacks cannot declare them: on `gcp-firebase` each service's
 * value names a Cloud Run service Pulumi auto-names (the admin's audience is
 * its own name; the gateway's public URL is its own URL; the admin's URL is
 * a service created after the gateway), and on `gcp` the audience is the
 * numeric id of a backend service created after the admin. A resource
 * cannot take its own (or a later resource's) output as input.
 *
 * So the CLI reads the live identities and hands them to the stack as
 * config ({@link REMOTE_MCP_IDENTITY_CONFIG}, the way the image digests are
 * pinned), and the stacks declare the vars from it
 * ({@link remoteMcpIdentityStackEnv}): the stack is their one owner, and a
 * `pulumi up` keeps them (#1082 — before, the CLI set them with gcloud
 * after every `up`, every `up` removed them again, and `state migrate`'s
 * preview could never come back clean). The installer resolves them before
 * every `up` of a deployed install, and on a fresh one after the first `up`
 * followed by a second (wizards/gcp.ts); `state migrate`'s preview resolves
 * them the same way (state-pulumi.ts). `upgrade`, which does not run
 * Pulumi, applies the same derived values with its gcloud roll (like the
 * rest of the env contract); a roll that does not set them leaves them as
 * they are (planEnvUpdate never removes a var the contract does not own).
 *
 * #914 adds two the admin's Google sign-in needs: its own URL (the
 * self-check opens it signed out) and the project's Google organisation
 * domain, which the admin's service account cannot read (organisation
 * metadata needs a grant on the organisation) but the operator's identity
 * usually can.
 */
export interface RemoteMcpIdentity {
  /** Where the gateway proxies `/api/mcp/<surface>` to (IAP in front). */
  readonly adminUrl: string;
  /** The broker's public origin; no trailing slash. */
  readonly mcpPublicUrl: string;
  /** The `aud` of the admin's IAP JWTs. */
  readonly iapAudience: string;
  /**
   * #914 — the project's Google organisation domain, `none` when the project
   * is in no organisation, undefined when it could not be read (the var is
   * then left as it is and the admin reports the organisation as unknown).
   */
  readonly googleOrgDomain?: string;
}

/** Env var names of {@link RemoteMcpIdentity}. */
export const REMOTE_MCP_ENV = {
  adminUrl: "CAELO_ADMIN_URL",
  mcpPublicUrl: "CAELO_MCP_PUBLIC_URL",
  iapAudience: "CAELO_IAP_AUDIENCE",
  googleOrgDomain: "CAELO_GOOGLE_ORG_DOMAIN",
} as const;

/** What {@link remoteMcpIdentity} derives the identity from — all read from the live install. */
export type RemoteMcpIdentityInputs =
  | {
      readonly provider: "gcp";
      readonly domain: string;
      readonly projectNumber: string;
      /** Numeric `id` of the admin's IAP-enabled backend service. */
      readonly adminBackendServiceId: string;
    }
  | {
      readonly provider: "gcp-firebase";
      readonly projectNumber: string;
      readonly region: string;
      readonly adminServiceName: string;
      /** The services' `status.url` (`https://<name>-<hash>-<r>.a.run.app`). */
      readonly adminServiceUrl: string;
      readonly gatewayServiceUrl: string;
    };

/**
 * The install's remote-MCP identity.
 *
 * - `gcp`: the broker answers on the site's own host through the load
 *   balancer (`/api/*` and the `/.well-known/oauth-*` path rules), the admin
 *   on `admin.<domain>` behind the LB's IAP; the IAP audience is
 *   `/projects/<number>/global/backendServices/<id>`.
 * - `gcp-firebase`: the broker answers on the gateway's own Cloud Run URL
 *   (Firebase Hosting rewrites cut requests at 60 s and buffer streams), the
 *   admin on its Cloud Run URL behind native IAP — whatever custom domain
 *   is mapped to it, IAP and its audience are the service's; the audience
 *   is `/projects/<number>/locations/<region>/services/<name>`.
 *
 * Audience formats: cloud.google.com/iap/docs/signed-headers-howto.
 */
export function remoteMcpIdentity(i: RemoteMcpIdentityInputs): RemoteMcpIdentity {
  const origin = (url: string) => url.replace(/\/+$/, "");
  if (i.provider === "gcp") {
    return {
      adminUrl: `https://admin.${i.domain}`,
      mcpPublicUrl: publicSiteUrl(i.domain),
      iapAudience: `/projects/${i.projectNumber}/global/backendServices/${i.adminBackendServiceId}`,
    };
  }
  return {
    adminUrl: origin(i.adminServiceUrl),
    mcpPublicUrl: origin(i.gatewayServiceUrl),
    iapAudience: `/projects/${i.projectNumber}/locations/${i.region}/services/${i.adminServiceName}`,
  };
}

/** {@link RemoteMcpIdentity} as each service's env vars. */
export function remoteMcpIdentityEnv(
  id: RemoteMcpIdentity,
): Record<CloudRunSlug, CloudRunEnvVar[]> {
  return {
    admin: [
      { name: REMOTE_MCP_ENV.iapAudience, value: id.iapAudience },
      // The setup pages show the redirect URI and the MCP URLs from it.
      { name: REMOTE_MCP_ENV.mcpPublicUrl, value: id.mcpPublicUrl },
      // #914 — Google sign-in's self-check opens the admin signed out.
      { name: REMOTE_MCP_ENV.adminUrl, value: id.adminUrl },
      // #914 — who IAP admits without the Google sign-in client
      // (admin-core security/identity-gate.ts).
      ...(id.googleOrgDomain
        ? [{ name: REMOTE_MCP_ENV.googleOrgDomain, value: id.googleOrgDomain }]
        : []),
    ],
    gateway: [
      { name: REMOTE_MCP_ENV.adminUrl, value: id.adminUrl },
      { name: REMOTE_MCP_ENV.mcpPublicUrl, value: id.mcpPublicUrl },
    ],
  };
}

/**
 * #1082 — stack config key (`caelo-<provider>:remoteMcpIdentity`) carrying
 * the {@link RemoteMcpIdentity} as JSON. Written by the CLI before `up`,
 * read by the stacks ({@link remoteMcpIdentityStackEnv}).
 */
export const REMOTE_MCP_IDENTITY_CONFIG = "remoteMcpIdentity";

const remoteMcpIdentitySchema = z
  .object({
    adminUrl: z.string().regex(/^https:\/\/[^\s/]+$/),
    mcpPublicUrl: z.string().regex(/^https:\/\/[^\s/]+$/),
    iapAudience: z.string().regex(/^\/projects\/\d+\/[^\s]+$/),
    googleOrgDomain: z
      .string()
      .regex(/^([a-z0-9.-]+\.[a-z]{2,}|none)$/)
      .optional(),
  })
  .strict();

/** {@link RemoteMcpIdentity} as the value of {@link REMOTE_MCP_IDENTITY_CONFIG}. */
export function serializeRemoteMcpIdentity(id: RemoteMcpIdentity): string {
  return JSON.stringify(remoteMcpIdentitySchema.parse(id));
}

/**
 * Parse the {@link REMOTE_MCP_IDENTITY_CONFIG} value; null when unset (a
 * fresh install before its first `up`).
 *
 * @throws Error naming the key when the value is not a valid identity — a
 *   hand-edited or corrupt config must stop the `up`, not silently drop
 *   the vars.
 */
export function parseRemoteMcpIdentityConfig(raw: string | undefined): RemoteMcpIdentity | null {
  if (raw === undefined || raw === "") return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      `stack config ${REMOTE_MCP_IDENTITY_CONFIG} is not JSON; delete the key and re-run the installer, which writes it again from the live install`,
    );
  }
  const parsed = remoteMcpIdentitySchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `stack config ${REMOTE_MCP_IDENTITY_CONFIG} is not a remote-MCP identity (${parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}); delete the key and re-run the installer, which writes it again from the live install`,
    );
  }
  return parsed.data;
}

/**
 * The remote-MCP identity env each Cloud Run service declares in the stacks:
 * {@link remoteMcpIdentityEnv} of the configured identity, nothing while the
 * config is unset.
 */
export function remoteMcpIdentityStackEnv(
  raw: string | undefined,
): Record<CloudRunSlug, CloudRunEnvVar[]> {
  const id = parseRemoteMcpIdentityConfig(raw);
  return id ? remoteMcpIdentityEnv(id) : { admin: [], gateway: [] };
}

/** Whether two identities would give the services the same env. */
export function sameRemoteMcpIdentity(
  a: RemoteMcpIdentity | null,
  b: RemoteMcpIdentity | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.adminUrl === b.adminUrl &&
    a.mcpPublicUrl === b.mcpPublicUrl &&
    a.iapAudience === b.iapAudience &&
    a.googleOrgDomain === b.googleOrgDomain
  );
}

/**
 * #1082 — Pulumi options both stacks give the Cloud Run v2 services.
 * `client` / `clientVersion` only record which tool deployed the service
 * last: `gcloud` sets them on every `upgrade` roll, and the provider
 * (terraform-provider-google `google_cloud_run_v2_service`: `Optional`, not
 * `Computed`) reads them back on refresh, so the stack, which leaves them
 * unset, would plan an update on every service `upgrade` ever rolled. They
 * affect nothing that runs. `ignoreChanges` is Pulumi's way to leave a
 * property to another writer. (The env itself needs no such option: the
 * provider holds `containers.env` as a set, so gcloud's reordering is no
 * diff — only a missing or different var is.)
 */
export const CLOUD_RUN_IGNORE_CHANGES: readonly string[] = ["client", "clientVersion"];

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
    // The mounted media bucket (adminMediaVolume). Explicit so the admin's
    // boot check and the static generator name the same path.
    { name: "MEDIA_ROOT_DIR", value: MEDIA_MOUNT_PATH },
    // Issue #37 — shown in the /settings/mcp `claude mcp add` command.
    { name: MCP_ENV_VAR, value: mcpIapServiceAccountEmail(projectId) },
    // The operator-access sync job the admin starts after user/role changes
    // (admin-core security/operator-access/gcp-job-trigger.ts).
    {
      name: OPERATOR_ACCESS_JOB_ENV_VAR,
      value: operatorAccessJobResource(projectId, inputs.region, env),
    },
    // #696 — the job "Install update" starts (upgrader-setup.ts); the admin
    // may only run it, never override it.
    { name: UPGRADER_JOB_ENV_VAR, value: upgraderJobResource(projectId, inputs.region, env) },
    // #819 — the job "Install update" starts for a release that changes the
    // cloud setup (converge-job-setup.ts); start-only as well.
    { name: CONVERGE_JOB_ENV_VAR, value: convergeJobResource(projectId, inputs.region, env) },
    // #875 — the job the quality audit fans its Lighthouse runs out to, and
    // where the tasks write their results (audit-job-setup.ts).
    { name: AUDIT_JOB_ENV_VAR, value: auditJobResource(projectId, inputs.region, env) },
    { name: AUDIT_RESULTS_BUCKET_ENV_VAR, value: gcpBucketName(projectId, env, "audit-results") },
    // #914 — where Settings → Google sign-in writes the install's Google
    // sign-in client (add-version only, see the run SA's secretVersionAdder
    // invariant).
    {
      name: OPERATOR_OAUTH_CLIENT_STORE_ENV,
      value: operatorOAuthClientSecretResource(projectId, env),
    },
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
      // #650 — seeds the admin's staging host setting (staging builds render
      // it, the gateway's gate answers on it); the admin DB is the truth
      // afterwards, changed under Settings → Domains.
      { name: STAGING_HOST_ENV, value: inputs.stagingHost },
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
const SECRET_VERSION_ADDER = "roles/secretmanager.secretVersionAdder";

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

/** Bindings both GCP stacks declare beyond the secret accessors and telemetry. */
const GCP_COMMON: readonly IamInvariant[] = [
  {
    stackResource: "admin-operator-oauth-client-version-adder",
    // Why the admin may write a secret at all: the Owner pastes the
    // install's Google sign-in client under Settings → Google sign-in, and
    // the admin stores it where the gateway and the operator-access sync job
    // read it. secretVersionAdder is add-version only (no access, no
    // destroy, no IAM), bound on this one secret only — the admin can
    // replace the client, never read it or any other secret.
    role: SECRET_VERSION_ADDER,
    member: "run-sa",
    target: { kind: "secret", name: "operator-oauth-client" },
    onFailure: "warn",
    why: "the Owner's Google sign-in setup (Settings → Google sign-in) stores the OAuth client; without it only that setup fails",
  },
];

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

/**
 * A binding an older stack declared that upgrade removes once nothing reads
 * through it any more (after the rolls). Pulumi drops it on its own: the
 * stacks no longer declare it.
 */
export interface RetiredIamBinding {
  readonly role: string;
  readonly member: IamPrincipal;
  readonly target: IamTarget;
  readonly why: string;
}

/**
 * #613 — the gateway SA's read access to admin_role's password. Removed
 * only after the gateway rolled onto its own role passwords: a revision
 * that still references the secret would fail to start without it.
 */
export const RETIRED_IAM_BINDINGS: readonly RetiredIamBinding[] = [
  {
    role: SECRET_ACCESSOR,
    member: "gateway-sa",
    target: { kind: "secret", name: "postgres-password" },
    why: "the gateway no longer logs in as admin_role and must not be able to read its password (CLAUDE.md §2)",
  },
  {
    role: SECRET_ACCESSOR,
    member: "gateway-sa",
    target: { kind: "secret", name: "gateway-role-password" },
    why: "the gateway has no cms_admin login at all and must not be able to read gateway_role's password (CLAUDE.md §2, #635)",
  },
];

/** Every IAM binding upgrade ensures on an install of `provider`. */
export function stackIamInvariants(provider: GcpProvider): IamInvariant[] {
  return [
    ...secretAccessors(),
    ...GCP_COMMON,
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

// ===========================================================================
// Firewall rules that must not exist
// ===========================================================================

/** One `allowed` entry of a firewall rule, as the Compute API returns it. */
export interface FirewallAllow {
  readonly IPProtocol: "tcp" | "udp" | "icmp";
  readonly ports?: readonly string[];
}

/**
 * One firewall rule GCP auto-creates on the project's `default` network that
 * a Caelo install must not have, in the exact shape GCP creates it. Only a
 * rule matching this shape is deleted; a rule with the same name in any other
 * shape is someone's deliberate change and is reported instead
 * (default-firewall.ts).
 */
export interface AbsentDefaultFirewallRule {
  readonly name: string;
  /** The rule's exact source ranges as GCP creates it. */
  readonly sourceRanges: readonly string[];
  /** The rule's exact `allowed` entries as GCP creates it (order-insensitive). */
  readonly allowed: readonly FirewallAllow[];
  /**
   * The rule carries traffic between VMs on the `default` network. Deleting
   * it cuts that traffic, so it is only deleted when no VM instance in the
   * project sits on the `default` network (default-firewall.ts checks).
   */
  readonly guardsInstanceTraffic: boolean;
  readonly why: string;
}

/** The auto-created network every new GCP project gets with Compute Engine. */
export const GCP_DEFAULT_NETWORK = "default";

/**
 * Enabling Compute Engine gives a new project the `default` VPC network with
 * four pre-populated ingress firewall rules (priority 65534, documented at
 * https://cloud.google.com/firewall/docs/firewalls, "Pre-populated rules in
 * the default network").
 * Caelo runs no VMs and does not use the `default` network at all: the
 * stacks create their own `${namePrefix}-vpc`, with no firewall rules, for
 * Cloud SQL private IP and Cloud Run direct VPC egress
 * (`vpcAccess.networkInterfaces` points at that network;
 * default-firewall.test.ts pins it). So the rules grant nothing today, but
 * every ISO 27001-style audit flags them, and the first VM anyone adds to the
 * project would inherit them. The wizard and `upgrade` delete all four.
 *
 * The shapes are the documented ones. GCP documents no other variant (older
 * legacy-mode default networks are not described), so a rule in any other
 * shape is reported with the delete command instead of deleted. The network
 * itself stays: deleting it is not ours to decide.
 */
export const ABSENT_DEFAULT_FIREWALL_RULES: readonly AbsentDefaultFirewallRule[] = [
  {
    name: "default-allow-ssh",
    sourceRanges: ["0.0.0.0/0"],
    allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
    guardsInstanceTraffic: false,
    why: "SSH open to 0.0.0.0/0 on the default network; Caelo runs no VMs",
  },
  {
    name: "default-allow-rdp",
    sourceRanges: ["0.0.0.0/0"],
    allowed: [{ IPProtocol: "tcp", ports: ["3389"] }],
    guardsInstanceTraffic: false,
    why: "RDP open to 0.0.0.0/0 on the default network; Caelo runs no VMs",
  },
  {
    name: "default-allow-icmp",
    sourceRanges: ["0.0.0.0/0"],
    allowed: [{ IPProtocol: "icmp" }],
    guardsInstanceTraffic: false,
    why: "ICMP open to 0.0.0.0/0 on the default network; Caelo runs no VMs",
  },
  {
    name: "default-allow-internal",
    sourceRanges: ["10.128.0.0/9"],
    allowed: [
      { IPProtocol: "tcp", ports: ["0-65535"] },
      { IPProtocol: "udp", ports: ["0-65535"] },
      { IPProtocol: "icmp" },
    ],
    guardsInstanceTraffic: true,
    why: "all ports between instances on the default network; Caelo does not use that network",
  },
];

/** `tcp:22 from 0.0.0.0/0` — a rule's shape in one line, for reports. */
export function describeFirewallShape(
  allowed: readonly { readonly IPProtocol: string; readonly ports?: readonly string[] }[],
  sourceRanges: readonly string[],
): string {
  const allow = allowed
    .map((a) => `${a.IPProtocol}${a.ports?.length ? `:${a.ports.join(",")}` : ""}`)
    .join(" ");
  return `${allow || "(none)"} from ${sourceRanges.join(",") || "(no ranges)"}`;
}

/** Name prefix of the `gcp` stack's static backend bucket (Pulumi auto-suffixed). */
export function staticBackendBucketPrefix(env: string): string {
  return `${gcpNamePrefix(env)}-static-backend`;
}

/**
 * #553 — the admin's memory, in Cloud Run / Kubernetes quantity notation.
 * The admin runs the quality audit (Lighthouse driving the bundled
 * Chromium in a child process) next to the editor's requests; 1 GiB left
 * no headroom for both, 2 GiB does. Every adapter exposes the same
 * `adminMemory` knob with this default (CLAUDE.md §11.B), and `upgrade`
 * raises an existing install's admin to it (never lowers a larger value).
 */
export const ADMIN_MEMORY_DEFAULT = "2Gi";

/**
 * Parse a memory quantity (`512Mi`, `2Gi`, `2G`, `1.5Gi`) to MiB; null when
 * it is not a quantity this contract understands.
 */
/**
 * #553 — Azure Container Apps (Consumption) only accepts fixed CPU/memory
 * pairs: 0.25 vCPU / 0.5Gi up to 4 vCPU / 8Gi in 0.25 vCPU steps, memory
 * always 2 GiB per vCPU. Map `adminMemory` onto that pair, or throw with
 * the accepted values — an unsupported size must fail before `pulumi up`
 * does, not deploy something else.
 */
export function azureContainerAppResources(quantity: string): {
  readonly cpu: number;
  readonly memory: string;
} {
  const mib = memoryQuantityMiB(quantity);
  if (mib === null || mib % 512 !== 0 || mib < 512 || mib > 8192) {
    throw new Error(
      `caelo-azure:adminMemory "${quantity}" is not a Container Apps size; use 0.5Gi to 8Gi in 0.5Gi steps (e.g. 2Gi = 1 vCPU)`,
    );
  }
  return { cpu: mib / 2048, memory: `${(mib / 1024).toFixed(1)}Gi` };
}

export function memoryQuantityMiB(quantity: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(Mi|Gi|M|G)$/.exec(quantity.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "Mi":
      return Math.round(n);
    case "Gi":
      return Math.round(n * 1024);
    case "M":
      return Math.round((n * 1000 * 1000) / (1024 * 1024));
    default:
      return Math.round((n * 1000 * 1000 * 1000) / (1024 * 1024));
  }
}
