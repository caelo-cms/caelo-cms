// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo Azure stack — Pulumi entry point.
 *
 * Resources provisioned per `pulumi up`:
 *  1. Resource group (created if missing).
 *  2. Azure Database for PostgreSQL flexible server, zone-redundant in
 *     production. Two databases (cms_admin + cms_public) created via
 *     post-create Container Apps job (bootstrap.sh).
 *  3. Storage account with a private `media` container and static-website
 *     hosting (the `$web` container the static generator publishes to).
 *  4. Azure Front Door Standard serving the static website on the primary
 *     domain with a managed certificate — files served as files, no compute
 *     on the request path (CLAUDE.md §11.B Tier 1).
 *  5. Azure Container Apps (admin/gateway/orchestrator/runner),
 *     mounted with Key Vault secrets via managed identity.
 *  6. Key Vault entries (postgres-password, csrf-secret, cookie-secret,
 *     anthropic-api-key, resend-api-key).
 *  7. Log Analytics workspace receives Container Apps logs;
 *     P12A analytics plugin's Azure adapter queries via monitor-query.
 *  8. Azure DNS zone for the primary domain (operator may opt out via
 *     config + manage at their existing registrar).
 *
 * Constraints worth knowing:
 *   - Container Apps not in every region; the stack errors loudly at
 *     preview if the `region` is unsupported.
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
import { azureFrontDoorDnsRecords } from "../../dist/azure-front-door.js";
import { generateBootstrapToken } from "../../dist/bootstrap-token.js";
import {
  ADMIN_MEMORY_DEFAULT,
  azureContainerAppResources,
  GATEWAY_TRUSTED_PROXY_HOPS,
  TRUSTED_PROXY_HOPS_ENV,
} from "../../dist/stack-contract.js";
import {
  FRONT_DOOR_SECURITY_RULE_SET,
  frontDoorSecurityRules,
} from "../../dist/static-security-headers.js";

const cfg = new pulumi.Config();
const domain = cfg.require("domain");
const _ownerEmail = cfg.require("ownerEmail");
const subscription = cfg.require("subscription");
const rgName = cfg.get("resourceGroup") ?? "caelo-rg";
// #607 — the region the operator chose (same key as every adapter, §11.B);
// no default, so a stack run without it fails instead of picking one.
// A stack configured with the pre-#607 key is told how to move, not
// silently mapped (no fallbacks pre-1.0).
const legacyLocation = cfg.get("location");
if (legacyLocation !== undefined) {
  throw new Error(
    `caelo-azure:location was renamed to caelo-azure:region. Run \`pulumi config set caelo-azure:region ${legacyLocation}\` and \`pulumi config rm caelo-azure:location\`, then re-run (keep the same value: the region is fixed after install).`,
  );
}
const location = cfg.require("region");
const flexibleServerSku = cfg.get("flexibleServerSku") ?? "Standard_B2s";
// #553 — the admin runs the Lighthouse quality audit; same knob + default
// as every adapter (stack-contract.ts). Container Apps only accepts fixed
// CPU/memory pairs (2 GiB per vCPU), so the admin's CPU follows its memory
// and an unsupported size is refused here.
const adminResources = azureContainerAppResources(cfg.get("adminMemory") ?? ADMIN_MEMORY_DEFAULT);

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
// #613 — one password per database role, so the gateway (public_role only,
// #635) never holds admin_role's. bootstrap.sh creates the roles with these
// (ADMIN_ROLE_PASSWORD / PUBLIC_ROLE_PASSWORD).
const publicRolePassword = pulumi.secret(randomHex(32));
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
keyVaultSecret("public-role-password", publicRolePassword);
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
// What the admin connects to cms_public with (DDL, migrations, moderation).
const publicAdminDatabaseUrl = pulumi
  .all([pgServer.fullyQualifiedDomainName, postgresPassword])
  .apply(([host, pw]) => `postgresql://caelo_admin:${pw}@${host}:5432/cms_public?sslmode=require`);
// The gateway's only login (#613, #635): public_role on cms_public. It has
// no cms_admin login at all (CLAUDE.md §2).
const publicDatabaseUrl = pulumi
  .all([pgServer.fullyQualifiedDomainName, publicRolePassword])
  .apply(([host, pw]) => `postgresql://public_role:${pw}@${host}:5432/cms_public?sslmode=require`);

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

// The container the static generator publishes to. Managed explicitly (not
// left to static-website hosting, which would create it implicitly) so a
// stack created before Front Door keeps owning it — changing the resource
// type would make Pulumi delete the container and every published page.
const staticContainer = new azure.storage.BlobContainer(`${namePrefix}-static`, {
  resourceGroupName: rg.name,
  accountName: storage.name,
  containerName: "$web",
  publicAccess: "Blob",
});

