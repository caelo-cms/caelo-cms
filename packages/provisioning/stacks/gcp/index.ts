// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo GCP stack — three-tier deployment per CLAUDE.md §11.B.
 *
 *   Tier 1 — Static site:    GCS + Cloud CDN + Managed SSL via single LB
 *   Tier 2 — Admin app:      Cloud Run + Identity-Aware Proxy (allowlist)
 *   Tier 3 — API gateway:    Cloud Run + Cloud Armor (path-prefix on the LB)
 *   Tier 4 — Database:       Cloud SQL Postgres on private VPC IP only
 *   Tier 5 — Workers:        share the admin's Cloud Run process
 *
 * The same single LB serves both the static site (default route) and the
 * gateway (/api/* prefix). The admin sits on its own Cloud Run domain
 * mapping (admin.<domain>) so IAP can gate it independently — IAP can't
 * be attached selectively to one path of a multi-backend LB.
 *
 * Defaults: minimal-cost (~$30/mo). Operators bump knobs to scale up.
 */

import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import type { CloudAdapterOutputs, DnsRecord } from "../../dist/adapter.js";
import { generateBootstrapToken } from "../../dist/bootstrap-token.js";

const cfg = new pulumi.Config();
const domain = cfg.require("domain");
const ownerEmail = cfg.require("ownerEmail");
const project = cfg.require("project");
const region = cfg.get("region") ?? "us-central1";

// === Operator-tunable knobs (defaults: minimal viable; scale-up later) ===
const cloudSqlTier = cfg.get("cloudSqlTier") ?? "db-f1-micro";
const cloudSqlHa = cfg.getBoolean("cloudSqlHa") ?? false;
// ENTERPRISE supports legacy shared-core tiers (db-f1-micro etc., ~$10/mo).
// ENTERPRISE_PLUS requires per-tier-N machines (~$50+/mo). For docs-shaped
// installs ENTERPRISE is the right call; production-traffic operators can
// flip to PLUS for the IOPS + sub-second failover.
const cloudSqlEdition = cfg.get("cloudSqlEdition") ?? "ENTERPRISE";
// CLAUDE.md §11.C: defaults are minimal-cost + easy-to-tear-down.
// Operators flip deletionProtection ON for production deploys; the
// opt-in shape is safer than the opt-out (a fresh-install user who
// wants to `caelo-cms destroy` shouldn't hit a wall).
const deletionProtection = cfg.getBoolean("deletionProtection") ?? false;
const adminMinInstances = Number.parseInt(cfg.get("adminMinInstances") ?? "0", 10);
const gatewayMinInstances = Number.parseInt(cfg.get("gatewayMinInstances") ?? "0", 10);
const wafAdaptiveProtection = cfg.getBoolean("wafAdaptiveProtection") ?? false;
const backupRetentionDays = Number.parseInt(cfg.get("backupRetentionDays") ?? "7", 10);
// IAP allowlist: comma-list of "user:<email>" or "group:<group@domain>".
// Empty config string falls back to just the ownerEmail.
const iapAllowlistRaw = cfg.get("iapAllowlist");
const iapAllowlist =
  iapAllowlistRaw && iapAllowlistRaw.trim().length > 0
    ? iapAllowlistRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [`user:${ownerEmail}`];

const env = pulumi.getStack() as "dev" | "staging" | "production";
const namePrefix = `caelo-${env}`;
const adminDomain = `admin.${domain}`;

const gcpProvider = new gcp.Provider(`${namePrefix}-gcp`, { project, region });
const opts = { provider: gcpProvider };

// =========================================================================
// VPC for private Cloud SQL — Cloud Run reaches Postgres via private IP only
// =========================================================================

const network = new gcp.compute.Network(
  `${namePrefix}-vpc`,
  { autoCreateSubnetworks: false, description: `Caelo ${env} VPC` },
  opts,
);

const subnet = new gcp.compute.Subnetwork(
  `${namePrefix}-subnet`,
  {
    region,
    ipCidrRange: "10.20.0.0/20",
    network: network.id,
    privateIpGoogleAccess: true,
  },
  opts,
);

const privateIpAlloc = new gcp.compute.GlobalAddress(
  `${namePrefix}-pg-private-ip`,
  {
    purpose: "VPC_PEERING",
    addressType: "INTERNAL",
    prefixLength: 16,
    network: network.id,
  },
  opts,
);

const sqlPeering = new gcp.servicenetworking.Connection(
  `${namePrefix}-pg-peering`,
  {
    network: network.id,
    service: "servicenetworking.googleapis.com",
    reservedPeeringRanges: [privateIpAlloc.name],
  },
  opts,
);

// =========================================================================
// Secret Manager — never env-var literal; runtime mounts via secret_environment_variables
// =========================================================================

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const postgresPassword = pulumi.secret(randomHex(32));
const csrfSecret = pulumi.secret(randomHex(32));
const cookieSecret = pulumi.secret(randomHex(32));
// P18 — project KEK (32 bytes hex) encrypts AI provider API keys + future
// at-rest secrets in cms_admin. Auto-generated per stack so the operator
// never types it; Cloud Run binds it as CAELO_SECRET_KEK env via
// `valueSource.secretKeyRef` below. Rotating it requires a re-encrypt
// CLI (deferred — the api_key_kek_fp column lets a future tool find rows
// under the old KEK and refuse to silently return garbage).
const caeloSecretKek = pulumi.secret(randomHex(32));
// anthropicApiKey is now OPTIONAL — operators configure the key via
// /security/ai (encrypted into ai_providers) after first login. Setting
// it via Pulumi config is supported as a backwards-compat path for
// installs that already wired it before P18; the Secret resource still
// exists in either case so a future v1 can be added without redeploying.
const anthropicApiKeyConfig = cfg.getSecret("anthropicApiKey");
// resendApiKey is OPTIONAL — empty config means "skip the SecretVersion"
// so GCP doesn't reject `payload: ""`. The Secret resource itself still
// exists; operators add a v1 later via `gcloud secrets versions add`.
const resendApiKeyConfig = cfg.getSecret("resendApiKey");

interface MadeSecret {
  resource: gcp.secretmanager.Secret;
  version: gcp.secretmanager.SecretVersion | null;
}

function makeSecret(name: string, value: pulumi.Output<string> | null): MadeSecret {
  const resource = new gcp.secretmanager.Secret(
    `${namePrefix}-${name}`,
    { secretId: `${namePrefix}-${name}`, replication: { auto: {} } },
    opts,
  );
  if (value === null) {
    return { resource, version: null };
  }
  const version = new gcp.secretmanager.SecretVersion(
    `${namePrefix}-${name}-v1`,
    { secret: resource.name, secretData: value },
    { ...opts, dependsOn: [resource] },
  );
  return { resource, version };
}

const pgSecret = makeSecret("postgres-password", postgresPassword);
const csrfSecretRes = makeSecret("csrf-secret", csrfSecret);
const cookieSecretRes = makeSecret("cookie-secret", cookieSecret);
const kekSecret = makeSecret("secret-kek", caeloSecretKek);
// Anthropic key is optional now — operators configure providers via
// /security/ai after first login. Skip the v1 when no key is in config;
// the Secret resource still exists for backwards-compat env-var path.
const anthropicSecretRes = makeSecret("anthropic-api-key", anthropicApiKeyConfig ?? null);
// Resend: skip the v1 when no key is configured (cfg.getSecret returns
// undefined when the key is unset in Pulumi.yaml + not overridden in the
// stack config). The Secret resource still exists; operators add a v1
// later via `gcloud secrets versions add` or `pulumi config set --secret`.
const resendSecretRes = makeSecret("resend-api-key", resendApiKeyConfig ?? null);

// =========================================================================
// Tier 4 — Cloud SQL Postgres (private IP only; HA + retention configurable)
// =========================================================================

const sqlInstance = new gcp.sql.DatabaseInstance(
  `${namePrefix}-pg`,
  {
    databaseVersion: "POSTGRES_16",
    region,
    settings: {
      tier: cloudSqlTier,
      edition: cloudSqlEdition,
      availabilityType: cloudSqlHa ? "REGIONAL" : "ZONAL",
      diskSize: 20,
      diskType: "PD_SSD",
      diskAutoresize: true,
      backupConfiguration: {
        enabled: true,
        pointInTimeRecoveryEnabled: cloudSqlHa,
        startTime: "03:00",
        backupRetentionSettings: {
          retentionUnit: "COUNT",
          retainedBackups: backupRetentionDays,
        },
      },
      ipConfiguration: {
        ipv4Enabled: false,
        privateNetwork: network.id,
      },
      deletionProtectionEnabled: deletionProtection,
    },
    deletionProtection,
  },
  { ...opts, dependsOn: [sqlPeering] },
);

// Caelo's DatabaseAdapter.verifyRoles() asserts that the connecting
// user IS named admin_role or public_role per CMS_REQUIREMENTS §12.3
// (matches the bootstrap.sh self-hosted setup). Cloud SQL uses
// CREATE USER which is just CREATE ROLE WITH LOGIN, so the role names
// passed here become the auth user names — no rename needed.
const pgAdminUser = new gcp.sql.User(
  `${namePrefix}-pg-admin`,
  { instance: sqlInstance.name, name: "admin_role", password: postgresPassword },
  opts,
);

const pgPublicUser = new gcp.sql.User(
  `${namePrefix}-pg-public`,
  { instance: sqlInstance.name, name: "public_role", password: postgresPassword },
  opts,
);

const cmsAdminDb = new gcp.sql.Database(
  `${namePrefix}-cms-admin-db`,
  { instance: sqlInstance.name, name: "cms_admin" },
  opts,
);
const cmsPublicDb = new gcp.sql.Database(
  `${namePrefix}-cms-public-db`,
  { instance: sqlInstance.name, name: "cms_public" },
  opts,
);

// admin_role on cms_admin — admin app's primary DB.
const adminDatabaseUrl = pulumi
  .all([sqlInstance.privateIpAddress, postgresPassword])
  .apply(([host, pw]) => `postgresql://admin_role:${pw}@${host}:5432/cms_admin?sslmode=require`);
// admin_role on cms_public — admin's second pool: cross-DB reads of
// plugin data + DDL for plugin schemas + migration runs. Wired to the
// admin (and migration job) via PUBLIC_ADMIN_DATABASE_URL.
const publicAdminDatabaseUrl = pulumi
  .all([sqlInstance.privateIpAddress, postgresPassword])
  .apply(([host, pw]) => `postgresql://admin_role:${pw}@${host}:5432/cms_public?sslmode=require`);
// public_role on cms_public — write-limited gateway role. Wired to the
// gateway via PUBLIC_DATABASE_URL.
const publicDatabaseUrl = pulumi
  .all([sqlInstance.privateIpAddress, postgresPassword])
  .apply(([host, pw]) => `postgresql://public_role:${pw}@${host}:5432/cms_public?sslmode=require`);

// Reference pgPublicUser so Pulumi knows it's part of the dependency
// graph (Cloud Run env-var deps don't see this directly).
void pgPublicUser;

// =========================================================================
// GCS buckets — static (Tier 1 origin, public-read) + media (private, signed-URL only)
// =========================================================================

const mediaBucket = new gcp.storage.Bucket(
  `${namePrefix}-media`,
  {
    name: `${project}-${namePrefix}-media`,
    location: region.toUpperCase(),
    uniformBucketLevelAccess: true,
    forceDestroy: env !== "production",
    versioning: { enabled: env === "production" },
  },
  opts,
);

const staticBucket = new gcp.storage.Bucket(
  `${namePrefix}-static`,
  {
    name: `${project}-${namePrefix}-static`,
    location: region.toUpperCase(),
    uniformBucketLevelAccess: true,
    forceDestroy: env !== "production",
    website: { mainPageSuffix: "index.html", notFoundPage: "404.html" },
    cors: [
      {
        origins: [`https://${domain}`],
        methods: ["GET", "HEAD"],
        responseHeaders: ["Content-Type"],
        maxAgeSeconds: 3600,
      },
    ],
  },
  opts,
);

// Public read on the static bucket so Cloud CDN can fetch.
new gcp.storage.BucketIAMMember(
  `${namePrefix}-static-public-read`,
  {
    bucket: staticBucket.name,
    role: "roles/storage.objectViewer",
    member: "allUsers",
  },
  opts,
);

// =========================================================================
// Cloud Run service account — single SA used by admin + gateway
// =========================================================================

const runSa = new gcp.serviceaccount.Account(
  `${namePrefix}-run-sa`,
  {
    accountId: `${namePrefix}-run-sa`,
    displayName: `Caelo ${env} Cloud Run service account`,
  },
  opts,
);

// Pass the Secret RESOURCE (not a hardcoded id) so Pulumi infers the
// dependency edge — otherwise the IamMember create races the Secret
// create on first apply and 404s. Same `dependsOn` for belt-and-braces.
for (const made of [
  { name: "postgres-password", made: pgSecret },
  { name: "csrf-secret", made: csrfSecretRes },
  { name: "cookie-secret", made: cookieSecretRes },
  { name: "secret-kek", made: kekSecret },
  { name: "anthropic-api-key", made: anthropicSecretRes },
  { name: "resend-api-key", made: resendSecretRes },
]) {
  new gcp.secretmanager.SecretIamMember(
    `${namePrefix}-${made.name}-binding`,
    {
      // .secretId from the resource is an Output<string> — Pulumi
      // tracks the read-after-create edge automatically.
      secretId: made.made.resource.secretId,
      role: "roles/secretmanager.secretAccessor",
      member: pulumi.interpolate`serviceAccount:${runSa.email}`,
    },
    { ...opts, dependsOn: [made.made.resource] },
  );
}

new gcp.storage.BucketIAMMember(
  `${namePrefix}-media-rw`,
  {
    bucket: mediaBucket.name,
    role: "roles/storage.objectAdmin",
    member: pulumi.interpolate`serviceAccount:${runSa.email}`,
  },
  opts,
);

// `static-publisher` SA used by `bunx @caelo-cms/provisioning deploy` to
// upload the static-generator output to the bucket. Separate from runSa so
// admin Cloud Run can never accidentally write to the public-read bucket.
// Account-id max 30 chars; collapse "production" → "prod" so dev/staging/prod
// all fit within the budget.
const envShort = env === "production" ? "prod" : env === "staging" ? "stg" : "dev";
const staticPublisherSa = new gcp.serviceaccount.Account(
  `${namePrefix}-static-publisher`,
  {
    accountId: `caelo-${envShort}-publisher`,
    displayName: `Caelo ${env} static publisher`,
  },
  opts,
);
new gcp.storage.BucketIAMMember(
  `${namePrefix}-static-publisher-rw`,
  {
    bucket: staticBucket.name,
    role: "roles/storage.objectAdmin",
    member: pulumi.interpolate`serviceAccount:${staticPublisherSa.email}`,
  },
  opts,
);

// =========================================================================
// Tier 2 + Tier 3 — Cloud Run services (admin + gateway only; workers share admin)
// =========================================================================

// §11.C: pre-built signed images on a public registry are the contract.
// The Caelo team publishes admin + gateway images to a public-pull AR
// repo at `europe-west1-docker.pkg.dev/<CAELO_PUBLIC_REGISTRY_PROJECT>
// /caelo-cms-images/<service>:<tag>`. Cloud Run reads it directly with
// no operator-side IAM binding (the repo's allUsers role grants
// anonymous pull). No per-install image copy, no operator-owned AR
// repo, no wizard step. Same shape per provider — AWS reads
// `public.ecr.aws/caelo-cms/...`, Azure reads the team-controlled ACR.
//
// Default points at the Caelo-team-managed registry. Operators who want
// to pull from their own copy override per-stack via
// `pulumi config set caelo-gcp:image-<service> <full-tag>` or
// `pulumi config set caelo-gcp:public-registry-project <other-project>`.
const publicRegistryProject = cfg.get("public-registry-project") ?? "caelo-website";
const publicRegistryRegion = cfg.get("public-registry-region") ?? "europe-west1";
const publicRegistryRepo = cfg.get("public-registry-repo") ?? "caelo-cms-images";
const imageTagSource = cfg.get("image-tag") ?? "main";

function imageTag(service: string): pulumi.Output<string> {
  // Per-service digest pin (`image-digest-<service>`): operator can pin
  // an exact sha256 digest. The wizard resolves this at provision time
  // (resolves :main → digest via `gcloud artifacts docker images list`)
  // so each pulumi up rolls Cloud Run to the freshest published image
  // even though the `:main` tag is mutable. Without this Cloud Run
  // would silently keep running an old image after a release.
  const override = cfg.get(`image-${service}`);
  if (override) return pulumi.output(override);
  const digest = cfg.get(`image-digest-${service}`);
  const base = `${publicRegistryRegion}-docker.pkg.dev/${publicRegistryProject}/${publicRegistryRepo}/${service}`;
  return pulumi.output(digest ? `${base}@${digest}` : `${base}:${imageTagSource}`);
}

interface CloudRunArgs {
  readonly serviceName: string;
  readonly minInstances: number;
  readonly maxInstances: number;
  readonly memory: string;
  readonly extraEnv?: ReadonlyArray<{ name: string; value: pulumi.Input<string> }>;
}

function cloudRunService(args: CloudRunArgs): gcp.cloudrunv2.Service {
  return new gcp.cloudrunv2.Service(
    `${namePrefix}-${args.serviceName}`,
    {
      location: region,
      // INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER means only the LB can reach
      // the gateway directly. Admin uses Cloud Run domain mapping +
      // IAP (set below) so its URL must be public-resolvable but
      // IAP gates every request.
      ingress:
        args.serviceName === "admin"
          ? "INGRESS_TRAFFIC_ALL"
          : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      // Cloud Run defaults deletionProtection=true, which blocks
      // `pulumi destroy` until the field is flipped + a separate up
      // applies the change. We default to false (operator-friendly
      // teardown); production deploys flip the `deletionProtection`
      // config knob to true.
      deletionProtection,
      template: {
        serviceAccount: runSa.email,
        scaling: {
          minInstanceCount: args.minInstances,
          maxInstanceCount: args.maxInstances,
        },
        containers: [
          {
            image: imageTag(args.serviceName),
            envs: [
              { name: "CAELO_PROVIDER", value: "gcp" },
              { name: "CAELO_ENV", value: env },
              { name: "ADMIN_DATABASE_URL", value: adminDatabaseUrl },
              { name: "MEDIA_STORAGE_URL", value: pulumi.interpolate`gs://${mediaBucket.name}` },
              // P18 — project KEK is mounted from Secret Manager so AI
              // provider keys (and any future at-rest secrets) can be
              // decrypted at runtime. Failing to bind would surface as
              // "CAELO_SECRET_KEK is not set" the moment the resolver
              // tries to decrypt — clear, loud failure.
              {
                name: "CAELO_SECRET_KEK",
                valueSource: {
                  secretKeyRef: { secret: kekSecret.resource.secretId, version: "latest" },
                },
              },
              ...(args.extraEnv ?? []),
            ],
            resources: { limits: { cpu: "1", memory: args.memory } },
          },
        ],
        vpcAccess: {
          networkInterfaces: [{ network: network.name, subnetwork: subnet.name }],
          egress: "PRIVATE_RANGES_ONLY",
        },
      },
    },
    {
      ...opts,
      dependsOn: [
        pgAdminUser,
        cmsAdminDb,
        cmsPublicDb,
        ...(pgSecret.version ? [pgSecret.version] : []),
        // KEK must exist before Cloud Run can mount it via secretKeyRef.
        ...(kekSecret.version ? [kekSecret.version] : []),
      ],
    },
  );
}

const adminSvc = cloudRunService({
  serviceName: "admin",
  minInstances: adminMinInstances,
  maxInstances: 10,
  memory: "1Gi",
  // Admin's second pool: admin_role on cms_public for cross-DB reads
  // + DDL + migrations. NOT public_role (write-limited).
  extraEnv: [{ name: "PUBLIC_ADMIN_DATABASE_URL", value: publicAdminDatabaseUrl }],
});
const gatewaySvc = cloudRunService({
  serviceName: "gateway",
  minInstances: gatewayMinInstances,
  maxInstances: 100,
  memory: "512Mi",
  // Gateway's only DB pool: public_role on cms_public, write-limited
  // per CLAUDE.md (gateway must NEVER hold admin_role creds).
  extraEnv: [{ name: "PUBLIC_DATABASE_URL", value: publicDatabaseUrl }],
});

// =========================================================================
// Tier 1 + Tier 2 + Tier 3 LB — single HTTPS LB serves three backends
// =========================================================================
//
// One global IP, one URL map, one managed cert covering caelo-cms.com +
// admin.caelo-cms.com. Three backends routed by Host header / path:
//   - host=caelo-cms.com, default          → static bucket (Cloud CDN)
//   - host=caelo-cms.com, path=/api/*      → gateway Cloud Run (Cloud Armor)
//   - host=admin.caelo-cms.com, default    → admin Cloud Run (IAP-gated)
//
// CLAUDE.md §11.B Tier 2: admin behind cloud-native identity proxy. IAP
// attaches to the admin BackendService directly (iap.enabled=true on the
// BackendService spec) — no DomainMapping (avoids GCP's Search Console
// verification gate that bites every operator), no post-up
// `gcloud run services update --iap` step. Operator just adds an A
// record for admin.<domain> pointing at the LB IP and the IAP allowlist
// gates access.

const lbIp = new gcp.compute.GlobalAddress(
  `${namePrefix}-lb-ip`,
  { addressType: "EXTERNAL", description: "Caelo public LB IP" },
  opts,
);

// Tier 3 — Cloud Armor security policy (rate limit + OWASP basic rules)
const wafPolicy = new gcp.compute.SecurityPolicy(
  `${namePrefix}-waf`,
  {
    description: `Caelo ${env} Cloud Armor — rate limit + OWASP`,
    rules: [
      // Rate limit per source IP — 100 req / min sliding window.
      {
        action: "rate_based_ban",
        priority: 1000,
        match: {
          versionedExpr: "SRC_IPS_V1",
          config: { srcIpRanges: ["*"] },
        },
        rateLimitOptions: {
          rateLimitThreshold: { count: 100, intervalSec: 60 },
          conformAction: "allow",
          exceedAction: "deny(429)",
          enforceOnKey: "IP",
          banDurationSec: 600,
        },
      },
      // OWASP rule pack (preconfigured WAF) — free tier covers the basics.
      {
        action: "deny(403)",
        priority: 2000,
        match: {
          expr: { expression: "evaluatePreconfiguredWaf('sqli-v33-stable')" },
        },
      },
      {
        action: "deny(403)",
        priority: 2001,
        match: {
          expr: { expression: "evaluatePreconfiguredWaf('xss-v33-stable')" },
        },
      },
      // Default allow.
      {
        action: "allow",
        priority: 2147483647,
        match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["*"] } },
      },
    ],
    ...(wafAdaptiveProtection
      ? { adaptiveProtectionConfig: { layer7DdosDefenseConfig: { enable: true } } }
      : {}),
  },
  opts,
);

