// SPDX-License-Identifier: MPL-2.0

import type { PluginCapability, PluginManifest } from "@caelo-cms/plugin-sdk";

/** Declaration checks are independent of origin verification and never confer a grant. */
export function validateInstallationPolicy(manifest: PluginManifest): void {
  const requested = new Set(manifest.requestedCapabilities ?? []);
  if (requested.size !== (manifest.requestedCapabilities ?? []).length)
    throw new Error("Duplicate capability request");
  const requireCapability = (present: boolean, capability: PluginCapability) => {
    if (present && !requested.has(capability))
      throw new Error(`Missing required capability request: ${capability}`);
  };
  requireCapability(Object.keys(manifest.adminSchema ?? {}).length > 0, "cms_admin_schema");
  requireCapability(Boolean(manifest.tools?.length), "chat_runner_tools");
  requireCapability(Boolean(manifest.workers?.length), "background_workers");
  requireCapability(Boolean(manifest.contributes?.length), "head_contributions");
  requireCapability(Boolean(manifest.urlContributions?.length), "url_slots");
  requireCapability(manifest.hasBuildAssets || manifest.hasDeferrals, "client_assets");
  requireCapability(Boolean(manifest.dataLists?.length), "data_lists");
  requireCapability(Boolean(manifest.skills?.length), "companion_skills");
  for (const capability of requested) {
    if (!manifest.capabilityReasons?.[capability])
      throw new Error(`Explain the requested ${capability} access`);
  }
  if (
    requested.has("cms_admin") &&
    !manifest.capabilityConstraints?.cms_admin?.operations?.length
  ) {
    throw new Error("cms_admin requires an explicit named-operation allowlist");
  }
  const operations = new Set(manifest.operations);
  if (operations.size !== manifest.operations.length) throw new Error("Duplicate operation name");
  for (const name of [
    ...(manifest.publicOperations ?? []),
    ...(manifest.tools ?? []).map((t) => t.operationName),
    ...(manifest.workers ?? []).map((w) => w.operationName),
  ]) {
    if (!operations.has(name)) throw new Error(`Undeclared operation: ${name}`);
  }
  const publicOperations = new Set(manifest.publicOperations ?? []);
  const toolOperations = new Set<string>();
  for (const tool of manifest.tools ?? []) {
    validateExternalToolSchema(tool.inputJsonSchema);
    if (toolOperations.has(tool.operationName))
      throw new Error("Tool operations must have exactly one tool declaration");
    toolOperations.add(tool.operationName);
    if (!tool.name.startsWith(`${manifest.slug.replaceAll("-", "_")}__`))
      throw new Error(
        `External tool names must start with ${manifest.slug.replaceAll("-", "_")}__`,
      );
    if (publicOperations.has(tool.operationName))
      throw new Error("Authoring tools cannot also be visitor operations");
  }
  for (const worker of manifest.workers ?? []) {
    if (publicOperations.has(worker.operationName))
      throw new Error("Workers cannot also be visitor operations");
  }
}

/** All requests are required in v1; declining one leaves the artifact pending. */
export function validateSelectedGrants(
  manifest: PluginManifest,
  selected: readonly PluginCapability[],
): void {
  validateInstallationPolicy(manifest);
  const requested = new Set(manifest.requestedCapabilities ?? []);
  if (
    new Set(selected).size !== selected.length ||
    selected.length !== requested.size ||
    selected.some((cap) => !requested.has(cap))
  ) {
    throw new Error("Select every requested capability explicitly, or leave this plugin inactive");
  }
}

/** External schemas are compiled in the host, so disallow executable regex/ref expansion. */
function validateExternalToolSchema(schema: Record<string, unknown>): void {
  if (JSON.stringify(schema).length > 32_000) throw new Error("External tool schema exceeds 32 KB");
  const keywords = new Set([
    "$schema",
    "title",
    "description",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "format",
  ]);
  let nodes = 0;
  function inspect(raw: unknown, depth: number): void {
    if (++nodes > 200 || depth > 12 || !raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Unsupported external tool schema shape");
    const value = raw as Record<string, unknown>;
    for (const key of Object.keys(value))
      if (!keywords.has(key))
        throw new Error(
          `Unsupported external tool schema keyword: ${key}; validate complex rules inside the sandbox`,
        );
    if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean")
      throw new Error("External additionalProperties must be boolean");
    if (
      value.format !== undefined &&
      !["uuid", "email", "uri", "date-time", "date"].includes(String(value.format))
    )
      throw new Error("Unsupported external tool string format");
    if (value.properties !== undefined) {
      if (
        !value.properties ||
        typeof value.properties !== "object" ||
        Array.isArray(value.properties)
      )
        throw new Error("Invalid schema properties");
      for (const child of Object.values(value.properties)) inspect(child, depth + 1);
    }
    if (value.items !== undefined) inspect(value.items, depth + 1);
  }
  inspect(schema, 0);
}
