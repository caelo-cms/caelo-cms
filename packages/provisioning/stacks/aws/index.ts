// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo AWS stack — Pulumi entry point.
 *
 * Resources provisioned per `pulumi up`:
 *  1. VPC with public + private subnets (two AZs for RDS Multi-AZ).
 *  2. RDS Postgres 16 Multi-AZ + automated backups + encryption.
 *     - Two databases: cms_admin + cms_public.
 *     - Two roles: admin_role (full schema), public_role (RLS-scoped).
 *     - Bootstrap script runs as a one-shot ECS task post-create.
 *  3. S3 buckets: caelo-media + caelo-static (per env).
 *  4. CloudFront distribution with two origins (S3 static + ALB-fronted ECS).
 *     Static files are served as files (CLAUDE.md §11.B Tier 1); the only
 *     edge code is the redirects table's CloudFront Function, a KeyValueStore
 *     lookup that runs before the origin (#587).
 *  5. ECS Fargate cluster + four services (admin, gateway, orchestrator, runner).
 *  6. Secrets Manager entries (postgres-password, anthropic-api-key, ...).
 *  7. Route 53 hosted zone + ACM certs per (domain, locale).
 *  8. CloudFront access logs → CloudWatch log group (the analytics plugin's
 *     log sink).
 *  9. provisioning_outputs row written via cms-provision pulumi-output-sync.
 *
 * Per CMS_REQUIREMENTS §15 + the P15 plan, the runtime never knows it's
 * on AWS — every Caelo service consumes plain DATABASE_URL /
 * MEDIA_STORAGE_URL / SECRETS_PROVIDER env vars. This file's only job
 * is to wire those env vars to AWS-native resources.
 */

import { cloudFrontRedirectFunctionCode } from "@caelo-cms/shared";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";
import type { CloudAdapterOutputs, DnsRecord } from "../../dist/adapter.js";
import {
  AWS_SERVICE_SECRETS,
  type AwsSecret,
  type AwsTaskService,
  secretsReadPolicy,
} from "../../dist/aws-task-roles.js";
import { generateBootstrapToken } from "../../dist/bootstrap-token.js";
import { ADMIN_MEMORY_DEFAULT, memoryQuantityMiB } from "../../dist/stack-contract.js";

const cfg = new pulumi.Config();
const domain = cfg.require("domain");
const _ownerEmail = cfg.require("ownerEmail");
// #607 — chosen by the operator and fixed after install; no default. The
// stack's resources use the default AWS provider, which reads `aws:region`,
// so the two must agree — otherwise resources would land somewhere other
// than the region the install records.
const region = cfg.require("region");
if (aws.config.region !== region) {
  throw new Error(
    `caelo-aws:region is ${region} but the AWS provider region (aws:region / AWS_REGION) is ${aws.config.region ?? "unset"}; run \`pulumi config set aws:region ${region}\`.`,
  );
}
const rdsInstanceClass = cfg.get("rdsInstanceClass") ?? "db.t4g.small";
const _fargateCpu = cfg.get("fargateCpu") ?? "512";
const _fargateMemoryMb = cfg.get("fargateMemoryMb") ?? "1024";
// #553 — the admin's memory, same knob + default as every adapter
// (stack-contract.ts). This stack does not define ECS task definitions for
// any Caelo service yet (see `fargateCpu` / `fargateMemoryMb`); the value
// is validated now so a config set today fails loudly instead of being
// ignored, and the admin task definition sizes itself from it.
const adminMemory = cfg.get("adminMemory") ?? ADMIN_MEMORY_DEFAULT;
const _adminMemoryMiB = memoryQuantityMiB(adminMemory);
if (_adminMemoryMiB === null) {
  throw new Error(`caelo-aws:adminMemory "${adminMemory}" is not a memory quantity (e.g. 2Gi)`);
}

// Pulumi stack name doubles as the environment label so a single
// project supports `pulumi stack init dev|staging|production`.
const env = pulumi.getStack() as "dev" | "staging" | "production";
const namePrefix = `caelo-${env}`;

// CloudFront only accepts ACM certificates issued in us-east-1, regardless
// of where its origins are — a hard AWS constraint, not a preference.
const usEast1Provider = new aws.Provider("aws-us-east-1", { region: "us-east-1" });

// === 1. VPC ===
const vpc = new awsx.ec2.Vpc(`${namePrefix}-vpc`, {
  numberOfAvailabilityZones: 2,
  subnetSpecs: [
    { type: "Public", cidrMask: 24 },
    { type: "Private", cidrMask: 24 },
  ],
  natGateways: { strategy: "Single" },
});

// === 2. Secrets Manager ===
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

function secret(name: string, value: pulumi.Output<string>): aws.secretsmanager.Secret {
  const s = new aws.secretsmanager.Secret(`${namePrefix}-${name}`, {
    name: `${namePrefix}-${name}`,
    description: `Caelo ${env}: ${name}`,
  });
  new aws.secretsmanager.SecretVersion(
    `${namePrefix}-${name}-v1`,
    { secretId: s.id, secretString: value },
    { dependsOn: [s] },
  );
  return s;
}

const pgSecret = secret("postgres-password", postgresPassword);
const publicRoleSecret = secret("public-role-password", publicRolePassword);
const csrfSecretRes = secret("csrf-secret", csrfSecret);
const cookieSecretRes = secret("cookie-secret", cookieSecret);
const anthropicSecretRes = secret("anthropic-api-key", anthropicApiKey);
const resendSecretRes = secret("resend-api-key", resendApiKey);

// === 3. RDS Postgres 16 Multi-AZ ===
const dbSubnetGroup = new aws.rds.SubnetGroup(`${namePrefix}-db-subnets`, {
  subnetIds: vpc.privateSubnetIds,
  description: `Caelo ${env} private subnet group`,
});

const dbSecurityGroup = new aws.ec2.SecurityGroup(`${namePrefix}-db-sg`, {
  vpcId: vpc.vpcId,
  description: `Caelo ${env} RDS — only Fargate tasks reach 5432.`,
  // Egress all so RDS can reach AWS-internal services for backups.
  egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

const db = new aws.rds.Instance(`${namePrefix}-pg`, {
  engine: "postgres",
  engineVersion: "16.4",
  instanceClass: rdsInstanceClass,
  allocatedStorage: 20,
  storageEncrypted: true,
  multiAz: env === "production",
  username: "caelo_admin",
  password: postgresPassword,
  dbSubnetGroupName: dbSubnetGroup.name,
  vpcSecurityGroupIds: [dbSecurityGroup.id],
  backupRetentionPeriod: env === "production" ? 14 : 1,
  skipFinalSnapshot: env !== "production",
  deletionProtection: env === "production",
  publiclyAccessible: false,
  applyImmediately: env !== "production",
});

const adminDatabaseUrl = pulumi
  .all([db.address, db.port, postgresPassword])
  .apply(
    ([host, port, pw]) =>
      `postgresql://caelo_admin:${pw}@${host}:${port}/cms_admin?sslmode=require`,
  );
const publicDatabaseUrl = pulumi
  .all([db.address, db.port, publicRolePassword])
  .apply(
    ([host, port, pw]) =>
      `postgresql://public_role:${pw}@${host}:${port}/cms_public?sslmode=require`,
  );

// === 4. S3 buckets ===
const mediaBucket = new aws.s3.BucketV2(`${namePrefix}-media`, {
  bucket: `${namePrefix}-media`,
  forceDestroy: env !== "production",
});
const staticBucket = new aws.s3.BucketV2(`${namePrefix}-static`, {
  bucket: `${namePrefix}-static`,
  forceDestroy: env !== "production",
});

// Block public access — CloudFront reaches via OAI.
for (const b of [mediaBucket, staticBucket]) {
  new aws.s3.BucketPublicAccessBlock(`${b._name}-pab`, {
    bucket: b.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });
}

const cdnOai = new aws.cloudfront.OriginAccessIdentity(`${namePrefix}-oai`, {
  comment: `Caelo ${env} CloudFront → S3`,
});

// Bucket policies allow OAI read.
for (const b of [mediaBucket, staticBucket]) {
  new aws.s3.BucketPolicy(`${b._name}-policy`, {
    bucket: b.id,
    policy: pulumi.all([b.arn, cdnOai.iamArn]).apply(([arn, oaiArn]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: oaiArn },
            Action: "s3:GetObject",
            Resource: `${arn}/*`,
          },
        ],
      }),
    ),
  });
}

