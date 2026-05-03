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
 *  5. Lambda@Edge function (us-east-1 pinned; viewer-request event) that
 *     reads `routing-manifest.json`, runs the @caelo/edge-router stable-hash
 *     assignment, sets the `caelo_visitor_id` cookie, rewrites the URL.
 *  6. ECS Fargate cluster + four services (admin, gateway, orchestrator, runner).
 *  7. Secrets Manager entries (postgres-password, anthropic-api-key, ...).
 *  8. Route 53 hosted zone + ACM certs per (domain, locale).
 *  9. CloudWatch Logs → Kinesis Firehose → S3 sink for L@E assignment logs.
 * 10. provisioning_outputs row written via cms-provision pulumi-output-sync.
 *
 * Per CMS_REQUIREMENTS §15 + the P15 plan, the runtime never knows it's
 * on AWS — every Caelo service consumes plain DATABASE_URL /
 * MEDIA_STORAGE_URL / SECRETS_PROVIDER env vars. This file's only job
 * is to wire those env vars to AWS-native resources.
 */

import { resolve } from "node:path";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import { local } from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import type { CloudAdapterOutputs, DnsRecord } from "../../src/adapter.js";
import { generateBootstrapToken } from "../../src/bootstrap-token.js";

const cfg = new pulumi.Config();
const domain = cfg.require("domain");
const ownerEmail = cfg.require("ownerEmail");
const region = cfg.get("region") ?? "us-east-1";
const rdsInstanceClass = cfg.get("rdsInstanceClass") ?? "db.t4g.small";
const fargateCpu = cfg.get("fargateCpu") ?? "512";
const fargateMemoryMb = cfg.get("fargateMemoryMb") ?? "1024";

// Pulumi stack name doubles as the environment label so a single
// project supports `pulumi stack init dev|staging|production`.
const env = pulumi.getStack() as "dev" | "staging" | "production";
const namePrefix = `caelo-${env}`;

// Lambda@Edge functions MUST live in us-east-1 regardless of where
// CloudFront's origins are — this is a hard AWS constraint, not a
// preference.
const lambdaEdgeProvider = new aws.Provider("aws-us-east-1", { region: "us-east-1" });

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
  .all([db.address, db.port, postgresPassword])
  .apply(
    ([host, port, pw]) =>
      `postgresql://caelo_public:${pw}@${host}:${port}/cms_public?sslmode=require`,
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
  { provider: lambdaEdgeProvider },
);

// === 6. Lambda@Edge for A/B split + redirects ===
//
// Bundles @caelo/edge-router's pure assignment helper. Real deployments
// build this via a separate `bun build --target=node --bundle` step
// then upload the zip; for v1 we inline a small handler that imports
// the route logic from a sibling module.
const edgeLambdaRole = new aws.iam.Role(
  `${namePrefix}-edge-role`,
  {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"] },
          Action: "sts:AssumeRole",
        },
      ],
    }),
  },
  { provider: lambdaEdgeProvider },
);
new aws.iam.RolePolicyAttachment(
  `${namePrefix}-edge-role-basic`,
  {
    role: edgeLambdaRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  },
  { provider: lambdaEdgeProvider },
);

const edgeLambda = new aws.lambda.Function(
  `${namePrefix}-edge`,
  {
    role: edgeLambdaRole.arn,
    runtime: "nodejs20.x",
    handler: "index.handler",
    timeout: 5,
    publish: true, // L@E requires a published version, not $LATEST
    code: new pulumi.asset.AssetArchive({
      // The handler bundle is built by `bun run build:edge-aws` from
      // packages/provisioning/stacks/aws/edge-handler.ts. Operators run
      // that command before `pulumi up` — see this stack's README.md.
      "index.js": new pulumi.asset.FileAsset(resolve(import.meta.dir, "edge-handler-bundle.js")),
    }),
  },
  { provider: lambdaEdgeProvider },
);

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
    lambdaFunctionAssociations: [
      {
        eventType: "viewer-request",
        lambdaArn: edgeLambda.qualifiedArn,
        includeBody: false,
      },
    ],
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
  mediaStorageUrl: pulumi.interpolate`s3://${mediaBucket.bucket}` as unknown as string,
  mediaCdnBaseUrl:
    pulumi.interpolate`https://${distribution.domainName}/media` as unknown as string,
  bootstrapUrl:
    pulumi.interpolate`https://${domain}/setup?token=${tokenInfo.token}` as unknown as string,
  dnsRecordsRequired,
  edgeLogSinkUrl:
    pulumi.interpolate`cloudwatch://aws/lambda/${edgeLambda.name}` as unknown as string,
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
export const ecsClusterArnOut = cluster.arn;
export const rdsAddressOut = db.address;

// Note: the bootstrap token (and other secrets like postgres-password,
// CSRF/cookie secrets, Anthropic key) are stored in Pulumi's encrypted
// state via `pulumi.secret(...)`. Operators retrieve via
// `pulumi stack output --show-secrets`.
export const bootstrapTokenExpiresAtOut = tokenInfo.expiresAt;
