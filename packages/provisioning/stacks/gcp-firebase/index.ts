// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo GCP Firebase Hosting stack (v0.3.0).
 *
 * Architecture (differs from `gcp/` stack):
 *   - Static site:  Firebase Hosting site (no LB, no BackendBucket)
 *   - Admin:        Cloud Run + custom domain mapping (admin.<domain>)
 *                   + IAP-on-Cloud-Run (no LB IAP)
 *   - Gateway:      Cloud Run + Firebase Hosting `rewrites` (no LB,
 *                   no Cloud Armor)
 *   - Database:     Cloud SQL Postgres on private VPC IP only (same
 *                   as `gcp/`)
 *   - Workers:      share admin Cloud Run (same as `gcp/`)
 *
 * The trade-off (no Cloud Armor on the gateway) was explicitly
 * accepted by the operator. Mitigation: Firebase Edge DDoS shield,
 * Cloud Run max-instance caps, Caelo's in-app rate-limit
 * middleware, form CAPTCHA/PoW.
 *
 * Code structure mirrors `packages/provisioning/stacks/gcp/index.ts`
 * for the shared blocks (VPC, Secrets, Cloud SQL, run SA, Cloud Run
 * services); the divergent blocks (Firebase Hosting site, Cloud Run
 * domain mapping, Cloud Run IAP) live at the bottom of this file.
 * Shared code lives in `packages/provisioning/src/` (imported here).
 */

import * as command from "@pulumi/command";
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type { CloudAdapterOutputs, DnsRecord } from "../../dist/adapter.js";
import { generateBootstrapToken } from "../../dist/bootstrap-token.js";

const cfg = new pulumi.Config();
const domain = cfg.require("domain");
const ownerEmail = cfg.require("ownerEmail");
const project = cfg.require("project");
const region = cfg.get("region") ?? "us-central1";

// === Operator-tunable knobs ===
const cloudSqlTier = cfg.get("cloudSqlTier") ?? "db-f1-micro";
const cloudSqlHa = cfg.getBoolean("cloudSqlHa") ?? false;
const cloudSqlEdition = cfg.get("cloudSqlEdition") ?? "ENTERPRISE";
const deletionProtection = cfg.getBoolean("deletionProtection") ?? false;
const adminMinInstances = Number.parseInt(cfg.get("adminMinInstances") ?? "0", 10);
const adminMaxInstances = Number.parseInt(cfg.get("adminMaxInstances") ?? "5", 10);
const gatewayMinInstances = Number.parseInt(cfg.get("gatewayMinInstances") ?? "0", 10);
const maxConnections = Number.parseInt(cfg.get("maxConnections") ?? "100", 10);
const backupRetentionDays = Number.parseInt(cfg.get("backupRetentionDays") ?? "7", 10);
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
// Firebase site IDs are GLOBALLY unique across all Firebase projects —
// and reserved for ~30 days even after the parent project is deleted.
// A fixed default like `caelo-production-site` collides on re-install
// or after a failed run against a soft-deleted project. The suffix is
// a `random.RandomId` so it persists in Pulumi state across `up` runs
// but stays unique across installs. Operator override stays available
// for branded URLs (e.g. `cms.example.com` → `cms-example-com`).
const firebaseSiteSuffix = new random.RandomId(`${namePrefix}-firebase-site-suffix`, {
  byteLength: 3, // 6 hex chars — `caelo-production-site-abc123`
});
const firebaseSiteIdOverride = cfg.get("firebaseSiteId");
const firebaseSiteId: pulumi.Input<string> = firebaseSiteIdOverride
  ? firebaseSiteIdOverride
  : pulumi.interpolate`${namePrefix}-site-${firebaseSiteSuffix.hex}`;

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
// Secret Manager — random.RandomBytes for stable values across `pulumi up`
// (v0.2.81 fix: pre-v0.2.81 every up rotated secrets, breaking the KEK).
// =========================================================================

const pgPasswordBytes = new random.RandomBytes(`${namePrefix}-pg-password-bytes`, { length: 32 });
const csrfSecretBytes = new random.RandomBytes(`${namePrefix}-csrf-secret-bytes`, { length: 32 });
const cookieSecretBytes = new random.RandomBytes(`${namePrefix}-cookie-secret-bytes`, {
  length: 32,
});
const kekBytes = new random.RandomBytes(`${namePrefix}-secret-kek-bytes`, { length: 32 });

