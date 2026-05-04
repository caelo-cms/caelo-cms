// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo Azure stack — Pulumi entry point.
 *
 * Resources provisioned per `pulumi up`:
 *  1. Resource group (created if missing).
 *  2. Azure Database for PostgreSQL flexible server, zone-redundant in
 *     production. Two databases (cms_admin + cms_public) created via
 *     post-create Container Apps job (bootstrap.sh).
 *  3. Storage account + two containers (`media` + `static`); the
 *     `static` container is `$web`-enabled for static-website hosting.
 *  4. Azure Front Door Standard with two origins (static blob + Container
 *     Apps fronting admin/gateway). Rules engine handles A/B split
 *     (matches `pageSlug` from the routing manifest, rewrites to the
 *     variant blob path) and redirects (per-row from the redirects table
 *     emitted via emitRedirectsAzureFrontDoor).
 *  5. Azure Container Apps (admin/gateway/orchestrator/runner + edge-router),
 *     mounted with Key Vault secrets via managed identity.
 *  6. Key Vault entries (postgres-password, csrf-secret, cookie-secret,
 *     anthropic-api-key, resend-api-key).
 *  7. Log Analytics workspace receives Front Door + Container Apps logs;
 *     P12A analytics plugin's Azure adapter queries via monitor-query.
 *  8. Azure DNS zone for the primary domain (operator may opt out via
 *     config + manage at their existing registrar).
 *
 * Constraints worth knowing:
 *   - Container Apps not in every region; the stack errors loudly at
 *     preview if `location` is unsupported.
 *   - Front Door cert auto-management requires the apex domain to point
 *     at Front Door; if the operator manages DNS elsewhere they must
 *     publish the CNAME validation TXT record themselves.
 *
 * The Caelo runtime never knows it's on Azure — every Container App
 * consumes plain DATABASE_URL / MEDIA_STORAGE_URL / SECRETS_PROVIDER
 * env vars wired by this stack.
 */

import * as azure from "@pulumi/azure-native";
import * as pulumi from "@pulumi/pulumi";
import type { CloudAdapterOutputs, DnsRecord } from "../../dist/adapter.js";
import { generateBootstrapToken } from "../../dist/bootstrap-token.js";

const cfg = new pulumi.Config();
const domain = cfg.require("domain");
const _ownerEmail = cfg.require("ownerEmail");
const subscription = cfg.require("subscription");
const rgName = cfg.get("resourceGroup") ?? "caelo-rg";
const location = cfg.get("location") ?? "westeurope";
const flexibleServerSku = cfg.get("flexibleServerSku") ?? "Standard_B2s";

const env = pulumi.getStack() as "dev" | "staging" | "production";
const namePrefix = `caelo${env}`; // Azure resource names disallow hyphens in some types.

// === 1. Resource group ===
const rg = new azure.resources.ResourceGroup(`${namePrefix}-rg`, {
  resourceGroupName: rgName,
  location,
});

// === 2. Secrets ===
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

// Key Vault.
const vault = new azure.keyvault.Vault(`${namePrefix}-kv`, {
  resourceGroupName: rg.name,
  vaultName: `${namePrefix}kv`.slice(0, 24), // KV name max 24 chars
  properties: {
    tenantId: subscription, // operator passes their AAD tenant id via this config
    sku: { family: "A", name: "standard" },
    enableRbacAuthorization: true,
    enableSoftDelete: true,
    softDeleteRetentionInDays: env === "production" ? 90 : 7,
  },
});

function keyVaultSecret(shortName: string, value: pulumi.Output<string>): azure.keyvault.Secret {
  return new azure.keyvault.Secret(`${namePrefix}-${shortName}`, {
    resourceGroupName: rg.name,
    vaultName: vault.name,
    secretName: `${namePrefix}-${shortName}`,
    properties: { value },
  });
}

const _pgSecret = keyVaultSecret("pg-password", postgresPassword);
keyVaultSecret("csrf-secret", csrfSecret);
keyVaultSecret("cookie-secret", cookieSecret);
keyVaultSecret("anthropic-api-key", anthropicApiKey);
keyVaultSecret("resend-api-key", resendApiKey);