// Tier 1 backend — static GCS bucket via Cloud CDN
const staticBackendBucket = new gcp.compute.BackendBucket(
  `${namePrefix}-static-backend`,
  {
    bucketName: staticBucket.name,
    enableCdn: true,
    cdnPolicy: {
      cacheMode: "CACHE_ALL_STATIC",
      defaultTtl: 3600,
      maxTtl: 86400,
      clientTtl: 3600,
    },
  },
  opts,
);

// Tier 3 backend — gateway Cloud Run via serverless NEG
const gatewayNeg = new gcp.compute.RegionNetworkEndpointGroup(
  `${namePrefix}-gateway-neg`,
  {
    region,
    networkEndpointType: "SERVERLESS",
    cloudRun: { service: gatewaySvc.name },
  },
  opts,
);

const gatewayBackendService = new gcp.compute.BackendService(
  `${namePrefix}-gateway-backend`,
  {
    protocol: "HTTPS",
    backends: [{ group: gatewayNeg.id }],
    loadBalancingScheme: "EXTERNAL_MANAGED",
    securityPolicy: wafPolicy.id,
  },
  opts,
);

// Tier 2 backend — admin Cloud Run via serverless NEG, IAP-gated.
const adminNeg = new gcp.compute.RegionNetworkEndpointGroup(
  `${namePrefix}-admin-neg`,
  {
    region,
    networkEndpointType: "SERVERLESS",
    cloudRun: { service: adminSvc.name },
  },
  opts,
);