const postgresPassword = pulumi.secret(pgPasswordBytes.hex);
const csrfSecret = pulumi.secret(csrfSecretBytes.hex);
const cookieSecret = pulumi.secret(cookieSecretBytes.hex);
const caeloSecretKek = pulumi.secret(kekBytes.hex);
// v0.3.2 — anthropic-api-key Secret + Pulumi config dropped. The
// runtime AI provider configuration lives at /security/ai (key
// encrypted under the project KEK + stored in ai_providers).
// Pre-v0.3.2 the wizard prompted for a key + Pulumi provisioned a
// Secret + SecretVersion, but the Cloud Run service never read it
// (no env-var mount existed). Dead code path removed.
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
  if (value === null) return { resource, version: null };
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
const resendSecretRes = makeSecret("resend-api-key", resendApiKeyConfig ?? null);

// =========================================================================
// Tier 4 — Cloud SQL Postgres (private IP only; HA configurable)
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
        startTime: "03:00",
        backupRetentionSettings: { retainedBackups: backupRetentionDays },
        pointInTimeRecoveryEnabled: true,
        transactionLogRetentionDays: 7,
      },
      ipConfiguration: {
        ipv4Enabled: false,
        privateNetwork: network.id,
        enablePrivatePathForGoogleCloudServices: true,
      },
      databaseFlags: [{ name: "max_connections", value: maxConnections.toString() }],
    },
    deletionProtection,
  },
  { ...opts, dependsOn: [sqlPeering] },
);

const cmsAdminDb = new gcp.sql.Database(
  `${namePrefix}-cms-admin`,
  { instance: sqlInstance.name, name: "cms_admin" },
  opts,
);
const cmsPublicDb = new gcp.sql.Database(
  `${namePrefix}-cms-public`,
  { instance: sqlInstance.name, name: "cms_public" },
  opts,
);

const pgAdminUser = new gcp.sql.User(
  `${namePrefix}-admin-user`,
  { instance: sqlInstance.name, name: "admin_role", password: postgresPassword },
  opts,
);
new gcp.sql.User(
  `${namePrefix}-public-user`,
  { instance: sqlInstance.name, name: "public_role", password: postgresPassword },
  opts,
);

const adminDatabaseUrl = pulumi.interpolate`postgres://admin_role:${postgresPassword}@${sqlInstance.privateIpAddress}:5432/cms_admin?sslmode=require`;
const publicAdminDatabaseUrl = pulumi.interpolate`postgres://admin_role:${postgresPassword}@${sqlInstance.privateIpAddress}:5432/cms_public?sslmode=require`;
const publicDatabaseUrl = pulumi.interpolate`postgres://public_role:${postgresPassword}@${sqlInstance.privateIpAddress}:5432/cms_public?sslmode=require`;

// =========================================================================
// Media bucket — private, signed-URL access only (same as `gcp` stack)
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

// =========================================================================
// Cloud Run service account + IAM roles
// =========================================================================

const runSa = new gcp.serviceaccount.Account(
  `${namePrefix}-run-sa`,
  {
    accountId: `${namePrefix}-run-sa`,
    displayName: `Caelo ${env} Cloud Run service account`,
  },
  opts,
);

