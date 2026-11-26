// SPDX-License-Identifier: MPL-2.0

/**
 * Load external (runtime-installed) definitions as RPC proxies: the source
 * is never imported by the Bun host. The definition is built from the
 * reviewed manifest alone — its declarations are carried as data
 * ({@link externalDeclarations}) and every operation is a sandboxed call.
 */

import { externalArtifactDigest, validatePlugin } from "@caelo-cms/plugin-sandbox";
import {
  externalCapabilityRefusal,
  type PluginContext,
  type PluginDefinition,
  type PluginManifest,
} from "@caelo-cms/plugin-sdk";
import { z } from "zod";
import type { PluginHostInfra } from "./dispatch.js";
import { assertExternalApproval, type ExternalApproval } from "./external-authorization.js";
import { publicOperationFromManifest } from "./manifest-definition.js";
import { SANDBOX_KIND, type SandboxKind, type SandboxKindCarrier } from "./sandbox-kind.js";
import { runSandbox, SANDBOX_AI_INTERACTIVE_MS } from "./sandbox-runtime.js";

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
  // #1729 — the status record is the one list of what a runtime-installed
  // plugin can be granted; staging and approval refuse the rest first.
  for (const capability of manifest.requestedCapabilities ?? []) {
    const refusal = externalCapabilityRefusal(capability);
    if (refusal) throw new Error(`External capability broker unavailable: ${refusal}`);
  }
  if (externalArtifactDigest(opts.manifest, opts.source) !== opts.approval.artifactDigest)
    throw new Error("ExternalPluginArtifactMismatch");
  const authorize = () =>
    assertExternalApproval(
      { pluginId: opts.pluginId, externalApproval: opts.approval },
      opts.infra,
    );
  // An interactive call that may spend the install's AI waits on the model.
  const spendsAi = (manifest.requestedCapabilities ?? []).some(
    (c) => c === "image_generation" || c === "ai_provider",
  );
  const invoke = (operation: string) => (context: PluginContext, args: unknown) => {
    const kind = sandboxKindOf(context);
    return runSandbox({
      source: opts.source,
      manifest,
      operation,
      args,
      context,
      authorize,
      kind,
      ...(kind === "interactive" && spendsAi ? { timeoutMs: SANDBOX_AI_INTERACTIVE_MS } : {}),
    });
  };
  return Object.freeze({
    ...externalDeclarations(manifest),
    operations: Object.freeze(
      Object.fromEntries(manifest.operations.map((name) => [name, invoke(name)])),
    ),
    ...(manifest.hasStaticRender
      ? { staticRender: invoke("$staticRender") as PluginDefinition["staticRender"] }
      : {}),
  });
}

/**
 * What a call is for (#1729 Q10): the caller's explicit kind (a journal
 * batch, a rebuild chunk), else the invocation's origin. A render with a
 * `renderId` is one editor preview pass; any other render (a build, a Stage
 * audit, a link migration) has the build budget.
 */
export function sandboxKindOf(context: PluginContext): SandboxKind {
  const explicit = (context as PluginContext & SandboxKindCarrier)[SANDBOX_KIND];
  if (explicit) return explicit;
  switch (context.invocation.origin) {
    case "worker":
      return "worker";
    case "batch":
      return "batch";
    case "render":
      return context.invocation.renderId ? "preview" : "build";
    default:
      return "interactive";
  }
}

/** The manifest's declarations, as a definition carries them: data only, no operation. */
export type ExternalDeclarations = Omit<
  PluginDefinition<PluginContext>,
  "operations" | "staticRender"
>;

/**
 * Everything of a reviewed external manifest the host consumes as data,
 * mapped onto the definition shape a shipped plugin has (one plugin model).
 * Pure, so the parity test (`external-capability-parity.test.ts`) can check
 * that each brokered capability's manifest fields reach the definition.
 */
export function externalDeclarations(manifest: PluginManifest): ExternalDeclarations {
  return {
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
  };
}
