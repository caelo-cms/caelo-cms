// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.78 — AWS S3 static publisher stub.
 *
 * Real implementation lands when the first install on AWS EKS / ECS
 * Fargate happens. Today there's no operator running on AWS, so
 * shipping a half-tested adapter would just be dead code. The shape
 * is identical to the GCS adapter:
 *   - publishStaging → s3 putObject under `<runId>/` prefix in a
 *     private staging bucket
 *   - promoteToProduction → s3 copyObject server-side from staging
 *     to public static bucket; CloudFront cache invalidation
 *     optional via `caelo-aws:invalidateCdnOnPublish`
 *   - rollback → s3 putObject from a local archive (or copy from a
 *     historical archive prefix in v0.2.79+)
 *
 * Env vars expected (set by AWS Pulumi stack on the admin Lambda /
 * Fargate task definition):
 *   - CAELO_STATIC_BUCKET (S3 bucket name)
 *   - CAELO_STAGING_BUCKET (S3 bucket name)
 *   - AWS region resolved by the SDK from environment.
 *
 * #587 — redirects: the real publisher must also write the redirect plan (`buildRedirectPlan` → `cloudFrontKeyValueEntries`, @caelo-cms/shared) into the stack's CloudFront KeyValueStore after the files are live, or AWS installs answer every recorded 301 with a 404.
 * #1157 — and `syncRedirects` must write the plan into the KeyValueStore on save, without a build, against the live build's files (see deploy/redirect-sync.ts).
 * FIXME(issue #749): implement with the publisher.
 *
 * Per CLAUDE.md §2 (no fallbacks pre-1.0): the stub throws loudly
 * with a pointer to the tracking issue. Do not silently fall back to
 * self-hosted — that would mask the gap.
 */

import type { StaticPublisher } from "./static-publisher.js";

const NOT_IMPLEMENTED =
  "AWS S3 static publisher not yet implemented. Stage / Confirm-publish on AWS Cloud installs is tracked for a future release; until then run on GCP, self-hosted, or wait for the AWS adapter. See https://github.com/caelo-cms/caelo-cms/issues for status.";

export const s3StaticPublisher: StaticPublisher = {
  servesCurrentDir: false,
  async publishStaging() {
    throw new Error(NOT_IMPLEMENTED);
  },
  async promoteToProduction() {
    throw new Error(NOT_IMPLEMENTED);
  },
  async rollback() {
    throw new Error(NOT_IMPLEMENTED);
  },
  // #1157 — no publisher, so nothing is ever live to sync redirects onto.
  async syncRedirects() {
    throw new Error(NOT_IMPLEMENTED);
  },
  async readLiveFiles() {
    throw new Error(NOT_IMPLEMENTED);
  },
  async publishPluginData() {
    throw new Error(NOT_IMPLEMENTED);
  },
};
