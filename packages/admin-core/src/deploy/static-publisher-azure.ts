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
 * Per CLAUDE.md §2 (no fallbacks pre-1.0): the stub throws loudly
 * with a pointer to the tracking issue.
 */

import type { StaticPublisher } from "./static-publisher.js";

const NOT_IMPLEMENTED =
  "Azure Blob static publisher not yet implemented. Stage / Confirm-publish on Azure Cloud installs is tracked for a future release; until then run on GCP, self-hosted, or wait for the Azure adapter. See https://github.com/caelo-cms/caelo-cms/issues for status.";

export const azureStaticPublisher: StaticPublisher = {
  async publishStaging() {
    throw new Error(NOT_IMPLEMENTED);
  },
  async promoteToProduction() {
    throw new Error(NOT_IMPLEMENTED);
  },
  async rollback() {
    throw new Error(NOT_IMPLEMENTED);
  },
};