// Google-managed IAP requires a GCP-managed service identity in the
// project. Pulumi's iap.enabled=true on a BackendService doesn't
// trigger this auto-provision (only the gcloud CLI does). Without it,
// IAP gets through OAuth but then errors with "The IAP service account
// is not provisioned" when forwarding to Cloud Run. ServiceIdentity
// creates `service-<project-number>@gcp-sa-iap.iam.gserviceaccount.com`
// idempotently.
const iapServiceIdentity = new gcp.projects.ServiceIdentity(
  `${namePrefix}-iap-sa`,
  { project, service: "iap.googleapis.com" },
  opts,
);

// IAP forwards authenticated requests to Cloud Run via this SA, which
// needs run.invoker on the admin service.
new gcp.cloudrunv2.ServiceIamMember(
  `${namePrefix}-iap-invoke-admin`,
  {
    location: region,
    name: adminSvc.name,
    role: "roles/run.invoker",
    member: pulumi.interpolate`serviceAccount:${iapServiceIdentity.email}`,
  },
  opts,
);

// Google-managed IAP: enabled=true with no OAuth client/secret means
// IAP auto-provisions and manages the OAuth credentials internally.
// The classic gcp.iap.Brand + Client resources are deprecated (the IAP
// OAuth Admin API shuts down March 19, 2026); Google-managed IAP is
// the documented replacement and Just Works for new projects.
const adminBackendService = new gcp.compute.BackendService(
  `${namePrefix}-admin-backend`,
  {
    protocol: "HTTPS",
    backends: [{ group: adminNeg.id }],
    loadBalancingScheme: "EXTERNAL_MANAGED",
    iap: { enabled: true },
  },
  { ...opts, dependsOn: [iapServiceIdentity] },
);