// === 5. ACM cert (must be us-east-1 for CloudFront) ===
const cert = new aws.acm.Certificate(
  `${namePrefix}-cert`,
  {
    domainName: domain,
    subjectAlternativeNames: [`staging.${domain}`, `*.${domain}`],
    validationMethod: "DNS",
  },
  { provider: usEast1Provider },
);

// === 6b. Redirects at the edge (#587) ===
// The redirects table: a CloudFront Function on viewer-request answers each
// redirected path from a KeyValueStore before the S3 origin is asked
// (redirect-emit-cloudfront.ts in @caelo-cms/shared). The deploy writes
// the store, so redirects change without republishing the function.
// FIXME(issue #749): the S3 static publisher is still a stub (#5); until
// it writes the store, the function finds no keys and every request passes
// through to the origin.
const redirectKvs = new aws.cloudfront.KeyValueStore(`${namePrefix}-redirects`, {
  name: `${namePrefix}-redirects`,
  comment: `Caelo ${env} redirects table (#587)`,
});
const redirectFunction = new aws.cloudfront.Function(`${namePrefix}-redirects`, {
  name: `${namePrefix}-redirects`,
  runtime: "cloudfront-js-2.0",
  comment: `Caelo ${env}: answer the redirects table at the edge (#587)`,
  publish: true,
  code: redirectKvs.arn.apply((arn) => cloudFrontRedirectFunctionCode(kvsIdFromArn(arn))),
  keyValueStoreAssociations: [redirectKvs.arn],
});

