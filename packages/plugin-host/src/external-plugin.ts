// SPDX-License-Identifier: MPL-2.0

/** Load external definitions as RPC proxies; source is never imported by the Bun host. */
import { externalArtifactDigest, validatePlugin } from "@caelo-cms/plugin-sandbox";
import type { PluginContext, PluginDefinition } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import type { PluginHostInfra } from "./dispatch.js";
import { runSandbox } from "./sandbox-runtime.js";

/** Build a definition containing host-generated handlers for only the reviewed operation names. */
export function externalPluginDefinition(opts: {
  readonly manifest: unknown;
  readonly source: string;
  readonly infra: PluginHostInfra;
  readonly systemActorId: string;
}): PluginDefinition<PluginContext> {
  const validation = validatePlugin({ manifest: opts.manifest, source: opts.source });
  if (!validation.ok || !validation.manifest || validation.manifest.tier !== 2) {
    throw new Error(`ExternalPluginRejected: ${validation.failures.map((f) => f.hint).join("; ")}`);
  }
  const manifest = validation.manifest;
  const digest = externalArtifactDigest(opts.manifest, opts.source);
  const authorize = async () => {
    const result = await execute(
      opts.infra.registry,
      opts.infra.adapter,
      {
        actorId: opts.systemActorId,
        actorKind: "system",
        requestId: `external-plugin-${manifest.slug}`,
      },
      "plugins.get",
      { slug: manifest.slug },
    );
    if (!result.ok) throw new Error("ExternalPluginAuthorizationUnavailable");
    const row = (
      result.value as {
        plugin: { status: string; sourceCode: string; manifestJson: unknown } | null;
      }
    ).plugin;
    if (
      row?.status !== "active" ||
      externalArtifactDigest(row.manifestJson, row.sourceCode) !== digest
    ) {
      throw new Error(
        "ExternalPluginApprovalChanged: activate the reviewed version before running it",
      );
    }
  };
  const invoke = (operation: string) => (context: PluginContext, args: unknown) =>
    runSandbox({ source: opts.source, manifest, operation, args, context, authorize });
  return Object.freeze({
    slug: manifest.slug,
    version: manifest.version,
    tier: 2,
    schema: manifest.schema,
    operations: Object.freeze(
      Object.fromEntries(manifest.operations.map((name) => [name, invoke(name)])),
    ),
    publicOperations: manifest.publicOperations,
    ...(manifest.hasStaticRender
      ? { staticRender: invoke("$staticRender") as PluginDefinition["staticRender"] }
      : {}),
  });
}