// IAP allowlist — bind iap.httpsResourceAccessor on the admin
// BackendService directly (resource-scoped, narrower than project-wide).
for (const principal of iapAllowlist) {
  new gcp.iap.WebBackendServiceIamMember(
    `${namePrefix}-admin-iap-allow-${principal.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`,
    {
      project,
      webBackendService: adminBackendService.name,
      role: "roles/iap.httpsResourceAccessor",
      member: principal,
    },
    opts,
  );
}

// URL map: routes by host header.
//   admin.<domain>  → admin backend (IAP-gated)
//   <domain>        → default static bucket; /api/* → gateway
const urlMap = new gcp.compute.URLMap(
  `${namePrefix}-url-map`,
  {
    defaultService: staticBackendBucket.id,
    hostRules: [
      { hosts: [domain], pathMatcher: "public" },
      { hosts: [adminDomain], pathMatcher: "admin" },
    ],
    pathMatchers: [
      {
        name: "public",
        defaultService: staticBackendBucket.id,
        pathRules: [{ paths: ["/api/*"], service: gatewayBackendService.id }],
      },
      {
        name: "admin",
        defaultService: adminBackendService.id,
      },
    ],
  },
  opts,
);

// Managed TLS cert covering both hostnames. Single cert resource;
// the certificate's SAN list grows by one entry vs the prior version.
const managedCert = new gcp.compute.ManagedSslCertificate(
  `${namePrefix}-cert`,
  { managed: { domains: [domain, adminDomain] } },
  opts,
);

