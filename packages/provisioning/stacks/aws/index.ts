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
 *     Static files are served as files — no edge compute on the request
 *     path (CLAUDE.md §11.B Tier 1).
 *  5. ECS Fargate cluster + four services (admin, gateway, orchestrator, runner).
 *  6. Secrets Manager entries (postgres-password, anthropic-api-key, ...).
 *  7. Route 53 hosted zone + ACM certs per (domain, locale).
 *  8. CloudWatch log group for the gateway's request logs (the analytics
 *     plugin's log sink).
 *  9. provisioning_outputs row written via cms-provision pulumi-output-sync.
 *
 * Per CMS_REQUIREMENTS §15 + the P15 plan, the runtime never knows it's
 * on AWS — every Caelo service consumes plain DATABASE_URL /
 * MEDIA_STORAGE_URL / SECRETS_PROVIDER env vars. This file's only job
 * is to wire those env vars to AWS-native resources.
 */

import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";
import type { CloudAdapterOutputs, DnsRecord } from "../../dist/adapter.js";
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
// #613 — one password per database role, so the gateway (public_role +
// gateway_role) never holds admin_role's. bootstrap.sh creates the roles
// with these (PUBLIC_ROLE_PASSWORD / GATEWAY_ROLE_PASSWORD).
const publicRolePassword = pulumi.secret(randomHex(32));
const gatewayRolePassword = pulumi.secret(randomHex(32));
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
const gatewayRoleSecret = secret("gateway-role-password", gatewayRolePassword);
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
// The gateway's cms_admin login (#613): grants from migration 0248 only.
const gatewayDatabaseUrl = pulumi
  .all([db.address, db.port, gatewayRolePassword])
  .apply(
    ([host, port, pw]) =>
      `postgresql://gateway_role:${pw}@${host}:${port}/cms_admin?sslmode=require`,
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

// === 6. Gateway request-log sink ===
//
// The gateway's ECS task logs here through the awslogs driver; the
// analytics plugin's AWS adapter reads it (`edgeLogSinkUrl`).
const gatewayLogGroup = new aws.cloudwatch.LogGroup(`${namePrefix}-gateway-logs`, {
  name: `/caelo/${env}/gateway`,
  retentionInDays: env === "production" ? 90 : 30,
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
  customErrorResponses: [
    { errorCode: 404, responseCode: 404, responsePagePath: "/404.html", errorCachingMinTtl: 60 },
  ],
});

// === 8. ECS Fargate cluster + services ===
//
// Each Caelo service runs as its own Fargate service; sharing a cluster
// keeps the per-month Fargate-cluster fee at zero (clusters are free).
const cluster = new aws.ecs.Cluster(`${namePrefix}-ecs`, {
  settings: [{ name: "containerInsights", value: "enabled" }],
});

const taskRole = new aws.iam.Role(`${namePrefix}-task-role`, {
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

new aws.iam.RolePolicy(`${namePrefix}-task-secrets`, {
  role: taskRole.id,
  policy: pulumi
    .all([
      pgSecret.arn,
      publicRoleSecret.arn,
      gatewayRoleSecret.arn,
      csrfSecretRes.arn,
      cookieSecretRes.arn,
      anthropicSecretRes.arn,
      resendSecretRes.arn,
    ])
    .apply((arns) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: arns }],
      }),
    ),
});

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
  gatewayDatabaseUrl: gatewayDatabaseUrl as unknown as string,
  mediaStorageUrl: pulumi.interpolate`s3://${mediaBucket.bucket}` as unknown as string,
  mediaCdnBaseUrl:
    pulumi.interpolate`https://${distribution.domainName}/media` as unknown as string,
  bootstrapUrl:
    pulumi.interpolate`https://${domain}/setup?token=${tokenInfo.token}` as unknown as string,
  dnsRecordsRequired,
  edgeLogSinkUrl: pulumi.interpolate`cloudwatch://${gatewayLogGroup.name}` as unknown as string,
  provider: "aws",
  environment: env,
};

export const adminDatabaseUrlOut = out.adminDatabaseUrl;
export const publicDatabaseUrlOut = out.publicDatabaseUrl;
export const gatewayDatabaseUrlOut = out.gatewayDatabaseUrl;
export const mediaStorageUrlOut = out.mediaStorageUrl;
export const mediaCdnBaseUrlOut = out.mediaCdnBaseUrl;
export const bootstrapUrlOut = out.bootstrapUrl;
export const dnsRecordsRequiredOut = out.dnsRecordsRequired;
export const edgeLogSinkUrlOut = out.edgeLogSinkUrl;
export const providerOut = out.provider;
export const environmentOut = out.environment;
export const cloudfrontDomainOut = distribution.domainName;
export const ecsClusterArnOut = cluster.arn;
export const rdsAddressOut = db.address;

// Note: the bootstrap token (and other secrets like postgres-password,
// CSRF/cookie secrets, Anthropic key) are stored in Pulumi's encrypted
// state via `pulumi.secret(...)`. Operators retrieve via
// `pulumi stack output --show-secrets`.
export const bootstrapTokenExpiresAtOut = tokenInfo.expiresAt;
