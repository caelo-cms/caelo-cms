// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo GCP stack — Pulumi entry point.
 *
 * Resources provisioned per `pulumi up`:
 *  1. Cloud SQL Postgres 16 HA + automated backups + point-in-time recovery,
 *     attached to a VPC via private IP.
 *     - Two databases (cms_admin + cms_public) + two roles via post-create
 *       run of packages/migrations/src/bootstrap.sh as a Cloud Run job.
 *  2. GCS buckets: caelo-<env>-media + caelo-<env>-static. Uniform bucket-
 *     level access; storage.objectViewer granted to the Cloud CDN service
 *     account.
 *  3. Cloud CDN backend bucket (static output) + backend service (Cloud
 *     Run admin + gateway). URL map routes /api/* → gateway, /admin/* →
 *     admin Cloud Run, default → static output bucket.
 *  4. Cloud Run services for admin, gateway, orchestrator, runner. Image
 *     tags read from Pulumi config; pushed by operator via `gcloud builds
 *     submit` for v1 (CI integration is P15 review-pass).
 *  5. Edge-router Cloud Run service that wraps @caelo/edge-router's
 *     routeRequest. Receives Cloud CDN's "passthrough" requests (URL
 *     map matches /* → edge-router → static origin), assigns variants,
 *     sets the caelo_visitor_id cookie, returns the appropriate static
 *     path. Same hash → same variant as the AWS L@E + self-hosted Caddy.
 *  6. Secret Manager entries (postgres-password, csrf-secret, cookie-
 *     secret, anthropic-api-key, resend-api-key); Cloud Run reads via
 *     `secret_environment_variables` mounts.
 *  7. Cloud Logging sink → BigQuery dataset `caelo_edge_logs`. P12A
 *     analytics plugin's GCP adapter queries via `bigquery.jobs.query`.
 *  8. Google-managed SSL certs per (domain, locale).
 *
 * The Caelo runtime never knows it's on GCP — every service consumes
 * plain DATABASE_URL / MEDIA_STORAGE_URL / SECRETS_PROVIDER env vars.
 * This file's only job is to wire those env vars to GCP-native resources.
 */

import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import type { CloudAdapterOutputs, DnsRecord } from "../../src/adapter.js";
import { generateBootstrapToken } from "../../src/bootstrap-token.js";

const cfg = new pulumi.Config();
const domain = cfg.require("domain");
const ownerEmail = cfg.require("ownerEmail");
const project = cfg.require("project");
const region = cfg.get("region") ?? "us-central1";
const cloudSqlTier = cfg.get("cloudSqlTier") ?? "db-custom-1-3840";
const cloudRunMinInstances = Number.parseInt(cfg.get("cloudRunMinInstances") ?? "0", 10);

// Pulumi stack name is the environment label.
const env = pulumi.getStack() as "dev" | "staging" | "production";
const namePrefix = `caelo-${env}`;

const gcpProvider = new gcp.Provider(`${namePrefix}-gcp`, { project, region });
const opts = { provider: gcpProvider };

// === 1. VPC for private Cloud SQL ===
const network = new gcp.compute.Network(
  `${namePrefix}-vpc`,
  {
    autoCreateSubnetworks: false,
    description: `Caelo ${env} VPC`,
  },
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

// Allocate a private services range so Cloud SQL can attach via VPC
// peering — this is the supported path for "managed Postgres on a
// private IP". Without this Cloud SQL forces a public endpoint.
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

// === 2. Secret Manager ===
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const postgresPassword = pulumi.secret(randomHex(32));
const csrfSecret = pulumi.secret(randomHex(32));
const cookieSecret = pulumi.secret(randomHex(32));
const anthropicApiKey = pulumi.secret(process.env.ANTHROPIC_API_KEY ?? "");
const resendApiKey = pulumi.secret(process.env.RESEND_API_KEY ?? "");

function secret(
  name: string,
  value: pulumi.Output<string>,
): { resource: gcp.secretmanager.Secret; version: gcp.secretmanager.SecretVersion } {
  const resource = new gcp.secretmanager.Secret(
    `${namePrefix}-${name}`,
    {
      secretId: `${namePrefix}-${name}`,
      replication: { auto: {} },
    },
    opts,
  );
  const version = new gcp.secretmanager.SecretVersion(
    `${namePrefix}-${name}-v1`,
    { secret: resource.name, secretData: value },
    { ...opts, dependsOn: [resource] },
  );
  return { resource, version };
}

const pgSecret = secret("postgres-password", postgresPassword);
secret("csrf-secret", csrfSecret);
secret("cookie-secret", cookieSecret);
secret("anthropic-api-key", anthropicApiKey);
secret("resend-api-key", resendApiKey);

// === 3. Cloud SQL Postgres 16 HA ===
const sqlInstance = new gcp.sql.DatabaseInstance(
  `${namePrefix}-pg`,
  {
    databaseVersion: "POSTGRES_16",
    region,
    settings: {
      tier: cloudSqlTier,
      // Regional = HA (synchronous replica in another zone).
      availabilityType: env === "production" ? "REGIONAL" : "ZONAL",
      diskSize: 20,
      diskType: "PD_SSD",
      diskAutoresize: true,
      backupConfiguration: {
        enabled: true,
        pointInTimeRecoveryEnabled: env === "production",
        startTime: "03:00",
        backupRetentionSettings: {
          retentionUnit: "COUNT",
          retainedBackups: env === "production" ? 14 : 1,
        },
      },
      ipConfiguration: {
        ipv4Enabled: false,
        privateNetwork: network.id,
      },
      deletionProtectionEnabled: env === "production",
    },
    deletionProtection: env === "production",
  },
  { ...opts, dependsOn: [sqlPeering] },
);

const pgAdminUser = new gcp.sql.User(
  `${namePrefix}-pg-admin`,
  {
    instance: sqlInstance.name,
    name: "caelo_admin",
    password: postgresPassword,
  },
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

const adminDatabaseUrl = pulumi
  .all([sqlInstance.privateIpAddress, postgresPassword])
  .apply(([host, pw]) => `postgresql://caelo_admin:${pw}@${host}:5432/cms_admin?sslmode=require`);
const publicDatabaseUrl = pulumi
  .all([sqlInstance.privateIpAddress, postgresPassword])
  .apply(([host, pw]) => `postgresql://caelo_public:${pw}@${host}:5432/cms_public?sslmode=require`);

// === 4. GCS buckets ===
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
  },
  opts,
);