const httpsProxy = new gcp.compute.TargetHttpsProxy(
  `${namePrefix}-https-proxy`,
  { urlMap: urlMap.id, sslCertificates: [managedCert.id] },
  opts,
);

new gcp.compute.GlobalForwardingRule(
  `${namePrefix}-https-fwd`,
  {
    target: httpsProxy.id,
    portRange: "443",
    ipAddress: lbIp.address,
    loadBalancingScheme: "EXTERNAL_MANAGED",
  },
  opts,
);

// HTTP → HTTPS redirect: a tiny URLMap with no backend, just a 301
// redirect rule. Same LB IP, port 80, returns to the request's host
// over HTTPS preserving the path. Without this, http:// requests get
// ERR_EMPTY_RESPONSE.
const httpRedirectMap = new gcp.compute.URLMap(
  `${namePrefix}-http-redirect`,
  {
    defaultUrlRedirect: {
      httpsRedirect: true,
      redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
      stripQuery: false,
    },
  },
  opts,
);

const httpProxy = new gcp.compute.TargetHttpProxy(
  `${namePrefix}-http-proxy`,
  { urlMap: httpRedirectMap.id },
  opts,
);

new gcp.compute.GlobalForwardingRule(
  `${namePrefix}-http-fwd`,
  {
    target: httpProxy.id,
    portRange: "80",
    ipAddress: lbIp.address,
    loadBalancingScheme: "EXTERNAL_MANAGED",
  },
  opts,
);

