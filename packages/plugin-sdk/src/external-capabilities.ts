// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — which capabilities a runtime-installed (external) plugin can be
 * granted today, as ONE record: the host's load-time allowlist, the refusal
 * at submission and approval, the AI's `submit_plugin` text and the parity
 * test (`plugin-host/src/external-capability-parity.test.ts`) all read it,
 * so a capability is either brokered for external plugins or tracked by an
 * issue, and nothing in between (docs/dev/external-plugin-brokers.md).
 *
 * A `Record` over the enum: a new capability does not compile without an
 * entry, the same pattern as `PLUGIN_CAPABILITY_INFO`.
 */

import { PLUGIN_CAPABILITY_INFO } from "./capability-info.js";
import type { PluginCapability, PluginManifest } from "./index.js";
import { EXTERNAL_URL_SLOTS } from "./url-tables.js";

/** Whether the sandbox broker serves a capability, or the issue that will make it. */
export type ExternalCapabilityStatus =
  | {
      readonly status: "brokered";
      /**
       * What of the capability a runtime-installed plugin gets, when that is
       * less than a shipped plugin's in-process code can do (`url_slots`:
       * the slots data can describe). Shown with the capability wherever
       * the record lists what can be requested.
       */
      readonly only?: string;
    }
  | { readonly status: "planned"; readonly issue: number };

const BROKERED: ExternalCapabilityStatus = Object.freeze({ status: "brokered" });
/** Until each capability has an issue of its own, the epic tracks it. */
const PLANNED: ExternalCapabilityStatus = Object.freeze({ status: "planned", issue: 1729 });

/** The status of every capability for a runtime-installed plugin. */
export const EXTERNAL_CAPABILITY_STATUS: Readonly<
  Record<PluginCapability, ExternalCapabilityStatus>
> = Object.freeze({
  cms_admin: BROKERED,
  cms_admin_schema: BROKERED,
  ai_provider: BROKERED,
  chat_runner_tools: BROKERED,
  background_workers: BROKERED,
  change_journal: BROKERED,
  email: BROKERED,
  head_contributions: PLANNED,
  // #1729 (decision Q7 A) — the slots data can describe, read by the host.
  url_slots: Object.freeze({
    status: "brokered",
    only: `slots ${EXTERNAL_URL_SLOTS.join(" and ")} only, declared as urlTables`,
  }),
  client_assets: PLANNED,
  list_sources: BROKERED,
  list_types: BROKERED,
  list_resolve: BROKERED,
  companion_skills: BROKERED,
  font_assets: BROKERED,
  private_files: BROKERED,
  image_generation: BROKERED,
  site_media_read: BROKERED,
  content_variants: PLANNED,
  link_resolve: BROKERED,
  consent_provider: BROKERED,
  page_output: BROKERED,
  collections: BROKERED,
  batch_jobs: BROKERED,
  visitor_ai: BROKERED,
});

/**
 * The manifest fields that need each capability: what a refusal tells the
 * author to remove with it, and what the parity test checks the external
 * definition carries once the capability is brokered. A capability with no
 * field of its own (a handle such as `ai_provider`) maps to none.
 */
export const CAPABILITY_MANIFEST_FIELDS: Readonly<
  Record<PluginCapability, ReadonlyArray<keyof PluginManifest>>
> = Object.freeze({
  cms_admin: [],
  cms_admin_schema: ["adminSchema"],
  ai_provider: [],
  chat_runner_tools: ["tools"],
  background_workers: ["workers"],
  change_journal: ["changeConsumer"],
  email: ["mailTemplates", "mailUnsubscribe"],
  head_contributions: ["contributes", "hasShareImages"],
  url_slots: ["urlContributions", "urlTables"],
  client_assets: ["hasBuildAssets", "hasDeferrals"],
  list_sources: ["listSources"],
  list_types: ["listTypes"],
  list_resolve: ["hasListResolve"],
  companion_skills: ["skills"],
  font_assets: [],
  private_files: [],
  image_generation: [],
  site_media_read: [],
  content_variants: ["hasContentVariants"],
  link_resolve: ["hasLinkResolve", "linkResolveReads"],
  consent_provider: [],
  page_output: ["pageOutputObserver"],
  collections: ["collections", "collectionOperations"],
  batch_jobs: ["batchOperations"],
  visitor_ai: ["aiChatOperations"],
});

/** Whether a runtime-installed plugin can be granted `capability` today. */
export function isExternallyBrokered(capability: PluginCapability): boolean {
  return EXTERNAL_CAPABILITY_STATUS[capability].status === "brokered";
}

/** The capabilities a runtime-installed plugin can request, in enum order. */
export function externallyBrokeredCapabilities(): PluginCapability[] {
  return (Object.keys(EXTERNAL_CAPABILITY_STATUS) as PluginCapability[]).filter(
    isExternallyBrokered,
  );
}

/** A capability's name with what of it a runtime-installed plugin gets, when that is limited. */
function withLimit(capability: PluginCapability): string {
  const status = EXTERNAL_CAPABILITY_STATUS[capability];
  return status.status === "brokered" && status.only
    ? `${capability} (${status.only})`
    : capability;
}

/**
 * The capabilities a runtime-installed plugin can request, each with its
 * limit (`url_slots (slots host and path-prefix only, declared as
 * urlTables)`), as one line for a refusal or a tool description.
 */
export function externallyRequestable(): string {
  return externallyBrokeredCapabilities().map(withLimit).join(", ");
}

/**
 * Why a runtime-installed plugin cannot request `capability`, worded for
 * the AI that submitted it: the capability, its issue, what to remove and
 * what it can request instead. Null when the capability is brokered.
 */
export function externalCapabilityRefusal(capability: PluginCapability): string | null {
  const status = EXTERNAL_CAPABILITY_STATUS[capability];
  if (status.status === "brokered") return null;
  const fields = CAPABILITY_MANIFEST_FIELDS[capability];
  const remove =
    fields.length === 0
      ? ""
      : ` and remove ${fields.map((f) => `\`${f}\``).join(", ")}, which ${fields.length === 1 ? "needs" : "need"} it`;
  return (
    `\`${capability}\` (${PLUGIN_CAPABILITY_INFO[capability].label}) is not available to runtime-installed plugins yet (#${status.issue}). ` +
    `Remove it from \`requestedCapabilities\`${remove}. ` +
    `Runtime-installed plugins can request: ${externallyRequestable()}.`
  );
}

/**
 * The hint for a manifest field that needs `capability`, on a submission
 * that requests no capabilities (`plugins.submit` / `plugins.revalidate`):
 * request the grant, or, when no runtime-installed plugin can have it,
 * {@link externalCapabilityRefusal}.
 */
export function externalCapabilityHint(
  capability: PluginCapability,
  field: keyof PluginManifest,
): string {
  return (
    externalCapabilityRefusal(capability) ??
    `\`${field}\` needs the \`${capability}\` grant: add it to \`requestedCapabilities\` with a reason in \`capabilityReasons\`. The plugin then waits for the Owner's installation review (submit it with submit_plugin).`
  );
}
