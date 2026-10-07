// SPDX-License-Identifier: MPL-2.0

/**
 * Approval state of an externally installed plugin (CMS_REQUIREMENTS
 * §14.5): the exact artifact an Owner approved and the capability
 * receipts issued for it. A manifest declaration grants nothing; only
 * active, unrevoked receipts for the running artifact's digest do.
 *
 * Reads go through the `plugin_external.*` operations (external-ops.ts).
 * The check that must serialise with revocation — "may this write
 * happen" — runs inside each private storage operation's own
 * transaction (private-storage.ts), not here.
 */

import { validateSelectedGrants } from "@caelo-cms/plugin-sandbox";
import { type PluginCapability, pluginManifest } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import { EXTERNAL_OPS, registerExternalPluginOps } from "./external-ops.js";

export interface ExternalApproval {
  readonly artifactDigest: string;
  readonly grantIds: readonly string[];
  readonly capabilities: readonly PluginCapability[];
  readonly systemActorId: string;
}

interface ApprovalState {
  readonly active: boolean;
  readonly artifactDigest: string | null;
  readonly manifest: unknown;
  readonly grants: readonly { id: string; capability: string }[];
}

async function approvalState(
  infra: PluginHostInfra,
  systemActorId: string,
  pluginId: string,
): Promise<ApprovalState> {
  registerExternalPluginOps(infra.registry);
  const r = await execute(
    infra.registry,
    infra.adapter,
    { actorId: systemActorId, actorKind: "system", requestId: "external-plugin-approval" },
    EXTERNAL_OPS.approval,
    { pluginId },
  );
  if (!r.ok) throw new Error("ExternalPluginAuthorizationUnavailable");
  return r.value as ApprovalState;
}

/**
 * Fail unless the loaded approval still holds: the plugin is active, runs
 * the approved artifact, and exactly the receipts it was loaded with are
 * still unrevoked. Called before each sandbox step.
 */
export async function assertExternalApproval(
  plugin: Pick<LoadedPlugin, "pluginId" | "externalApproval">,
  infra: PluginHostInfra,
): Promise<void> {
  const approval = plugin.externalApproval;
  if (!approval) throw new Error("ExternalPluginApprovalMissing");
  const state = await approvalState(infra, approval.systemActorId, plugin.pluginId);
  if (!state.active || state.artifactDigest !== approval.artifactDigest) {
    throw new Error(
      "ExternalPluginApprovalChanged: activate the reviewed version before running it",
    );
  }
  const ids = state.grants.map((g) => g.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...approval.grantIds].sort())) {
    throw new Error("ExternalPluginGrantChanged");
  }
}

/** Read the approval a plugin is loaded with. Declarations alone grant nothing. */
export async function readExternalApproval(opts: {
  pluginId: string;
  manifest: unknown;
  infra: PluginHostInfra;
  systemActorId: string;
}): Promise<ExternalApproval> {
  const manifest = pluginManifest.parse(opts.manifest);
  const state = await approvalState(opts.infra, opts.systemActorId, opts.pluginId);
  if (!state.active || state.artifactDigest === null) {
    throw new Error(
      "ExternalPluginApprovalChanged: activate the reviewed version before running it",
    );
  }
  if (manifest.requestedCapabilities?.length) {
    validateSelectedGrants(
      manifest,
      state.grants.map((g) => g.capability as PluginCapability),
    );
  }
  return Object.freeze({
    artifactDigest: state.artifactDigest,
    grantIds: manifest.requestedCapabilities?.length ? state.grants.map((g) => g.id) : [],
    capabilities: manifest.requestedCapabilities ?? [],
    systemActorId: opts.systemActorId,
  });
}

/** Whether the human a call acts for holds `permission`. */
export async function operatorHasPermission(
  infra: PluginHostInfra,
  systemActorId: string,
  actorId: string,
  permission: "content.write" | "settings.write" | "deploy.trigger",
): Promise<boolean> {
  registerExternalPluginOps(infra.registry);
  const r = await execute(
    infra.registry,
    infra.adapter,
    { actorId: systemActorId, actorKind: "system", requestId: "external-plugin-operator" },
    EXTERNAL_OPS.operatorHasPermission,
    { actorId, permission },
  );
  return r.ok && (r.value as { allowed: boolean }).allowed;
}

/** Whether the human a call acts for may author content. */
export function operatorCanAuthor(
  infra: PluginHostInfra,
  systemActorId: string,
  actorId: string,
): Promise<boolean> {
  return operatorHasPermission(infra, systemActorId, actorId, "content.write");
}