// =========================================================================
// Cloud Logging sink → BigQuery for the analytics plugin
// =========================================================================

const edgeLogDataset = new gcp.bigquery.Dataset(
  `${namePrefix}-edge-logs-ds`,
  {
    datasetId: `${namePrefix.replace(/-/g, "_")}_edge_logs`,
    location: region.toUpperCase(),
    description: `Caelo ${env} edge log sink (P12A analytics plugin).`,
  },
  opts,
);

const loggingSink = new gcp.logging.ProjectSink(
  `${namePrefix}-edge-log-sink`,
  {
    name: `${namePrefix}-edge-log-sink`,
    destination: pulumi.interpolate`bigquery.googleapis.com/projects/${project}/datasets/${edgeLogDataset.datasetId}`,
    // Capture all gateway request logs + admin warnings/errors.
    filter: pulumi.interpolate`(resource.type="cloud_run_revision" AND resource.labels.service_name="${gatewaySvc.name}") OR (resource.type="cloud_run_revision" AND resource.labels.service_name="${adminSvc.name}" AND severity>=WARNING)`,
    uniqueWriterIdentity: true,
  },
  opts,
);

new gcp.bigquery.DatasetIamMember(
  `${namePrefix}-edge-log-sink-bq-perms`,
  {
    datasetId: edgeLogDataset.datasetId,
    role: "roles/bigquery.dataEditor",
    member: loggingSink.writerIdentity,
  },
  opts,
);