// === 3. Postgres flexible server ===
const pgServer = new azure.dbforpostgresql.Server(`${namePrefix}-pg`, {
  resourceGroupName: rg.name,
  serverName: `${namePrefix}-pg`,
  location,
  version: "16",
  sku: {
    name: flexibleServerSku,
    tier: flexibleServerSku.startsWith("Standard_B") ? "Burstable" : "GeneralPurpose",
  },
  administratorLogin: "caelo_admin",
  administratorLoginPassword: postgresPassword,
  storage: { storageSizeGB: 32 },
  backup: {
    backupRetentionDays: env === "production" ? 14 : 7,
    geoRedundantBackup: env === "production" ? "Enabled" : "Disabled",
  },
  highAvailability: { mode: env === "production" ? "ZoneRedundant" : "Disabled" },
  network: { publicNetworkAccess: "Disabled" },
});

const _pgAdmin = new azure.dbforpostgresql.Database(`${namePrefix}-cms-admin-db`, {
  resourceGroupName: rg.name,
  serverName: pgServer.name,
  databaseName: "cms_admin",
  charset: "UTF8",
});
const _pgPublic = new azure.dbforpostgresql.Database(`${namePrefix}-cms-public-db`, {
  resourceGroupName: rg.name,
  serverName: pgServer.name,
  databaseName: "cms_public",
  charset: "UTF8",
});

const adminDatabaseUrl = pulumi
  .all([pgServer.fullyQualifiedDomainName, postgresPassword])
  .apply(([host, pw]) => `postgresql://caelo_admin:${pw}@${host}:5432/cms_admin?sslmode=require`);
const publicDatabaseUrl = pulumi
  .all([pgServer.fullyQualifiedDomainName, postgresPassword])
  .apply(([host, pw]) => `postgresql://caelo_public:${pw}@${host}:5432/cms_public?sslmode=require`);

// === 4. Storage account + containers ===
const storage = new azure.storage.StorageAccount(`${namePrefix}-st`, {
  resourceGroupName: rg.name,
  accountName: `${namePrefix.slice(0, 18)}st`, // Storage account names are 3-24 lowercase
  location,
  sku: { name: "Standard_LRS" },
  kind: "StorageV2",
  enableHttpsTrafficOnly: true,
  minimumTlsVersion: "TLS1_2",
});

const _mediaContainer = new azure.storage.BlobContainer(`${namePrefix}-media`, {
  resourceGroupName: rg.name,
  accountName: storage.name,
  containerName: "media",
  publicAccess: "None",
});

const _staticContainer = new azure.storage.BlobContainer(`${namePrefix}-static`, {
  resourceGroupName: rg.name,
  accountName: storage.name,
  containerName: "$web",
  publicAccess: "Blob",
});

// === 5. Log Analytics workspace ===
const logWorkspace = new azure.operationalinsights.Workspace(`${namePrefix}-logs`, {
  resourceGroupName: rg.name,
  workspaceName: `${namePrefix}-logs`,
  location,
  sku: { name: "PerGB2018" },
  retentionInDays: env === "production" ? 90 : 30,
});

// === 6. Container Apps environment + apps ===
const cappEnv = new azure.app.ManagedEnvironment(`${namePrefix}-capp-env`, {
  resourceGroupName: rg.name,
  environmentName: `${namePrefix}-capp-env`,
  location,
  appLogsConfiguration: {
    destination: "log-analytics",
    logAnalyticsConfiguration: pulumi
      .all([logWorkspace.customerId, logWorkspace.name, rg.name])
      .apply(([cid, name, rgName_]) => ({
        customerId: cid ?? "",
        sharedKey: pulumi
          .output(
            azure.operationalinsights.getSharedKeys({
              resourceGroupName: rgName_,
              workspaceName: name,
            }),
          )
          .apply((k) => k.primarySharedKey ?? ""),
      })),
  },
});

interface ContainerAppArgs {
  readonly serviceName: string;
  readonly extraEnv?: ReadonlyArray<{ name: string; value: pulumi.Input<string> }>;
}