// === 7. CloudFront distribution ===
const distribution = new aws.cloudfront.Distribution(`${namePrefix}-cdn`, {
  enabled: true,
  isIpv6Enabled: true,
  defaultRootObject: "index.html",
  aliases: [domain, `staging.${domain}`],
  origins: [
    {
      originId: "static",
      domainName: staticBucket.bucketRegionalDomainName,
      s3OriginConfig: { originAccessIdentity: cdnOai.cloudfrontAccessIdentityPath },
    },
    {
      originId: "media",
      domainName: mediaBucket.bucketRegionalDomainName,
      s3OriginConfig: { originAccessIdentity: cdnOai.cloudfrontAccessIdentityPath },
    },
  ],
  defaultCacheBehavior: {
    targetOriginId: "static",
    viewerProtocolPolicy: "redirect-to-https",
    allowedMethods: ["GET", "HEAD"],
    cachedMethods: ["GET", "HEAD"],
    forwardedValues: { queryString: false, cookies: { forward: "none" } },
    minTtl: 0,
    defaultTtl: 60,
    maxTtl: 86400,
    functionAssociations: [{ eventType: "viewer-request", functionArn: redirectFunction.arn }],
  },
  orderedCacheBehaviors: [
    {
      pathPattern: "/media/*",
      targetOriginId: "media",
      viewerProtocolPolicy: "redirect-to-https",
      allowedMethods: ["GET", "HEAD"],
      cachedMethods: ["GET", "HEAD"],
      forwardedValues: { queryString: false, cookies: { forward: "none" } },
      minTtl: 0,
      defaultTtl: 31536000,
      maxTtl: 31536000,
    },
  ],
  viewerCertificate: {
    acmCertificateArn: cert.arn,
    sslSupportMethod: "sni-only",
    minimumProtocolVersion: "TLSv1.2_2021",
  },
  restrictions: { geoRestriction: { restrictionType: "none" } },
  // #802 — unknown URLs get the site's own 404 page (the generator writes
  // `/404.html` from the designated page) with status 404. The S3 origins
  // are OAI-only with `s3:GetObject` and no `s3:ListBucket`, so S3 answers
  // a missing key with 403, not 404; without the 403 entry visitors saw
  // S3's AccessDenied XML. Both origins on this distribution are private
  // buckets, so a 403 here always means "no such object".
  customErrorResponses: [
    { errorCode: 403, responseCode: 404, responsePagePath: "/404.html", errorCachingMinTtl: 60 },
    { errorCode: 404, responseCode: 404, responsePagePath: "/404.html", errorCachingMinTtl: 60 },
  ],
});