// =========================================================================
// Bootstrap token + outputs
// =========================================================================

const tokenInfo = generateBootstrapToken();

const dnsRecordsRequired: pulumi.Output<DnsRecord[]> = lbIp.address.apply((ip) => [
  {
    hostname: domain,
    type: "A",
    value: ip,
    purpose: "Public docs site → static GCS via Cloud CDN (Tier 1 LB backend)",
  },
  {
    hostname: adminDomain,
    type: "A",
    value: ip,
    purpose: "Admin app → Cloud Run via LB (Tier 2, IAP-gated by allowlist)",
  },
]);

const out: CloudAdapterOutputs = {
  adminDatabaseUrl: adminDatabaseUrl as unknown as string,
  publicDatabaseUrl: publicDatabaseUrl as unknown as string,
  mediaStorageUrl: pulumi.interpolate`gs://${mediaBucket.name}` as unknown as string,
  mediaCdnBaseUrl: pulumi.interpolate`https://${domain}/media` as unknown as string,
  bootstrapUrl:
    pulumi.interpolate`https://${adminDomain}/setup?token=${tokenInfo.token}` as unknown as string,
  dnsRecordsRequired: dnsRecordsRequired as unknown as DnsRecord[],
  edgeLogSinkUrl:
    pulumi.interpolate`bigquery://${project}/${edgeLogDataset.datasetId}` as unknown as string,
  provider: "gcp",
  environment: env,
};