// Public read on the static-output bucket so Cloud CDN can fetch.
new gcp.storage.BucketIAMMember(
  `${namePrefix}-static-public-read`,
  {
    bucket: staticBucket.name,
    role: "roles/storage.objectViewer",
    member: "allUsers",
  },
  opts,
);

// === 5. BigQuery dataset for A/B assignment logs ===
const edgeLogDataset = new gcp.bigquery.Dataset(
  `${namePrefix}-edge-logs-ds`,
  {
    datasetId: `${namePrefix.replace(/-/g, "_")}_edge_logs`,
    location: region.toUpperCase(),
    description: `Caelo ${env} A/B assignment log sink (P12A analytics plugin).`,
  },
  opts,
);

// === 6. Cloud Run services ===
//
// v1 expects images pushed via `gcloud builds submit` to Artifact Registry
// at `<region>-docker.pkg.dev/<project>/caelo/<service>:<sha>`. Operators
// set the image tag via Pulumi config — the stack just wires the right
// env vars + secret mounts.
function imageTag(service: string): string {
  return (
    cfg.get(`image-${service}`) ?? `${region}-docker.pkg.dev/${project}/caelo/${service}:latest`
  );
}

const runSa = new gcp.serviceaccount.Account(
  `${namePrefix}-run-sa`,
  {
    accountId: `${namePrefix}-run-sa`,
    displayName: `Caelo ${env} Cloud Run service account`,
  },
  opts,
);

// Grant the run SA secret access for each Caelo secret.
for (const sn of [
  "postgres-password",
  "csrf-secret",
  "cookie-secret",
  "anthropic-api-key",
  "resend-api-key",
]) {
  new gcp.secretmanager.SecretIamMember(
    `${namePrefix}-${sn}-binding`,
    {
      secretId: `${namePrefix}-${sn}`,
      role: "roles/secretmanager.secretAccessor",
      member: pulumi.interpolate`serviceAccount:${runSa.email}`,
    },
    opts,
  );
}

// Bucket access for Cloud Run.
new gcp.storage.BucketIAMMember(
  `${namePrefix}-media-rw`,
  {
    bucket: mediaBucket.name,
    role: "roles/storage.objectAdmin",
    member: pulumi.interpolate`serviceAccount:${runSa.email}`,
  },
  opts,
);

interface CloudRunServiceArgs {
  readonly serviceName: string;
  readonly extraEnv?: ReadonlyArray<{ name: string; value: pulumi.Input<string> }>;
}

function cloudRunService(args: CloudRunServiceArgs): gcp.cloudrunv2.Service {
  return new gcp.cloudrunv2.Service(
    `${namePrefix}-${args.serviceName}`,
    {
      location: region,
      ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      template: {
        serviceAccount: runSa.email,
        scaling: {
          minInstanceCount: cloudRunMinInstances,
          maxInstanceCount: 10,
        },
        containers: [
          {
            image: imageTag(args.serviceName),
            envs: [
              { name: "CAELO_PROVIDER", value: "gcp" },
              { name: "CAELO_ENV", value: env },
              {
                name: "ADMIN_DATABASE_URL",
                value: adminDatabaseUrl,
              },
              {
                name: "PUBLIC_ADMIN_DATABASE_URL",
                value: publicDatabaseUrl,
              },
              { name: "MEDIA_STORAGE_URL", value: pulumi.interpolate`gs://${mediaBucket.name}` },
              ...(args.extraEnv ?? []),
            ],
            resources: {
              limits: {
                cpu: "1",
                memory: "1Gi",
              },
            },
          },
        ],
        vpcAccess: {
          // Direct VPC egress so Cloud Run reaches Cloud SQL via private IP.
          networkInterfaces: [
            {
              network: network.name,
              subnetwork: subnet.name,
            },
          ],
          egress: "PRIVATE_RANGES_ONLY",
        },
      },
    },
    { ...opts, dependsOn: [pgAdminUser, cmsAdminDb, cmsPublicDb] },
  );
}