// === 7b. Edge-log sink: CloudFront access logs → CloudWatch Logs ===
//
// CloudFront delivers its access logs through CloudWatch vended-log
// delivery, which for CloudFront runs in us-east-1 — so the log group and
// the delivery resources live there too. The analytics plugin's AWS adapter
// reads this group (`edgeLogSinkUrl`).
const edgeLogGroup = new aws.cloudwatch.LogGroup(
  `${namePrefix}-edge-logs`,
  {
    name: `/caelo/${env}/cloudfront`,
    retentionInDays: env === "production" ? 90 : 30,
  },
  { provider: usEast1Provider },
);
const edgeLogSource = new aws.cloudwatch.LogDeliverySource(
  `${namePrefix}-edge-log-source`,
  {
    name: `${namePrefix}-cloudfront`,
    logType: "ACCESS_LOGS",
    resourceArn: distribution.arn,
  },
  { provider: usEast1Provider },
);
const edgeLogDestination = new aws.cloudwatch.LogDeliveryDestination(
  `${namePrefix}-edge-log-destination`,
  {
    name: `${namePrefix}-cloudfront-logs`,
    deliveryDestinationConfiguration: { destinationResourceArn: edgeLogGroup.arn },
  },
  { provider: usEast1Provider },
);
new aws.cloudwatch.LogDelivery(
  `${namePrefix}-edge-log-delivery`,
  {
    deliverySourceName: edgeLogSource.name,
    deliveryDestinationArn: edgeLogDestination.arn,
  },
  { provider: usEast1Provider },
);

// === 8. ECS Fargate cluster + services ===
//
// Each Caelo service runs as its own Fargate service; sharing a cluster
// keeps the per-month Fargate-cluster fee at zero (clusters are free).
//
// FIXME(issue #749): no quality-audit task definition yet. On GCP every
// Lighthouse run of a Stage audit runs in its own container (#875,
// src/audit-job-setup.ts); the AWS equivalent is a Fargate task per run
// (admin-core quality/parallel-runner.ts `AuditTaskLauncher`). Until it
// exists the admin records every Lighthouse audit as failed with that gap
// (quality/lighthouse-runner-select.ts) instead of measuring on its own
// shared CPU. Nothing is staged on AWS before #749 either.
//
// FIXME(issue #696): no in-cloud upgrader or converge job (#819) yet. On
// GCP Settings → Updates hands app-roll releases to the upgrader job and
// cloud-setup releases to the converge job; on AWS the admin refuses a
// cloud-setup release with the CLI command that installs it (admin-core
// platform-updates/update-route.ts) until this adapter gains both jobs.
const cluster = new aws.ecs.Cluster(`${namePrefix}-ecs`, {
  settings: [{ name: "containerInsights", value: "enabled" }],
});

