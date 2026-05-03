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
  LocaleConfig,
  LocaleStrategy,
  ProvisioningOutputsJson,
  SupportedProvider,
} from "./adapter.js";
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
export { type ComposeSpec, generateDockerCompose } from "./compose.js";
export {
  type CloudFrontRedirectArtifact,
  emitRedirectsAzureFrontDoor,
  emitRedirectsCloudFront,
  emitRedirectsCloudflare,
  type FrontDoorRule,
  type RedirectRow,
  type RedirectStatusCode,
} from "./redirects-emit.js";
