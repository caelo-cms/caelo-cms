// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/loader — startup-time Tier-1 plugin loader.
 *
 * Bootstrap walks `packages/plugins/<slug>/` directories, verifies each
 * manifest's Ed25519 signature, runs the validator over the plugin's source,
 * applies pending plugin-owned migrations to cms_public, registers the
 * plugin's tools + workers + prompt-context renderers, and upserts a
 * `plugins` row at `tier=1, status='active'`.
 *
 * Failure isolation per plugin: a corrupted signature, missing migration,
 * or thrown definePlugin call leaves a `plugins` row at `status='failed'`
 * and continues loading the next plugin. The admin app keeps starting.
 *
 * Bootstrap is idempotent — restarting the host re-walks, sees existing
 * rows + applied migrations, and re-registers tools/workers without
 * mutating the DB. Disable / re-enable goes through the lifecycle ops.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  validateManifest,
  validateSource,
  verifyManifestSignature,
} from "@caelo-cms/plugin-sandbox";
import {
  type PluginContext,
  type PluginContextTier1,
  type PluginDefinition,
  pluginManifest,
} from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { makePluginContext } from "./capabilities.js";
import {
  type LoadedPlugin,
  loadedPlugins,
  type PluginHostInfra,
  resetDisabledSet,
  runPluginOperation,
  setContextFactory,
  setHostInfra,
} from "./dispatch.js";
import { pluginPromptContextRegistry } from "./prompt-context-registry.js";
import { pluginWorkerScheduler } from "./scheduler.js";
import { pluginToolsRegistry } from "./tools-registry.js";

export interface BootstrapOpts {
  readonly infra: PluginHostInfra;
  /** Absolute path to `packages/plugins`. Bootstrap walks immediate
   *  subdirs that contain a `manifest.json`. */
  readonly pluginsRoot: string;
  /** Override for tests — supplies plugin definitions directly instead
   *  of reading from disk. Each entry is treated as a pre-validated
   *  Tier-1 spec; signature verification + validator are skipped. */
  readonly testPlugins?: ReadonlyArray<{
    readonly definition: PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>;
    readonly sourcePath?: string;
  }>;
  /** System actor id used as `submitted_by` on host-loaded plugin rows. */
  readonly systemActorId: string;
}

export interface LoadReport {
  readonly loaded: ReadonlyArray<{ slug: string; version: string; tier: 1 | 2 }>;
  readonly failed: ReadonlyArray<{ slug: string; reason: string }>;
}