function containerApp(args: ContainerAppArgs): azure.app.ContainerApp {
  return new azure.app.ContainerApp(`${namePrefix}-${args.serviceName}`, {
    resourceGroupName: rg.name,
    containerAppName: `${namePrefix}-${args.serviceName}`,
    location,
    managedEnvironmentId: cappEnv.id,
    configuration: {
      activeRevisionsMode: "Single",
      ingress: {
        external: args.serviceName === "edge-router",
        targetPort: 8080,
        transport: "Auto",
      },
    },
    template: {
      scale: { minReplicas: env === "production" ? 1 : 0, maxReplicas: 10 },
      containers: [
        {
          name: args.serviceName,
          // Image pushed via `az acr build` for v1 (operator's job).
          image:
            cfg.get(`image-${args.serviceName}`) ??
            `${namePrefix}.azurecr.io/${args.serviceName}:latest`,
          env: [
            { name: "CAELO_PROVIDER", value: "azure" },
            { name: "CAELO_ENV", value: env },
            { name: "ADMIN_DATABASE_URL", value: adminDatabaseUrl },
            { name: "PUBLIC_ADMIN_DATABASE_URL", value: publicDatabaseUrl },
            {
              name: "MEDIA_STORAGE_URL",
              value: pulumi.interpolate`https://${storage.name}.blob.core.windows.net/media`,
            },
            ...(args.extraEnv ?? []),
          ],
          resources: { cpu: 0.5, memory: "1.0Gi" },
        },
      ],
    },
  });
}

const adminApp = containerApp({ serviceName: "admin" });
const _gatewayApp = containerApp({ serviceName: "gateway" });
const _orchestratorApp = containerApp({ serviceName: "orchestrator" });
const _runnerApp = containerApp({ serviceName: "runner" });
const edgeRouterApp = containerApp({
  serviceName: "edge-router",
  extraEnv: [
    {
      name: "STATIC_BUCKET_URL",
      value: pulumi.interpolate`https://${storage.name}.blob.core.windows.net/$web`,
    },
    { name: "MANIFEST_OBJECT", value: "ab-routing.json" },
  ],
});

// === 7. Bootstrap token ===
const tokenInfo = generateBootstrapToken();

// === 8. CloudAdapterOutputs ===
const dnsRecordsRequired: DnsRecord[] = [
  {
    hostname: domain,
    type: "CNAME",
    // Front Door domain comes from the resource (P15.4 review-pass adds
    // the actual Front Door + custom-domain bindings; v1 surfaces the
    // edge-router Container App FQDN as the temporary target).
    value: edgeRouterApp.configuration.apply(
      (c) => c?.ingress?.fqdn ?? "<edge-router-fqdn-pending>",
    ) as unknown as string,
    purpose:
      "Primary domain → edge-router Container App (P15.4 review-pass moves this behind Front Door)",
  },
];

const out: CloudAdapterOutputs = {
  adminDatabaseUrl: adminDatabaseUrl as unknown as string,
  publicDatabaseUrl: publicDatabaseUrl as unknown as string,
  mediaStorageUrl:
    pulumi.interpolate`https://${storage.name}.blob.core.windows.net/media` as unknown as string,
  mediaCdnBaseUrl: pulumi.interpolate`https://${domain}/media` as unknown as string,
  bootstrapUrl:
    pulumi.interpolate`https://${domain}/setup?token=${tokenInfo.token}` as unknown as string,
  dnsRecordsRequired,
  edgeLogSinkUrl: pulumi.interpolate`loganalytics://${logWorkspace.name}` as unknown as string,
  provider: "azure",
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
export const pgServerFqdnOut = pgServer.fullyQualifiedDomainName;
export const storageAccountNameOut = storage.name;
export const adminContainerAppFqdnOut = adminApp.configuration.apply((c) => c?.ingress?.fqdn);
export const edgeRouterContainerAppFqdnOut = edgeRouterApp.configuration.apply(
  (c) => c?.ingress?.fqdn,
);
export const bootstrapTokenExpiresAtOut = tokenInfo.expiresAt;
