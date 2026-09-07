// SPDX-License-Identifier: MPL-2.0

/** Load external definitions as RPC proxies; source is never imported by the Bun host. */
import { externalArtifactDigest, validatePlugin } from "@caelo-cms/plugin-sandbox";
import type { PluginContext, PluginDefinition } from "@caelo-cms/plugin-sdk";
import type { PluginHostInfra } from "./dispatch.js";
import { type ExternalApproval, withExternalAuthorization } from "./external-authorization.js";
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
  });
  if (!validation.ok || !validation.manifest || validation.manifest.tier !== 2) {
    throw new Error(`ExternalPluginRejected: ${validation.failures.map((f) => f.hint).join("; ")}`);
  }
  const manifest = validation.manifest;
  for (const capability of manifest.requestedCapabilities ?? []) {
    if (!["cms_admin_schema", "chat_runner_tools"].includes(capability))
      throw new Error(`External capability broker unavailable: ${capability}`);
  }
  if (externalArtifactDigest(opts.manifest, opts.source) !== opts.approval.artifactDigest)
    throw new Error("ExternalPluginArtifactMismatch");
  const authorize = () =>
    withExternalAuthorization(
      { pluginId: opts.pluginId, externalApproval: opts.approval },
      opts.infra,
      async () => {},
    );
  const invoke = (operation: string) => (context: PluginContext, args: unknown) =>
    runSandbox({ source: opts.source, manifest, operation, args, context, authorize });
  return Object.freeze({
    slug: manifest.slug,
    version: manifest.version,
    tier: 2,
    schema: manifest.schema,
    adminSchema: manifest.adminSchema,
    requestedCapabilities: manifest.requestedCapabilities,
    tools: manifest.tools,
    operations: Object.freeze(
      Object.fromEntries(manifest.operations.map((name) => [name, invoke(name)])),
    ),
    publicOperations: manifest.publicOperations,
    ...(manifest.hasStaticRender
      ? { staticRender: invoke("$staticRender") as PluginDefinition["staticRender"] }
      : {}),
  });
}