export const adminDatabaseUrlOut = out.adminDatabaseUrl;
export const publicDatabaseUrlOut = out.publicDatabaseUrl;
export const mediaStorageUrlOut = out.mediaStorageUrl;
export const mediaCdnBaseUrlOut = out.mediaCdnBaseUrl;
export const bootstrapUrlOut = out.bootstrapUrl;
export const dnsRecordsRequiredOut = out.dnsRecordsRequired;
export const edgeLogSinkUrlOut = out.edgeLogSinkUrl;
export const providerOut = out.provider;
export const environmentOut = out.environment;
export const cloudSqlConnectionNameOut = sqlInstance.connectionName;
export const cloudSqlPrivateIpOut = sqlInstance.privateIpAddress;
export const adminCloudRunUrlOut = adminSvc.uri;
export const gatewayCloudRunUrlOut = gatewaySvc.uri;
export const lbIpOut = lbIp.address;
export const adminDomainOut = adminDomain;
export const bootstrapTokenExpiresAtOut = tokenInfo.expiresAt;
export const staticPublisherSaEmailOut = staticPublisherSa.email;
export const staticBucketNameOut = staticBucket.name;
// P15 self-hosted CDN-copy adapter ABI — kept for cross-stack compat.
export const selfHostedCdnCopy = { pin: {}, unpin: {} };
