// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.78 — Azure Blob static publisher stub.
 *
 * Real implementation lands when the first install on Azure
 * Container Apps happens. Same shape as the GCS adapter, swapping
 * Azure Blob for GCS. Front Door cache purge optional via
 * `caelo-azure:invalidateCdnOnPublish`.
 *
 * Env vars expected (set by Azure Pulumi stack on the admin
 * Container App):
 *   - CAELO_STATIC_BUCKET (storage account container name)
 *   - CAELO_STAGING_BUCKET (storage account container name)
 *   - storage account credentials via DefaultAzureCredential.
 *
 * #587 — redirects: the real publisher must also replace the stack's Front Door rule set rules with the redirect plan (`buildRedirectPlan` → `frontDoorRedirectRules`, @caelo-cms/shared) after the files are live, or Azure installs answer every recorded 301 with a 404.
 * #1157 — and `syncRedirects` must replace the rule set rules on save, without a build, against the live build's files (see deploy/redirect-sync.ts).
 * FIXME(issue #750): implement with the publisher.
 *
 * Per CLAUDE.md §2 (no fallbacks pre-1.0): the stub throws loudly
 * with a pointer to the tracking issue.
 */

import type { StaticPublisher } from "./static-publisher.js";

const NOT_IMPLEMENTED =
  "Azure Blob static publisher not yet implemented. Stage / Confirm-publish on Azure Cloud installs is tracked for a future release; until then run on GCP, self-hosted, or wait for the Azure adapter. See https://github.com/caelo-cms/caelo-cms/issues for status.";

export const azureStaticPublisher: StaticPublisher = {
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
};