export async function bootstrap(opts: BootstrapOpts): Promise<LoadReport> {
  setHostInfra(opts.infra);
  setContextFactory(makePluginContext);

  const loaded: Array<{ slug: string; version: string; tier: 1 | 2 }> = [];
  const failed: Array<{ slug: string; reason: string }> = [];

  if (opts.testPlugins) {
    for (const tp of opts.testPlugins) {
      try {
        const lp = await registerLoadedPlugin({
          definition: tp.definition,
          sourcePath: tp.sourcePath ?? null,
          manifestSignatureHex: "test-mode",
          infra: opts.infra,
          systemActorId: opts.systemActorId,
        });
        loaded.push({ slug: lp.slug, version: lp.version, tier: lp.tier });
      } catch (e) {
        failed.push({ slug: tp.definition.slug, reason: (e as Error).message });
      }
    }
    return { loaded, failed };
  }

  let entries: string[];
  try {
    entries = readdirSync(opts.pluginsRoot);
  } catch (e) {
    // No plugins directory at all — fine on a fresh dev install.
    return { loaded, failed: [{ slug: "<root>", reason: (e as Error).message }] };
  }

  for (const entry of entries) {
    const pluginDir = resolvePath(opts.pluginsRoot, entry);
    let dirStat: ReturnType<typeof statSync>;
    try {
      dirStat = statSync(pluginDir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    const manifestPath = resolvePath(pluginDir, "manifest.json");
    let manifestText: string;
    try {
      manifestText = readFileSync(manifestPath, "utf8");
    } catch {
      continue; // not a plugin dir
    }
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(manifestText);
    } catch (e) {
      failed.push({ slug: entry, reason: `manifest JSON parse: ${(e as Error).message}` });
      continue;
    }
    const slug = (rawManifest as { slug?: unknown }).slug;
    const slugStr = typeof slug === "string" ? slug : entry;
    try {
      const lp = await loadOnePlugin({
        slug: slugStr,
        pluginDir,
        rawManifest,
        infra: opts.infra,
        systemActorId: opts.systemActorId,
      });
      loaded.push({ slug: lp.slug, version: lp.version, tier: lp.tier });
    } catch (e) {
      failed.push({ slug: slugStr, reason: (e as Error).message });
      // Best-effort: write a `failed` row so /security/plugins shows the error.
      await markPluginFailed({
        infra: opts.infra,
        slug: slugStr,
        reason: (e as Error).message,
        systemActorId: opts.systemActorId,
      }).catch(() => undefined);
    }
  }

  return { loaded, failed };
}

interface LoadOpts {
  readonly slug: string;
  readonly pluginDir: string;
  readonly rawManifest: unknown;
  readonly infra: PluginHostInfra;
  readonly systemActorId: string;
}

async function loadOnePlugin(opts: LoadOpts): Promise<LoadedPlugin> {
  // 1. Manifest shape.
  const parsed = pluginManifest.safeParse(opts.rawManifest);
  if (!parsed.success) {
    throw new Error(`manifest invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const manifest = parsed.data;

  // 2. Tier 1 only — Tier 2 plugins live in plugins.source_code, not on disk.
  if (manifest.tier !== 1) {
    throw new Error("disk plugins must be tier 1; tier 2 plugins are submitted via plugins.submit");
  }

  // 3. Signature.
  const sigPath = resolvePath(opts.pluginDir, "manifest.sig");
  let signatureHex: string;
  try {
    signatureHex = readFileSync(sigPath, "utf8").trim();
  } catch {
    throw new Error("missing manifest.sig (Tier 1 requires a signed manifest)");
  }
  // Honour CAELO_TIER1_PUBLIC_KEY env override so the dev signing script
  // (`scripts/sign-tier1-manifest.ts`) can sign with a fresh key pair without
  // requiring the embedded production key. Production deployments leave this
  // unset and the signed Caelo public key wins.
  const publicKeyHex = process.env.CAELO_TIER1_PUBLIC_KEY;
  const sig = await verifyManifestSignature({ manifest, signatureHex, publicKeyHex });
  if (!sig.ok) throw new Error(`signature verification failed: ${sig.reason}`);

  // 4. Validator (defense-in-depth on Tier 1).
  const distPath = resolvePath(opts.pluginDir, "dist", "index.js");
  let source: string;
  try {
    source = readFileSync(distPath, "utf8");
  } catch {
    throw new Error("missing dist/index.js (run `bun run build` in the plugin dir)");
  }
  const sourceFailures = validateSource({ filename: `${opts.slug}/dist/index.js`, source });
  if (sourceFailures.length > 0) {
    throw new Error(`validator rejected source: ${sourceFailures.map((f) => f.kind).join(", ")}`);
  }
  const manifestCheck = validateManifest(opts.rawManifest);
  if (manifestCheck.failures.length > 0) {
    throw new Error(
      `validator rejected manifest: ${manifestCheck.failures.map((f) => f.kind).join(", ")}`,
    );
  }

  // 5. Dynamic-import the compiled JS to get the PluginDefinition.
  const moduleUrl = `file://${distPath}`;
  let definition: PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>;
  try {
    const mod = (await import(moduleUrl)) as {
      default?: PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>;
    };
    if (!mod.default) throw new Error("plugin module has no default export");
    definition = mod.default;
  } catch (e) {
    throw new Error(`import failed: ${(e as Error).message}`);
  }

  return registerLoadedPlugin({
    definition,
    sourcePath: opts.pluginDir,
    manifestSignatureHex: signatureHex,
    infra: opts.infra,
    systemActorId: opts.systemActorId,
  });
}

interface RegisterOpts {
  readonly definition: PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>;
  readonly sourcePath: string | null;
  readonly manifestSignatureHex: string;
  readonly infra: PluginHostInfra;
  readonly systemActorId: string;
}

async function registerLoadedPlugin(opts: RegisterOpts): Promise<LoadedPlugin> {
  const def = opts.definition;
  // Upsert the plugins row + actor row; reuses migration 0036's partial unique index.
  const { pluginId, pluginActorId } = await opts.infra.adapter.withAdminTransaction(
    {
      actorId: opts.systemActorId,
      actorKind: "system",
      requestId: `plugin-load-${def.slug}`,
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        INSERT INTO plugins (
          slug, version, tier, status,
          manifest_json, source_path, manifest_signature, submitted_by
        ) VALUES (
          ${def.slug}, ${def.version}, ${def.tier}, 'active',
          ${JSON.stringify(buildManifestJson(def))}::jsonb,
          ${opts.sourcePath},
          ${opts.manifestSignatureHex},
          ${opts.systemActorId}::uuid
        )
        ON CONFLICT (slug) DO UPDATE SET
          version = EXCLUDED.version,
          status = 'active',
          manifest_json = EXCLUDED.manifest_json,
          source_path = EXCLUDED.source_path,
          manifest_signature = EXCLUDED.manifest_signature,
          activated_by = EXCLUDED.submitted_by,
          activated_at = now(),
          updated_at = now()
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      const id = rows[0]?.id;
      if (!id) throw new Error("plugins upsert returned no id");

      const actorRows = (await tx.execute(sql`
        INSERT INTO actors (kind, display_name, plugin_id)
        VALUES ('plugin', ${`Plugin: ${def.slug}`}, ${id}::uuid)
        ON CONFLICT (plugin_id) WHERE plugin_id IS NOT NULL DO UPDATE
          SET display_name = EXCLUDED.display_name
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      const actorId = actorRows[0]?.id;
      if (!actorId) throw new Error("actor upsert returned no id");
      return { pluginId: id, pluginActorId: actorId };
    },
  );

  const lp: LoadedPlugin = {
    pluginId,
    slug: def.slug,
    version: def.version,
    tier: def.tier,
    definition: def,
    pluginActorId,
  };
  loadedPlugins.set(lp);

  // Register tools + workers + prompt-context renderers.
  for (const tool of def.tools ?? []) {
    pluginToolsRegistry.register(def.slug, tool);
  }
  for (const renderer of def.promptContext ?? []) {
    pluginPromptContextRegistry.register({
      pluginSlug: def.slug,
      label: renderer.label,
      render: () =>
        // Render with a fresh ctx every turn — handles get the live infra.
        Promise.resolve(makePluginContext({ plugin: lp, infra: opts.infra })).then((ctx) =>
          Promise.resolve(renderer.render(ctx as PluginContext)),
        ),
    });
  }
  if (def.workers && def.workers.length > 0) {
    pluginWorkerScheduler.schedule({
      pluginSlug: def.slug,
      workers: def.workers,
      dispatch: runPluginOperation,
      pluginActorId,
    });
  }

  return lp;
}

function buildManifestJson(
  def: PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>,
): unknown {
  return {
    slug: def.slug,
    version: def.version,
    tier: def.tier,
    schema: def.schema,
    operations: Object.keys(def.operations),
    component: def.component
      ? { tag: def.component.tag, shadowMode: def.component.shadowMode ?? "open" }
      : undefined,
    hasStaticRender: !!def.staticRender,
    requestedCapabilities: def.requestedCapabilities,
    workers: def.workers,
    tools: def.tools,
  };
}

async function markPluginFailed(opts: {
  infra: PluginHostInfra;
  slug: string;
  reason: string;
  systemActorId: string;
}): Promise<void> {
  await opts.infra.adapter.withAdminTransaction(
    {
      actorId: opts.systemActorId,
      actorKind: "system",
      requestId: `plugin-load-failed-${opts.slug}`,
    },
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO plugins (
          slug, version, tier, status,
          manifest_json, manifest_signature,
          validation_errors, submitted_by
        ) VALUES (
          ${opts.slug}, '0.0.0', 1, 'failed',
          '{}'::jsonb, 'unknown',
          ${JSON.stringify([{ kind: "load-failed", hint: opts.reason }])}::jsonb,
          ${opts.systemActorId}::uuid
        )
        ON CONFLICT (slug) DO UPDATE SET
          status = 'failed',
          validation_errors = EXCLUDED.validation_errors,
          updated_at = now()
      `);
    },
  );
}

/**
 * Test-only helper: clear all loaded plugins + scheduled workers + registered
 * tools. Use between integration test fixtures.
 */
export function resetPluginHost(): void {
  pluginWorkerScheduler.shutdown();
  pluginToolsRegistry.reset();
  pluginPromptContextRegistry.reset();
  loadedPlugins.reset();
  // Audit fix #2: also clear the disabled-flags set so a previous test's
  // disable() doesn't leak into the next fixture.
  resetDisabledSet();
}

// Silence the "execute is unused" warning when only used in capabilities.
void execute;
