// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/loader — startup-time Tier-1 plugin loader.
 *
 * Bootstrap walks `packages/plugins/<slug>/` directories, verifies each
 * manifest's Ed25519 signature, runs the validator over the plugin's source,
 * provisions the plugin's declared cms_public schema (idempotent DDL),
 * registers the plugin's tools + workers + prompt-context renderers, and
 * upserts a `plugins` row at `tier=1, status='active'`. There is NO
 * unverified load path (#387): the in-memory test override runs the same
 * validator + signature pipeline against an ephemeral trust root.
 *
 * Failure isolation per plugin: a corrupted signature, missing migration,
 * or thrown definePlugin call leaves a `plugins` row at `status='failed'`
 * and continues loading the next plugin. The admin app keeps starting.
 *
 * Bootstrap is idempotent — restarting the host re-walks, sees existing
 * rows + applied migrations, and re-registers tools/workers without
 * mutating the DB. Disable / re-enable goes through the lifecycle ops.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  generateManifestKeyPair,
  schemaFromSpec,
  signManifest,
  validateManifest,
  validateSource,
  verifyManifestSignature,
} from "@caelo-cms/plugin-sandbox";
import {
  manifestFromDefinition,
  type PluginContext,
  type PluginContextTier1,
  type PluginDefinition,
  type PluginManifest,
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
   *  of reading from disk. NOT a verification skip (#387): each entry's
   *  manifest is derived from the definition, validated, signed with an
   *  ephemeral in-process key, and signature-verified — the same code
   *  path production uses, with a per-bootstrap trust root instead of
   *  the release key. When `sourcePath` points at a dir with
   *  `dist/index.js`, the source validator runs too. */
  readonly testPlugins?: ReadonlyArray<{
    readonly definition: PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>;
    readonly sourcePath?: string;
  }>;
  /** System actor id used as `submitted_by` on host-loaded plugin rows. */
  readonly systemActorId: string;
  /** Trust root for manifest signature verification. Precedence:
   *  this option → `CAELO_TIER1_PUBLIC_KEY` env → the embedded release
   *  key. Dev hosts pass the `.caelo-dev-key` public half here (see
   *  `ensureDevSignedManifests`). */
  readonly publicKeyHex?: string;
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
    // #387 one-trust-path: in-memory plugins get the SAME verification
    // pipeline as disk plugins — manifest derived from the definition,
    // validator run, Tier-1 manifests signed with an ephemeral key and
    // signature-verified. Only the trust root differs (per-bootstrap
    // key instead of the release/dev key), never the checks.
    const ephemeral = await generateManifestKeyPair();
    for (const tp of opts.testPlugins) {
      try {
        let manifest: PluginManifest;
        try {
          manifest = manifestFromDefinition(tp.definition);
        } catch (e) {
          throw new Error(
            `manifest projection failed for "${tp.definition.slug}": ${(e as Error).message}`,
          );
        }
        const manifestCheck = validateManifest(manifest);
        if (manifestCheck.failures.length > 0) {
          throw new Error(
            `validator rejected manifest: ${manifestCheck.failures.map((f) => f.kind).join(", ")}`,
          );
        }
        let signatureHex = "unsigned-tier2";
        if (manifest.tier === 1) {
          signatureHex = (await signManifest({ manifest, privateKeyHex: ephemeral.privateKeyHex }))
            .signatureHex;
          const sig = await verifyManifestSignature({
            manifest,
            signatureHex,
            publicKeyHex: ephemeral.publicKeyHex,
          });
          if (!sig.ok) throw new Error(`signature verification failed: ${sig.reason}`);
        }
        if (tp.sourcePath) {
          const distPath = resolvePath(tp.sourcePath, "dist", "index.js");
          if (existsSync(distPath)) {
            const source = readFileSync(distPath, "utf8");
            const sourceFailures = validateSource({
              filename: `${tp.definition.slug}/dist/index.js`,
              source,
            });
            if (sourceFailures.length > 0) {
              throw new Error(
                `validator rejected source: ${sourceFailures.map((f) => f.kind).join(", ")}`,
              );
            }
          }
        }
        const lp = await registerLoadedPlugin({
          definition: tp.definition,
          manifest,
          sourcePath: tp.sourcePath ?? null,
          manifestSignatureHex: signatureHex,
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

  // Trust-root resolution (#387): explicit option → env override → the
  // `.tier1-trust-root` drop file written by the signer next to the
  // plugins it signed → the embedded release key inside
  // verifyManifestSignature. The drop file makes dev checkouts and
  // container images self-contained (the key travels with the manifests
  // it covers; image provenance is cosign's job).
  let publicKeyHex = opts.publicKeyHex ?? process.env.CAELO_TIER1_PUBLIC_KEY;
  if (!publicKeyHex) {
    try {
      publicKeyHex = readFileSync(
        resolvePath(opts.pluginsRoot, ".tier1-trust-root"),
        "utf8",
      ).trim();
    } catch {
      // no drop file — the embedded release key is the trust root
    }
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
        publicKeyHex,
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

  // v0.2.16 — Tier-2 plugins persist as `plugins.source_code` + a
  // `cms_public.plugin_<slug>` schema. Their rows survive every
  // `cms-provision upgrade` because the DB does. But the loader only
  // walks the filesystem (which holds Tier-1 plugins shipped in the
  // image), so a Tier-2 plugin completely disappears from the runtime
  // after upgrade unless we explicitly read it from the DB. Register
  // each active Tier-2 row as a stub LoadedPlugin so it shows up in
  // `/security/plugins` and gateway dispatches return a clear
  // "Tier2RuntimePending" error rather than confusing PluginNotFound.
  // The actual Deno-subprocess execution runtime is a deferred ship.
  const tier2 = await loadActiveTier2Plugins(opts);
  for (const t of tier2.loaded) loaded.push({ slug: t.slug, version: t.version, tier: 2 });
  for (const f of tier2.failed) failed.push(f);

  return { loaded, failed };
}

/**
 * v0.2.16 — Read every `plugins WHERE tier=2 AND status='active'` row
 * and register a stub `LoadedPlugin` so the plugin is visible to the
 * runtime registry post-upgrade. The stub's `runOperation` path
 * returns `Tier2RuntimePending` for every declared op (see
 * `dispatch.ts:runPluginOperation` — it short-circuits before the
 * handler lookup when `executionStub` is true). Tools / workers /
 * prompt-context renderers are NOT registered for Tier-2 stubs —
 * those need real execution to function.
 */
async function loadActiveTier2Plugins(opts: BootstrapOpts): Promise<{
  loaded: ReadonlyArray<{ slug: string; version: string }>;
  failed: ReadonlyArray<{ slug: string; reason: string }>;
}> {
  const loaded: Array<{ slug: string; version: string }> = [];
  const failed: Array<{ slug: string; reason: string }> = [];
  let rows: ReadonlyArray<{
    id: string;
    slug: string;
    version: string;
    manifest_json: unknown;
  }> = [];
  try {
    rows = await opts.infra.adapter.withAdminTransaction(
      {
        actorId: opts.systemActorId,
        actorKind: "system",
        requestId: "plugin-host-tier2-bootstrap",
      },
      async (tx) =>
        (await tx.execute(sql`
          SELECT id::text AS id, slug, version, manifest_json
          FROM plugins
          WHERE tier = 2 AND status = 'active'
          ORDER BY slug ASC
        `)) as unknown as ReadonlyArray<{
          id: string;
          slug: string;
          version: string;
          manifest_json: unknown;
        }>,
    );
  } catch (e) {
    // Don't block Tier-1 boot if the DB query fails — log + continue.
    return {
      loaded,
      failed: [{ slug: "<tier2-bootstrap>", reason: (e as Error).message }],
    };
  }

  for (const row of rows) {
    try {
      // Look up the per-plugin actor row created at activation time.
      const actorId = await opts.infra.adapter.withAdminTransaction(
        {
          actorId: opts.systemActorId,
          actorKind: "system",
          requestId: `plugin-host-tier2-bootstrap-${row.slug}`,
        },
        async (tx) => {
          const r = (await tx.execute(sql`
            SELECT id::text AS id FROM actors
            WHERE plugin_id = ${row.id}::uuid LIMIT 1
          `)) as unknown as { id: string }[];
          return r[0]?.id ?? null;
        },
      );
      if (!actorId) {
        failed.push({ slug: row.slug, reason: "missing per-plugin actor row" });
        continue;
      }
      const declaredOps = extractDeclaredOps(row.manifest_json);
      // Minimal frozen shell. dispatch.ts checks `executionStub` BEFORE
      // touching `definition.operations`, so the empty operations object
      // is never read. Same for component / workers / tools.
      const stubDef = {
        slug: row.slug,
        version: row.version,
        tier: 2 as const,
        schema: {},
        operations: {},
      } as unknown as PluginDefinition<PluginContext>;
      loadedPlugins.set({
        pluginId: row.id,
        slug: row.slug,
        version: row.version,
        tier: 2,
        pluginActorId: actorId,
        definition: stubDef,
        executionStub: true,
        declaredOperationNames: declaredOps,
      });
      loaded.push({ slug: row.slug, version: row.version });
    } catch (e) {
      failed.push({ slug: row.slug, reason: (e as Error).message });
    }
  }
  return { loaded, failed };
}

function extractDeclaredOps(manifestJson: unknown): ReadonlyArray<string> {
  if (manifestJson === null || typeof manifestJson !== "object") return [];
  const ops = (manifestJson as { operations?: unknown }).operations;
  if (Array.isArray(ops)) {
    return ops.filter((o): o is string => typeof o === "string");
  }
  if (ops !== null && typeof ops === "object") {
    return Object.keys(ops as Record<string, unknown>);
  }
  return [];
}

interface LoadOpts {
  readonly slug: string;
  readonly pluginDir: string;
  readonly rawManifest: unknown;
  readonly infra: PluginHostInfra;
  readonly systemActorId: string;
  readonly publicKeyHex?: string;
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
  // Trust root resolved by bootstrap() (option → env → drop file);
  // undefined ⇒ verifyManifestSignature uses the embedded release key.
  const sig = await verifyManifestSignature({
    manifest,
    signatureHex,
    publicKeyHex: opts.publicKeyHex,
  });
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
    manifest,
    sourcePath: opts.pluginDir,
    manifestSignatureHex: signatureHex,
    infra: opts.infra,
    systemActorId: opts.systemActorId,
  });
}

interface RegisterOpts {
  readonly definition: PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>;
  /** The VERIFIED manifest — parsed from disk (disk path) or derived
   *  via `manifestFromDefinition` (test path). Persisted verbatim so the
   *  `plugins` row records exactly what the signature covered. */
  readonly manifest: PluginManifest;
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
          (${JSON.stringify(opts.manifest)}::text)::jsonb,
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

  // #387 — provision the plugin's declared cms_public schema at load.
  // Before this, only the sandboxed activation path ran `schemaFromSpec`,
  // so release-signed plugins booted `active` with `ctx.query` pointing
  // at tables that did not exist ("relation does not exist" on first
  // use, i.e. a fresh-install break). The emitted DDL is fully
  // IF-NOT-EXISTS guarded, so re-provisioning on every boot is an
  // idempotent no-op for an already-provisioned schema.
  if (Object.keys(def.schema).length > 0) {
    const emitted = schemaFromSpec({ pluginId, slug: def.slug, schema: def.schema });
    await opts.infra.adapter.provisionPluginPublicSchema({ pluginId, sql: emitted.sql });
  }

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
          (${JSON.stringify([{ kind: "load-failed", hint: opts.reason }])}::text)::jsonb,
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
