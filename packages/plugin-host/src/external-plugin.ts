// SPDX-License-Identifier: MPL-2.0

import { externalArtifactDigest, validatePlugin } from "@caelo-cms/plugin-sandbox";
import type { PluginContext, PluginDefinition } from "@caelo-cms/plugin-sdk";
/** Load external definitions as RPC proxies; source is never imported by the Bun host. */
import { z } from "zod";
import type { PluginHostInfra } from "./dispatch.js";
import { assertExternalApproval, type ExternalApproval } from "./external-authorization.js";
import { publicOperationFromManifest } from "./manifest-definition.js";
import { runSandbox } from "./sandbox-runtime.js";

/** Build a definition containing host-generated handlers for only the reviewed operation names. */
export function externalPluginDefinition(opts: {
  readonly pluginId: string;
  readonly approval: ExternalApproval;
  readonly manifest: unknown;
  readonly source: string;
  readonly infra: PluginHostInfra;
  readonly systemActorId: string;
}): PluginDefinition<PluginContext> {
  const validation = validatePlugin({
    manifest: opts.manifest,
    source: opts.source,
    allowExternalCapabilities: true,
    // #1720 — an approved artifact loads; a worker cron croner refuses is
    // recorded for that worker by the scheduler, not a reason to refuse it.
    workerCron: "record",
  });
  if (!validation.ok || !validation.manifest || validation.manifest.tier !== 2) {
    throw new Error(`ExternalPluginRejected: ${validation.failures.map((f) => f.hint).join("; ")}`);
  }
  const manifest = validation.manifest;
  for (const tool of manifest.tools ?? []) z.fromJSONSchema(tool.inputJsonSchema);
  for (const capability of manifest.requestedCapabilities ?? []) {
    if (
      ![
        "cms_admin_schema",
        "chat_runner_tools",
        "companion_skills",
        "font_assets",
        "private_files",
        "image_generation",
        "site_media_read",
        "consent_provider",
        // Epic #1644 — brokered by the sandbox (collections) or delivered
        // as arguments (page output); a batch runs in the same sandbox in a job.
        "collections",
        "page_output",
        "batch_jobs",
        // #1654 — no broker: the gateway runs the declared conversation itself.
        "visitor_ai",
      ].includes(capability)
    )
      throw new Error(`External capability broker unavailable: ${capability}`);
  }
  if (externalArtifactDigest(opts.manifest, opts.source) !== opts.approval.artifactDigest)
    throw new Error("ExternalPluginArtifactMismatch");
  const authorize = () =>
    assertExternalApproval(
      { pluginId: opts.pluginId, externalApproval: opts.approval },
      opts.infra,
    );
  const invoke = (operation: string) => (context: PluginContext, args: unknown) =>
    runSandbox({
      source: opts.source,
      manifest,
      operation,
      args,
      context,
      authorize,
      timeoutMs: manifest.requestedCapabilities?.includes("image_generation") ? 240_000 : 30_000,
    });
  return Object.freeze({
    slug: manifest.slug,
    version: manifest.version,
    tier: 2,
    schema: manifest.schema,
    adminSchema: manifest.adminSchema,
    // #1292 — reviewed manifest data: the broker refuses reads no index covers.
    ...(manifest.indexes ? { indexes: manifest.indexes } : {}),
    // #1387 — reviewed manifest data: what the host may show the AI of a row.
    ...(manifest.aiReadableTables ? { aiReadableTables: manifest.aiReadableTables } : {}),
    requestedCapabilities: manifest.requestedCapabilities,
    tools: manifest.tools,
    skills: manifest.skills,
    operations: Object.freeze(
      Object.fromEntries(manifest.operations.map((name) => [name, invoke(name)])),
    ),
    // #1332 — the reviewed contract, with the input schema compiled from
    // the manifest's JSON Schema: the host validates a visitor's body
    // before the sandbox ever sees it.
    ...(manifest.publicOperations
      ? { publicOperations: manifest.publicOperations.map(publicOperationFromManifest) }
      : {}),
    ...(manifest.tableKinds ? { tableKinds: manifest.tableKinds } : {}),
    ...(manifest.requires ? { requires: manifest.requires } : {}),
    // Admin panels are reviewed manifest data: an installed plugin gets
    // the same admin pages a shipped one declares (one plugin model).
    ...(manifest.adminPanels ? { adminPanels: manifest.adminPanels } : {}),
    // The editor toolbar items are reviewed manifest data the same way.
    ...(manifest.editorToolbar ? { editorToolbar: manifest.editorToolbar } : {}),
    requiresPlugins: manifest.requiresPlugins,
    consentPurposes: manifest.consentPurposes,
    // Epic #1107 — the Stage-audit hook is a manifest field, so a
    // runtime-installed plugin contributes findings like a shipped one.
    ...(manifest.auditFindingsOperation
      ? { auditFindingsOperation: manifest.auditFindingsOperation }
      : {}),
    // #1155 — reviewed manifest data, carried like the panels.
    ...(manifest.bakedData ? { bakedData: manifest.bakedData } : {}),
    ...(manifest.writeHintsOperation ? { writeHintsOperation: manifest.writeHintsOperation } : {}),
    ...(manifest.changeConsumer ? { changeConsumer: manifest.changeConsumer } : {}),
    ...(manifest.hasStaticRender
      ? { staticRender: invoke("$staticRender") as PluginDefinition["staticRender"] }
      : {}),
    // Epic #1644 — reviewed manifest data: an installed plugin keeps
    // configuration, collections, page output and batch jobs like a shipped
    // one (one plugin model); its observer and batch code run in the sandbox.
    ...(manifest.config ? { config: manifest.config } : {}),
    ...(manifest.entityConfig ? { entityConfig: manifest.entityConfig } : {}),
    ...(manifest.configPreviewOperation
      ? { configPreviewOperation: manifest.configPreviewOperation }
      : {}),
    ...(manifest.collections ? { collections: manifest.collections } : {}),
    ...(manifest.collectionOperations
      ? { collectionOperations: manifest.collectionOperations }
      : {}),
    // #1654 — a declaration the gateway runs with core code, like collections.
    ...(manifest.aiChatOperations ? { aiChatOperations: manifest.aiChatOperations } : {}),
    ...(manifest.pageOutputObserver ? { pageOutputObserver: manifest.pageOutputObserver } : {}),
    ...(manifest.batchOperations ? { batchOperations: manifest.batchOperations } : {}),
  });
}