// One task role per service (#635): the gateway's may read only the
// public_role password, never a secret that unlocks a cms_admin login
// (src/aws-task-roles.ts AWS_SERVICE_SECRETS, asserted by
// gateway-env-isolation.test.ts). The admin keeps the logical names the
// former shared role had, so upgrading replaces nothing on its side.
const secretArns: Record<AwsSecret, pulumi.Output<string>> = {
  "postgres-password": pgSecret.arn,
  "public-role-password": publicRoleSecret.arn,
  "csrf-secret": csrfSecretRes.arn,
  "cookie-secret": cookieSecretRes.arn,
  "anthropic-api-key": anthropicSecretRes.arn,
  "resend-api-key": resendSecretRes.arn,
};

function taskRole(service: AwsTaskService): aws.iam.Role {
  const prefix = service === "admin" ? namePrefix : `${namePrefix}-${service}`;
  const role = new aws.iam.Role(`${prefix}-task-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    }),
  });
  new aws.iam.RolePolicy(`${prefix}-task-secrets`, {
    role: role.id,
    policy: pulumi
      .all(AWS_SERVICE_SECRETS[service].map((name) => secretArns[name]))
      .apply(secretsReadPolicy),
  });
  return role;
}

const taskRoles: Record<AwsTaskService, aws.iam.Role> = {
  admin: taskRole("admin"),
  gateway: taskRole("gateway"),
};

const execRole = new aws.iam.Role(`${namePrefix}-exec-role`, {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "ecs-tasks.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  }),
});
new aws.iam.RolePolicyAttachment(`${namePrefix}-exec-managed`, {
  role: execRole.name,
  policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

// === 9. Bootstrap token ===
const tokenInfo = generateBootstrapToken();

// === 10. Outputs (CloudAdapterOutputs shape) ===
const dnsRecordsRequired: DnsRecord[] = [
  {
    hostname: domain,
    type: "A",
    value: distribution.domainName.toString(),
    purpose: "Primary domain → CloudFront distribution (alias record)",
  },
  {
    hostname: `staging.${domain}`,
    type: "A",
    value: distribution.domainName.toString(),
    purpose: "Staging subdomain → CloudFront distribution (alias record)",
  },
];

const out: CloudAdapterOutputs = {
  adminDatabaseUrl: adminDatabaseUrl as unknown as string,
  publicDatabaseUrl: publicDatabaseUrl as unknown as string,
  mediaStorageUrl: pulumi.interpolate`s3://${mediaBucket.bucket}` as unknown as string,
  mediaCdnBaseUrl:
    pulumi.interpolate`https://${distribution.domainName}/media` as unknown as string,
  bootstrapUrl:
    pulumi.interpolate`https://${domain}/setup?token=${tokenInfo.token}` as unknown as string,
  dnsRecordsRequired,
  edgeLogSinkUrl:
    pulumi.interpolate`cloudwatch://us-east-1/${edgeLogGroup.name}` as unknown as string,
  provider: "aws",
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
export const cloudfrontDomainOut = distribution.domainName;
export const redirectKvsArnOut = redirectKvs.arn;
export const ecsClusterArnOut = cluster.arn;
export const rdsAddressOut = db.address;
// The task roles the admin-side and gateway task definitions run as.
export const adminTaskRoleArnOut = taskRoles.admin.arn;
export const gatewayTaskRoleArnOut = taskRoles.gateway.arn;

// Note: the bootstrap token (and other secrets like postgres-password,
// CSRF/cookie secrets, Anthropic key) are stored in Pulumi's encrypted
// state via `pulumi.secret(...)`. Operators retrieve via
// `pulumi stack output --show-secrets`.
export const bootstrapTokenExpiresAtOut = tokenInfo.expiresAt;

/** A KeyValueStore's id: the last segment of its ARN. */
function kvsIdFromArn(arn: string): string {
  const id = arn.slice(arn.lastIndexOf("/") + 1);
  if (!id || id === arn) throw new Error(`not a CloudFront KeyValueStore ARN: ${arn}`);
  return id;
}