// Static-website hosting serves `$web` on the account's web endpoint, which
// resolves `/path/` to `/path/index.html` — the URL shape the static
// generator emits. Front Door fronts that endpoint.
const staticWebsite = new azure.storage.StorageAccountStaticWebsite(
  `${namePrefix}-static-website`,
  {
    resourceGroupName: rg.name,
    accountName: storage.name,
    indexDocument: "index.html",
    error404Document: "404.html",
  },
  { dependsOn: [staticContainer] },
);

// === 4b. Front Door (static site on the primary domain) ===
const frontDoor = new azure.cdn.Profile(`${namePrefix}-fd`, {
  resourceGroupName: rg.name,
  profileName: `${namePrefix}-fd`,
  location: "Global",
  sku: { name: "Standard_AzureFrontDoor" },
});

const frontDoorEndpoint = new azure.cdn.AFDEndpoint(`${namePrefix}-fd-endpoint`, {
  resourceGroupName: rg.name,
  profileName: frontDoor.name,
  endpointName: `${namePrefix}-site`,
  location: "Global",
  enabledState: "Enabled",
});

const staticOriginGroup = new azure.cdn.AFDOriginGroup(`${namePrefix}-fd-static`, {
  resourceGroupName: rg.name,
  profileName: frontDoor.name,
  originGroupName: "static",
  loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3 },
  healthProbeSettings: {
    probePath: "/",
    probeProtocol: "Https",
    probeRequestType: "HEAD",
    probeIntervalInSeconds: 100,
  },
});

// `primaryEndpoints.web` is `https://<account>.z<n>.web.core.windows.net/`;
// Front Door wants the bare host.
const staticWebHost = storage.primaryEndpoints.apply((e) => new URL(e.web).host);
const staticOrigin = new azure.cdn.AFDOrigin(
  `${namePrefix}-fd-static-origin`,
  {
    resourceGroupName: rg.name,
    profileName: frontDoor.name,
    originGroupName: staticOriginGroup.name,
    originName: "static-website",
    hostName: staticWebHost,
    originHostHeader: staticWebHost,
    httpsPort: 443,
    enabledState: "Enabled",
  },
  { dependsOn: [staticWebsite] },
);

const siteDomain = new azure.cdn.AFDCustomDomain(`${namePrefix}-fd-domain`, {
  resourceGroupName: rg.name,
  profileName: frontDoor.name,
  customDomainName: domain.replace(/\./g, "-"),
  hostName: domain,
  tlsSettings: { certificateType: "ManagedCertificate", minimumTlsVersion: "TLS12" },
});

// #587 — the redirects table as rules-engine rules on the static route
// (redirect-emit-front-door.ts in @caelo-cms/shared): Front Door answers
// them at the edge before the Blob origin. The deploy owns the rules; the
// stack only creates the rule set and attaches it.
// FIXME(issue #750): the Blob static publisher is still a stub (#6); until
// it writes the rules, the set stays empty and no redirect is served.
const redirectRuleSet = new azure.cdn.RuleSet(`${namePrefix}-fd-redirects`, {
  resourceGroupName: rg.name,
  profileName: frontDoor.name,
  ruleSetName: "caeloRedirects",
});

// #891 — the security response headers: nosniff on every response, the
// sandboxing CSP on every SVG (src/static-security-headers.ts). A set of
// its own: the deploy replaces the redirects set's rules wholesale.
const securityRuleSet = new azure.cdn.RuleSet(`${namePrefix}-fd-security`, {
  resourceGroupName: rg.name,
  profileName: frontDoor.name,
  ruleSetName: FRONT_DOOR_SECURITY_RULE_SET,
});
for (const rule of frontDoorSecurityRules()) {
  new azure.cdn.Rule(`${namePrefix}-fd-security-${rule.ruleName}`, {
    resourceGroupName: rg.name,
    profileName: frontDoor.name,
    ruleSetName: securityRuleSet.name,
    ...rule,
  });
}

new azure.cdn.Route(
  `${namePrefix}-fd-route`,
  {
    resourceGroupName: rg.name,
    profileName: frontDoor.name,
    endpointName: frontDoorEndpoint.name,
    routeName: "static",
    originGroup: { id: staticOriginGroup.id },
    customDomains: [{ id: siteDomain.id }],
    ruleSets: [{ id: redirectRuleSet.id }, { id: securityRuleSet.id }],
    patternsToMatch: ["/*"],
    // Without a cache configuration Front Door does not cache the route at
    // all; static files are edge-cached per their Cache-Control (§11.B
    // Tier 1). The generated site has no query-string-dependent content.
    cacheConfiguration: {
      queryStringCachingBehavior: "IgnoreQueryString",
      compressionSettings: {
        isCompressionEnabled: true,
        contentTypesToCompress: [
          "text/html",
          "text/css",
          "text/plain",
          "text/xml",
          "application/javascript",
          "application/json",
          "application/xml",
          "image/svg+xml",
        ],
      },
    },
    supportedProtocols: ["Http", "Https"],
    forwardingProtocol: "HttpsOnly",
    httpsRedirect: "Enabled",
    linkToDefaultDomain: "Enabled",
  },
  // A route needs an origin in its group before Front Door accepts it.
  { dependsOn: [staticOrigin] },
);

