// SPDX-License-Identifier: MPL-2.0

/**
 * P15 — shared cloud-provider adapter contract.
 *
 * Every per-provider Pulumi stack at `packages/provisioning/stacks/<provider>/`
 * exports a `provision(inputs: CloudAdapterInputs): CloudAdapterOutputs`
 * function. The Caelo runtime never knows which provider it's running
 * on — it just consumes the connection strings + URLs the adapter
 * publishes via `CloudAdapterOutputs`. This keeps the per-provider
 * surface small (~6 capabilities, see master plan) and the runtime
 * provider-agnostic.
 *
 * Pulumi types are intentionally NOT imported here so that callers
 * outside the Pulumi runtime (e.g. the cms-provision CLI, the admin
 * app's DNS-guidance page) can consume the *plain* shape without
 * dragging in the @pulumi/pulumi peer dep. Per-stack `index.ts` files
 * narrow the output type to `pulumi.Output<T>` at their boundary.
 */

export type Environment = "dev" | "staging" | "production";
export type LocaleStrategy = "subdirectory" | "subdomain" | "domain";

export interface LocaleConfig {
  /** ISO code, e.g. "en", "de", "fr-CA". */
  readonly code: string;
  /** URL strategy. Mixed strategies in one install are explicitly supported. */
  readonly strategy: LocaleStrategy;
  /** Required when strategy is "subdomain" or "domain"; ignored for "subdirectory". */
  readonly host?: string;
}

export interface CloudAdapterInputs {
  /** Primary domain (e.g. example.com). Admin + production public both bind here. */
  readonly domain: string;
  /** Operator email used for ACME / cert provisioning + Pulumi notifications. */
  readonly ownerEmail: string;
  /** Three-env model (CMS_REQUIREMENTS §16.5). Cloud installs always provision all three. */
  readonly environments: ReadonlyArray<Environment>;
  /** Per-locale routing config — drives per-domain cert + DNS guidance + edge routing. */
  readonly locales: ReadonlyArray<LocaleConfig>;
  /** Optional pre-existing secret references (e.g. from a CI secrets manager). */
  readonly preProvisionedSecrets?: {
    readonly anthropicApiKey?: string;
    readonly resendApiKey?: string;
  };
}

/**
 * DNS records the operator must create at their registrar to make the
 * install reachable. Surfaced in the admin's /security/dns page with
 * live resolver status badges.
 */
export interface DnsRecord {
  readonly hostname: string; // e.g. "de.example.com"
  readonly type: "A" | "AAAA" | "CNAME" | "TXT";
  readonly value: string; // the value the operator's registrar must hold
  readonly purpose: string; // human-readable description
}

/**
 * Plain-data adapter outputs. Per-stack code wraps each field in
 * `pulumi.Output<…>` at the Pulumi boundary, but the *shape* is shared
 * across providers so the cms-provision CLI + the DNS UI can consume
 * any provider's outputs uniformly.
 */
export interface CloudAdapterOutputs {
  /** DSN for cms_admin role (encrypted in Pulumi state). */
  readonly adminDatabaseUrl: string;
  /** DSN for cms_public role (encrypted in Pulumi state). */
  readonly publicDatabaseUrl: string;
  /** Provider-native blob URL (s3://, gs://, https://<account>.blob.core.windows.net/<container>). */
  readonly mediaStorageUrl: string;
  /** Public-facing URL the admin reaches for media reads. */
  readonly mediaCdnBaseUrl: string;
  /** Bootstrap-token URL — operator opens this once after `pulumi up`. */
  readonly bootstrapUrl: string;
  /** DNS records consumed by the admin's DNS-guidance page. */
  readonly dnsRecordsRequired: ReadonlyArray<DnsRecord>;
  /**
   * Where edge-A/B assignment logs land — read by the P12A analytics plugin's
   * provider-specific log adapter. Provider-native sink URL (BigQuery dataset,
   * Athena database, Log Analytics workspace).
   */
  readonly edgeLogSinkUrl: string;
  /** Which provider produced these outputs — drives the analytics plugin's adapter dispatch. */
  readonly provider: SupportedProvider;
  /** Which environment this output snapshot represents. */
  readonly environment: Environment;
}

export type SupportedProvider = "self-hosted" | "gcp" | "gcp-firebase" | "aws" | "azure";

/**
 * Convenience: the shape persisted in `cms_admin.provisioning_outputs.outputs_json`.
 * Pulumi runs the adapter, the CLI's `pulumi-output-sync` subcommand reads
 * `pulumi stack output --json`, hashes the result, and writes a row keyed on
 * (provider, environment) so the admin UI can read without provider creds.
 */
export interface ProvisioningOutputsJson {
  readonly outputs: CloudAdapterOutputs;
  readonly syncedAt: string; // ISO timestamp
}