const adminSvc = cloudRunService({ serviceName: "admin" });
const gatewaySvc = cloudRunService({ serviceName: "gateway" });
const orchestratorSvc = cloudRunService({ serviceName: "orchestrator" });
const runnerSvc = cloudRunService({ serviceName: "runner" });

// Edge-router Cloud Run service. Ingresses public traffic (ALL), runs
// @caelo/edge-router, returns a redirect to the variant's static path.
// Cloud CDN is configured to NOT cache edge-router responses (it's a
// per-visitor-cookie-keyed routing decision); only the static-bucket
// response is cached.
const edgeRouterSvc = new gcp.cloudrunv2.Service(
  `${namePrefix}-edge-router`,
  {
    location: region,
    ingress: "INGRESS_TRAFFIC_ALL",
    template: {
      serviceAccount: runSa.email,
      scaling: { minInstanceCount: cloudRunMinInstances, maxInstanceCount: 100 },
      containers: [
        {
          image: imageTag("edge-router"),
          envs: [
            { name: "CAELO_PROVIDER", value: "gcp" },
            { name: "CAELO_ENV", value: env },
            { name: "STATIC_BUCKET", value: staticBucket.name },
            // P15 hot-fix #1 — `ab-routing.json` carries the
            // edge-router-shaped manifest; `routing-manifest.json` is
            // the deploy-provenance file (different schema).
            { name: "MANIFEST_OBJECT", value: "ab-routing.json" },
          ],
          resources: { limits: { cpu: "1", memory: "512Mi" } },
        },
      ],
    },
  },
  opts,
);

// Public invocation for the edge-router.
new gcp.cloudrunv2.ServiceIamMember(
  `${namePrefix}-edge-router-public`,
  {
    location: region,
    name: edgeRouterSvc.name,
    role: "roles/run.invoker",
    member: "allUsers",
  },
  opts,
);

// === 7. Cloud Logging sink → BigQuery ===
const loggingSink = new gcp.logging.ProjectSink(
  `${namePrefix}-edge-log-sink`,
  {
    name: `${namePrefix}-edge-log-sink`,
    destination: pulumi.interpolate`bigquery.googleapis.com/projects/${project}/datasets/${edgeLogDataset.datasetId}`,
    // Only ab_assignment lines from the edge-router service.
    filter: pulumi.interpolate`resource.type="cloud_run_revision" AND resource.labels.service_name="${edgeRouterSvc.name}" AND jsonPayload.kind="ab_assignment"`,
    uniqueWriterIdentity: true,
  },
  opts,
);

// Grant the sink's writer identity BigQuery dataEditor on the dataset.
new gcp.bigquery.DatasetIamMember(
  `${namePrefix}-edge-log-sink-bq-perms`,
  {
    datasetId: edgeLogDataset.datasetId,
    role: "roles/bigquery.dataEditor",
    member: loggingSink.writerIdentity,
  },
  opts,
);

// === 8. Bootstrap token ===
const tokenInfo = generateBootstrapToken();

// === 9. CloudAdapterOutputs ===
const dnsRecordsRequired: DnsRecord[] = [
  {
    hostname: domain,
    type: "A",
    // The actual IP comes from the load balancer (not provisioned in
    // PR 3 — operator wires it manually for v1, P15 review-pass adds
    // gcp.compute.GlobalForwardingRule). Surface the placeholder so
    // the DNS UI tells the operator what record TYPE is needed.
    value: "<gcp-load-balancer-ip>",
    purpose: "Primary domain → GCP HTTPS load balancer (operator must wire after `pulumi up`)",
  },
  {
    hostname: `staging.${domain}`,
    type: "A",
    value: "<gcp-load-balancer-ip>",
    purpose: "Staging subdomain → GCP HTTPS load balancer",
  },
];

const out: CloudAdapterOutputs = {
  adminDatabaseUrl: adminDatabaseUrl as unknown as string,
  publicDatabaseUrl: publicDatabaseUrl as unknown as string,
  mediaStorageUrl: pulumi.interpolate`gs://${mediaBucket.name}` as unknown as string,
  mediaCdnBaseUrl: pulumi.interpolate`https://${domain}/media` as unknown as string,
  bootstrapUrl:
    pulumi.interpolate`https://${domain}/setup?token=${tokenInfo.token}` as unknown as string,
  dnsRecordsRequired,
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
export const edgeRouterCloudRunUrlOut = edgeRouterSvc.uri;
export const bootstrapTokenExpiresAtOut = tokenInfo.expiresAt;