// === 5. Log Analytics workspace ===
const logWorkspace = new azure.operationalinsights.Workspace(`${namePrefix}-logs`, {
  resourceGroupName: rg.name,
  workspaceName: `${namePrefix}-logs`,
  location,
  sku: { name: "PerGB2018" },
  retentionInDays: env === "production" ? 90 : 30,
});

// === 6. Container Apps environment + apps ===
//
// FIXME(issue #750): no quality-audit Container Apps job yet. On GCP every
// Lighthouse run of a Stage audit runs in its own container (#875,
// src/audit-job-setup.ts); the Azure equivalent is a Container Apps job
// with one replica per run (admin-core quality/parallel-runner.ts
// `AuditTaskLauncher`). Until it exists the admin records every Lighthouse
// audit as failed with that gap (quality/lighthouse-runner-select.ts)
// instead of measuring on its own shared CPU. Nothing is staged on Azure
// before #750 either.
//
// FIXME(issue #696): no in-cloud upgrader or converge job (#819) yet. On
// GCP Settings → Updates hands app-roll releases to the upgrader job and
// cloud-setup releases to the converge job; on Azure the admin refuses a
// cloud-setup release with the CLI command that installs it (admin-core
// platform-updates/update-route.ts) until this adapter gains both jobs.
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
  /**
   * The service's database connection env. The admin-side services get
   * admin_role's URLs; the gateway gets only its own two logins (#613,
   * CLAUDE.md §2 — never an admin_role credential).
   */
  readonly databaseEnv: ReadonlyArray<{ name: string; value: pulumi.Input<string> }>;
  readonly extraEnv?: ReadonlyArray<{ name: string; value: pulumi.Input<string> }>;
  /** Defaults to 0.5 vCPU / 1 GiB. */
  readonly resources?: { readonly cpu: number; readonly memory: string };
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
        external: false,
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
            ...args.databaseEnv,
            {
              name: "MEDIA_STORAGE_URL",
              value: pulumi.interpolate`https://${storage.name}.blob.core.windows.net/media`,
            },
            ...(args.extraEnv ?? []),
          ],
          resources: args.resources ?? { cpu: 0.5, memory: "1.0Gi" },
        },
      ],
    },
  });
}

const adminDatabaseEnv = [
  { name: "ADMIN_DATABASE_URL", value: adminDatabaseUrl },
  { name: "PUBLIC_ADMIN_DATABASE_URL", value: publicAdminDatabaseUrl },
];
const adminApp = containerApp({
  serviceName: "admin",
  databaseEnv: adminDatabaseEnv,
  resources: adminResources,
  // #551 — the public site URL; the admin seeds site_defaults.site_base_url
  // from it (canonical, og:url, sitemap) when it is not configured yet.
  extraEnv: [{ name: "CAELO_SITE_URL", value: `https://${domain}` }],
});
const _gatewayApp = containerApp({
  serviceName: "gateway",
  databaseEnv: [{ name: "PUBLIC_DATABASE_URL", value: publicDatabaseUrl }],
  // Which X-Forwarded-For entry is the visitor (api-gateway client-ip.ts).
  // #806 — no remote-MCP env: remote MCP rides Google IAP (gcp stacks
  // only); unset, the gateway answers /api/mcp/* with 503
  // remote_mcp_not_configured and the admin reports it unavailable.
  extraEnv: [{ name: TRUSTED_PROXY_HOPS_ENV, value: String(GATEWAY_TRUSTED_PROXY_HOPS.azure) }],
});
const _orchestratorApp = containerApp({
  serviceName: "orchestrator",
  databaseEnv: adminDatabaseEnv,
});
const _runnerApp = containerApp({ serviceName: "runner", databaseEnv: adminDatabaseEnv });
// === 7. Bootstrap token ===
const tokenInfo = generateBootstrapToken();

// === 8. CloudAdapterOutputs ===
const dnsRecordsRequired = pulumi
  .all([frontDoorEndpoint.hostName, siteDomain.validationProperties])
  .apply(([endpointHostName, validation]) =>
    azureFrontDoorDnsRecords({
      domain,
      endpointHostName,
      validationToken: validation.validationToken,
    }),
  );

const out: CloudAdapterOutputs = {
  adminDatabaseUrl: adminDatabaseUrl as unknown as string,
  publicDatabaseUrl: publicDatabaseUrl as unknown as string,
  mediaStorageUrl:
    pulumi.interpolate`https://${storage.name}.blob.core.windows.net/media` as unknown as string,
  mediaCdnBaseUrl: pulumi.interpolate`https://${domain}/media` as unknown as string,
  bootstrapUrl:
    pulumi.interpolate`https://${domain}/setup?token=${tokenInfo.token}` as unknown as string,
  dnsRecordsRequired: dnsRecordsRequired as unknown as DnsRecord[],
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
export const frontDoorEndpointHostNameOut = frontDoorEndpoint.hostName;
export const bootstrapTokenExpiresAtOut = tokenInfo.expiresAt;
