// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/provisioning — P14.
 *
 * Pulumi-driven self-hosted stack + cms-provision CLI helpers.
 *
 * Public surface:
 *   - generateCaddyfile(spec) → string
 *   - generateDockerCompose(spec) → string
 *   - generateBootstrapToken() → { token, expiresAt }
 *
 * The CLI (cli.ts) wires these into init / up / regenerate-caddy /
 * backup / restore / status sub-commands. The Pulumi stack files
 * (stacks/self-hosted/*) are imported by the CLI's `up` path and
 * declare the actual Docker resources.
 */

export type {
  CloudAdapterInputs,
  CloudAdapterOutputs,
  DnsRecord,
  Environment,
  ProvisioningOutputsJson,
  SupportedProvider,
} from "./adapter.js";
export type {
  AgentDbConnection,
  AgentHeartbeat,
  AgentQueue,
  OpenAgentQueue,
  OpenedAgentQueue,
} from "./agent/queue.js";
export {
  type BootstrapToken,
  generateBootstrapToken,
} from "./bootstrap-token.js";
export {
  type CaddyDomainSpec,
  type CaddyfileSpec,
  generateCaddyfile,
} from "./caddy.js";
export {
  type CdnCopyAdapter,
  loadCdnCopyAdapter,
  selfHostedCdnCopy,
} from "./cdn-copy.js";
export { type ComposeSpec, generateDockerCompose, type RolePasswords } from "./compose.js";
export { INFRA_CONTRACT_VERSION } from "./infra-contract.js";
export {
  type CloudFrontRedirectArtifact,
  emitRedirectsAzureFrontDoor,
  emitRedirectsCloudFront,
  emitRedirectsCloudflare,
  type FrontDoorRule,
  type RedirectRow,
  type RedirectStatusCode,
} from "./redirects-emit.js";
export {
  INFRA_CONTRACT_PATHS,
  isInfraContractPath,
  RELEASE_MIN_FROM_VERSION,
} from "./release-contract.js";
export {
  assessAutoInstall,
  channelForVersion,
  compareImageDigests,
  compareSemver,
  type DigestMismatch,
  fetchVerifiedReleaseManifest,
  type InstallAssessment,
  type InstalledRelease,
  type InstallMode,
  RELEASE_CHANNELS,
  RELEASE_IMAGES,
  RELEASE_MANIFEST_ARTIFACT_TYPE,
  RELEASE_MANIFEST_MEDIA_TYPE,
  RELEASE_MANIFEST_REGISTRY,
  RELEASE_MANIFEST_REPOSITORY,
  RELEASE_OIDC_ISSUER,
  type ReleaseChannel,
  type ReleaseImage,
  type ReleaseManifest,
  type ReleaseManifestDeps,
  type ReleaseManifestError,
  type ReleaseManifestErrorCode,
  type ReleaseManifestResult,
  ReleaseManifestSchema,
  releaseManifestSignerIdentity,
  SIGSTORE_BUNDLE_MEDIA_TYPE,
} from "./release-manifest.js";
export { AGENT_DB_ROLE, roleConvergenceScript } from "./self-hosted-roles.js";
export {
  assessUpgradeRequest,
  type InstalledState,
  type RefusalCode,
  type RequestDecision,
} from "./upgrader-assess.js";
export {
  gcpUpgraderDeps,
  type UpgraderPlacement,
  upgraderDatabaseHost,
} from "./upgrader-gcp.js";
export {
  type ClaimedUpdate,
  runUpgraderJob,
  type UpdateEnd,
  type UpdateEndStatus,
  type UpdateFacts,
  type UpdateQueue,
  type UpgraderJobDeps,
  type UpgraderRunResult,
} from "./upgrader-job.js";
export type { JobLog } from "./upgrader-reporter.js";