for (const made of [
  { name: "postgres-password", made: pgSecret },
  { name: "csrf-secret", made: csrfSecretRes },
  { name: "cookie-secret", made: cookieSecretRes },
  { name: "secret-kek", made: kekSecret },
  { name: "resend-api-key", made: resendSecretRes },
]) {
  new gcp.secretmanager.SecretIamMember(
    `${namePrefix}-${made.name}-binding`,
    {
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

// v0.3.0 — Firebase Hosting admin role for the static-publisher path.
// The admin Cloud Run service calls the Firebase Hosting REST API to
// create versions, populateFiles, finalize, and create channels.
new gcp.projects.IAMMember(
  `${namePrefix}-run-firebase-hosting`,
  {
    project,
    role: "roles/firebasehosting.admin",
    member: pulumi.interpolate`serviceAccount:${runSa.email}`,
  },
  opts,
);

// =========================================================================
// Tier 1 — Firebase Hosting site
// =========================================================================

// v0.3.6 — initialize Firebase services on the GCP project. A
// project with `firebase.googleapis.com` enabled is NOT
// automatically a Firebase project — Firebase needs an explicit
// `addFirebase` API call (via gcp.firebase.Project) before
// HostingSite can be created. Without this v0.3.5 hit "Error 403:
// The caller does not have permission" on HostingSite create.
const firebaseProject = new gcp.firebase.Project(
  `${namePrefix}-firebase-project`,
  { project },
  opts,
);

const firebaseSite = new gcp.firebase.HostingSite(
  `${namePrefix}-firebase-site`,
  {
    project,
    siteId: firebaseSiteId,
  },
  { ...opts, dependsOn: [firebaseProject] },
);

// Custom domain on the Firebase site for the apex. The operator wires
// DNS by following the records printed in the stack outputs.
const firebaseCustomDomain = new gcp.firebase.HostingCustomDomain(
  `${namePrefix}-firebase-apex`,
  {
    project,
    // Use the input string (known at config time) instead of the
    // resource's siteId output — the typed output is
    // `Output<string | undefined>` but Input<string> doesn't accept
    // undefined.
    siteId: firebaseSiteId,
    customDomain: domain,
    waitDnsVerification: false,
  },
  { ...opts, dependsOn: [firebaseSite] },
);

// =========================================================================
// Cloud Run services — admin + gateway
// =========================================================================

interface CloudRunArgs {
  readonly serviceName: string;
  readonly minInstances: number;
  readonly maxInstances: number;
  readonly memory: string;
  readonly timeout: string;
  readonly extraEnv?: ReadonlyArray<{ name: string; value: pulumi.Input<string> }>;
  /** v0.3.1 — admin: ALL (so IAP gates internet traffic). gateway:
   *  INTERNAL_LOAD_BALANCER (locked down; only Firebase Hosting
   *  rewrites + run.invoker-authorised callers can reach it). */
  readonly ingress: "INGRESS_TRAFFIC_ALL" | "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER";
  /** v0.3.1 — set true on admin so Cloud Run IAP gates traffic. */
  readonly iapEnabled?: boolean;
}

function cloudRunService(args: CloudRunArgs): gcp.cloudrunv2.Service {
  return new gcp.cloudrunv2.Service(
    `${namePrefix}-${args.serviceName}`,
    {
      location: region,
      ingress: args.ingress,
      // v0.3.1 — Cloud Run native IAP. With this on, every request
      // is gated by IAP before the container sees it. Allowlisted
      // users get through via the IAM bindings further below;
      // others get a 403 from IAP's login challenge.
      iapEnabled: args.iapEnabled ?? false,
      deletionProtection,
      template: {
        serviceAccount: runSa.email,
        scaling: {
          minInstanceCount: args.minInstances,
          maxInstanceCount: args.maxInstances,
        },
        timeout: args.timeout,
        containers: [
          {
            image: `europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/${args.serviceName}:main`,
            envs: [
              { name: "CAELO_PROVIDER", value: "gcp-firebase" },
              { name: "CAELO_ENV", value: env },
              { name: "ADMIN_DATABASE_URL", value: adminDatabaseUrl },
              { name: "MEDIA_STORAGE_URL", value: pulumi.interpolate`gs://${mediaBucket.name}` },
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
        ...(kekSecret.version ? [kekSecret.version] : []),
      ],
    },
  );
}

// Gateway provisioned first so we can pass its name/region into the
// admin's env (the Firebase publisher needs them to wire rewrites).
const gatewaySvc = cloudRunService({
  serviceName: "gateway",
  minInstances: gatewayMinInstances,
  maxInstances: 100,
  memory: "512Mi",
  timeout: "60s",
  // v0.3.1 — gateway is reachable ONLY via Firebase Hosting
  // rewrites or any caller holding roles/run.invoker on the
  // service. Anonymous internet traffic gets a Cloud Run 403.
  ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
  extraEnv: [{ name: "PUBLIC_DATABASE_URL", value: publicDatabaseUrl }],
});

const adminSvc = cloudRunService({
  serviceName: "admin",
  minInstances: adminMinInstances,
  maxInstances: adminMaxInstances,
  memory: "1Gi",
  timeout: "3600s",
  // v0.3.1 — admin is internet-reachable but gated by Cloud Run
  // native IAP. iapEnabled flips the IAP integration on the service.
  ingress: "INGRESS_TRAFFIC_ALL",
  iapEnabled: true,
  extraEnv: [
    { name: "PUBLIC_ADMIN_DATABASE_URL", value: publicAdminDatabaseUrl },
    // Use the input string (known at config time) — resource output
    // is Output<string | undefined> which Input<string> rejects.
    { name: "CAELO_FIREBASE_SITE", value: firebaseSiteId },
    { name: "CAELO_GENERATOR_CLI", value: "/app/apps/static-generator/src/cli.ts" },
    // v0.3.1 — Firebase publisher needs the gateway service name +
    // region to declare the /api/** rewrite when creating each
    // version.
    { name: "CAELO_GATEWAY_SERVICE", value: gatewaySvc.name },
    { name: "CAELO_GATEWAY_REGION", value: region },
  ],
});

// =========================================================================
// Gateway — Firebase Hosting service identity gets run.invoker
// =========================================================================

// v0.3.1 — Firebase Hosting uses a Google-managed service identity
// to proxy traffic via `rewrites` to Cloud Run. Grant it
// `roles/run.invoker` on the gateway so /api/** requests succeed.
//
// v0.3.10 — `gcp.projects.ServiceIdentity` is NOT supported for
// `firebasehosting.googleapis.com` (the GenerateServiceIdentity API
// returns IAM_SERVICE_NOT_CONFIGURED_FOR_IDENTITIES for it). The
// `gcloud beta services identity create` CLI command works where
// the GenerateServiceIdentity API does not — it falls back to a
// different bootstrap path. We shell out via @pulumi/command,
// which is idempotent (gcloud returns existing if the SA is
// already provisioned). The SA email is deterministic from the
// project number, so we construct it independently.
const firebaseHostingIdentityCmd = new command.local.Command(
  `${namePrefix}-firebasehosting-identity`,
  {
    create: pulumi.interpolate`gcloud beta services identity create --service=firebasehosting.googleapis.com --project=${project} --quiet`,
  },
  opts,
);

const projectInfo = gcp.organizations.getProjectOutput({ projectId: project }, opts);
const firebaseHostingSa = pulumi.interpolate`serviceAccount:service-${projectInfo.number}@gcp-sa-firebasehosting.iam.gserviceaccount.com`;

new gcp.cloudrun.IamMember(
  `${namePrefix}-gateway-firebase-invoker`,
  {
    location: region,
    project,
    service: gatewaySvc.name,
    role: "roles/run.invoker",
    member: firebaseHostingSa,
  },
  { ...opts, dependsOn: [firebaseHostingIdentityCmd] },
);

// =========================================================================
// Admin custom domain — Cloud Run domain mapping
// =========================================================================
//
// v0.3.10 — Cloud Run DomainMapping requires the operator to verify
// domain ownership in Google Search Console FIRST. Without that
// verification the create fails with "Caller is not authorized to
// administer the domain ..." even when the provisioner SA has full
// admin rights on the project. This is a one-time manual step we
// cannot automate.
//
// To keep the install working out of the box, the DomainMapping is
// opt-in via `provisionAdminDomain=true`. When disabled (default),
// the operator reaches the admin via the Cloud Run-generated URL
// (`https://<admin-svc>-<hash>-<region>.a.run.app`). They can flip
// the knob + verify the domain at https://search.google.com/search-console
// later and run `pulumi up` to bind admin.<domain> → Cloud Run.
const provisionAdminDomain = cfg.getBoolean("provisionAdminDomain") ?? false;
const adminDomainMapping = provisionAdminDomain
  ? new gcp.cloudrun.DomainMapping(
      `${namePrefix}-admin-domain`,
      {
        location: region,
        name: adminDomain,
        metadata: { namespace: project },
        spec: {
          routeName: adminSvc.name,
        },
      },
      { ...opts, dependsOn: [adminSvc] },
    )
  : undefined;

// =========================================================================
// IAP on the admin Cloud Run service (no LB)
// =========================================================================

// Cloud Run native IAP: per-allowlist-entry IAM binding on the admin
// service grants `roles/iap.httpsResourceAccessor`. The actual "IAP
// enabled" flag on Cloud Run is set via `iapEnabled` (gen2) which
// gates every request through IAP before the container sees it.
// Allowlisted users get to the container; everyone else gets 403.
//
// NOTE — Cloud Run native IAP support is GA but the Pulumi resource
// surface for the `iapEnabled` flag depends on the @pulumi/gcp version
// shipped. If your provider build is older than v8.x, run
// `gcloud beta run services update <admin-service> --iap` as a
// post-up step. The stack provisions the IAM bindings either way.
// v0.3.10 — Cloud Run v1 IAM API (`gcp.cloudrun.IamMember`) rejects
// `roles/iap.httpsResourceAccessor` with "Role is not supported for
// this resource". The v2 IAM API (`gcp.cloudrunv2.ServiceIamMember`)
// is the right binding for native-IAP-on-Cloud-Run, matching
// Google's documented setup: `gcloud run services
// add-iam-policy-binding ... --role=roles/iap.httpsResourceAccessor`.
for (const principal of iapAllowlist) {
  new gcp.cloudrunv2.ServiceIamMember(
    `${namePrefix}-admin-iap-${principal.replace(/[^a-z0-9]/gi, "-").slice(0, 40)}`,
    {
      location: region,
      project,
      name: adminSvc.name,
      role: "roles/iap.httpsResourceAccessor",
      member: principal,
    },
    opts,
  );
}

// =========================================================================
// Outputs — DNS records the operator wires manually
// =========================================================================

const adminMappingStatuses: pulumi.Output<gcp.types.output.cloudrun.DomainMappingStatus[] | undefined> =
  adminDomainMapping
    ? adminDomainMapping.statuses
    : (pulumi.output(undefined) as pulumi.Output<gcp.types.output.cloudrun.DomainMappingStatus[] | undefined>);

const dnsRecords: pulumi.Output<DnsRecord[]> = pulumi
  .all([adminMappingStatuses, firebaseCustomDomain.requiredDnsUpdates])
  .apply(([adminStatuses, firebaseUpdates]) => {
    const out: DnsRecord[] = [];

    // Admin subdomain — Cloud Run domain mapping prints CNAMEs/As.
    // When `provisionAdminDomain=false`, no mapping exists and the
    // operator reaches admin via the *.run.app URL printed separately.
    const adminTargets =
      adminStatuses
        ?.flatMap((s) => s.resourceRecords ?? [])
        .map((r) => ({ type: r.type ?? "CNAME", value: r.rrdata ?? "" })) ?? [];
    for (const t of adminTargets) {
      out.push({
        hostname: adminDomain,
        type: t.type as DnsRecord["type"],
        value: t.value,
        purpose: "Admin app → Cloud Run direct (gen2 IAP-gated)",
      });
    }

    // Apex — Firebase Hosting custom-domain DNS instructions.
    // firebaseCustomDomain.requiredDnsUpdates is an array of update
    // groups; each group has a list of `desired` records the operator
    // creates and `discovered` records currently in DNS. We surface the
    // `desired` set so the operator knows what to put in the registrar.
    const apex = firebaseUpdates?.[0];
    if (apex) {
      for (const desired of apex.desireds ?? []) {
        for (const v of desired.records ?? []) {
          out.push({
            hostname: domain,
            type: (v.type ?? "A") as DnsRecord["type"],
            value: v.rdata ?? "",
            purpose: "Public site → Firebase Hosting CDN",
          });
        }
      }
    }
    return out;
  });

const tokenInfo = generateBootstrapToken();

// Cast pulumi.Output<string> values to plain `string` to satisfy the
// shared CloudAdapterOutputs shape. Pulumi serialises Outputs to
// plain strings in stack outputs at runtime; the cast bridges the
// build-time type. Same pattern as packages/provisioning/stacks/gcp/index.ts.
const out: CloudAdapterOutputs = {
  adminDatabaseUrl: adminDatabaseUrl as unknown as string,
  publicDatabaseUrl: publicDatabaseUrl as unknown as string,
  mediaStorageUrl: pulumi.interpolate`gs://${mediaBucket.name}` as unknown as string,
  // Firebase Hosting serves media via its own CDN; we proxy through
  // the Firebase site's apex domain for canonical URLs.
  mediaCdnBaseUrl: `https://${domain}/media` as unknown as string,
  bootstrapUrl:
    pulumi.interpolate`https://${adminDomain}/setup?token=${tokenInfo.token}` as unknown as string,
  dnsRecordsRequired: dnsRecords as unknown as DnsRecord[],
  // gcp-firebase doesn't provision BigQuery sinks today (no LB → no
  // edge log stream). v0.3.x+ adds a Firebase Hosting log export.
  edgeLogSinkUrl: `bigquery://${project}/firebase_logs` as unknown as string,
  provider: "gcp-firebase",
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
export const adminCloudRunUrlOut = adminSvc.uri;
export const gatewayCloudRunUrlOut = gatewaySvc.uri;
export const adminDomainOut = adminDomain;
export const firebaseSiteIdOut = firebaseSiteId;
export const bootstrapTokenExpiresAtOut = tokenInfo.expiresAt;
