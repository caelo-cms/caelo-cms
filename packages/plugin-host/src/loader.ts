// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/loader — startup-time Tier-1 plugin loader.
 *
 * Bootstrap walks `packages/plugins/<slug>/` directories, verifies each
 * manifest's Ed25519 signature, runs the validator over the plugin's source,
 * and upserts a `plugins` row. There is NO unverified load path (#387):
 * the in-memory test override runs the same validator + signature
 * pipeline against an ephemeral trust root.
 *
 * Discovery does NOT start a plugin. A newly found plugin is recorded at
 * `status='awaiting_activation'` and nothing of it runs — no schema, no
 * tools, no skills, no workers, no contributions. An Owner activates it
 * (`plugins.activate`), and only then does the host register it. This is
 * a hard state, not a display filter: to the running system and to the
 * AI's tool catalogue, an inactive plugin does not exist. The AI learns
 * such a plugin is available through the short installed-plugins prompt
 * block and `list_plugins`, and can offer the operator an activation.
 *
 * Failure isolation per plugin: a corrupted signature, a schema that will
 * not provision or a throwing `onActivate` is recorded in `plugin_errors`
 * (and, for a plugin the Owner wants running, as this instance's
 * `plugin_runtime` state), and loading continues with the next plugin. The
 * admin app keeps starting. The host never writes `plugins.status`: that
 * is the Owner's decision, and a load failure on one instance must not
 * switch a plugin off for all of them (#1008, see load-outcome.ts).
 *
 * Bootstrap is idempotent — restarting the host re-walks, sees existing
 * rows + applied migrations, and re-registers tools/workers without
 * mutating the DB. Disable / re-enable goes through the lifecycle ops.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  adminSchemaFromSpec,
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
import { z } from "zod";
import { makePluginContext } from "./capabilities.js";
import {
  hostSystemActorId,
  type LoadedPlugin,
  loadedPlugins,
  type PluginHostInfra,
  resetDisabledSet,
  runPluginOperation,
  setContextFactory,
  setHostInfra,
  setHostSystemActorId,
  setPluginDisabled,
} from "./dispatch.js";
import { readExternalApproval } from "./external-authorization.js";
import { externalPluginDefinition } from "./external-plugin.js";
import { compileListExt } from "./list-ext.js";
import { pluginListSourcesRegistry } from "./list-sources.js";
import { describeLoadError } from "./load-error.js";
import { loadReported, reportLoadFailure } from "./load-outcome.js";
import { resetLocalLoadOutcomes } from "./local-availability.js";
import { inactiveRequiredPlugins, requirementsMessage } from "./plugin-dependencies.js";
import { pluginPromptContextRegistry } from "./prompt-context-registry.js";
import {
  inPhase,
  PluginLoadError,
  PluginNotInReleaseError,
  startRuntimeHeartbeat,
  stopRuntimeHeartbeat,
} from "./runtime-health.js";
import { runSandbox } from "./sandbox-runtime.js";
import { pluginWorkerScheduler } from "./scheduler.js";
import { pluginToolsRegistry } from "./tools-registry.js";
import { urlContributionsRegistry } from "./url-composition.js";

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
  /**
   * Verified and registered in the `plugins` table, but NOT loaded: no
   * tools, no skills, no workers, no contributions, no schema. A plugin
   * only becomes part of the running system once an Owner activates it
   * (CLAUDE.md §2 — the activation state is hard, not cosmetic). The AI
   * learns these exist through the short installed-plugins prompt block
   * and `list_plugins`, and can offer the operator an activation.
   */
  readonly inactive: ReadonlyArray<{ slug: string; version: string; status: string }>;
  readonly failed: ReadonlyArray<{ slug: string; reason: string }>;
}

/**
 * Verify and register a plugin handed to the host as a definition.
 *
 * NOT a verification shortcut (#387): the manifest is projected from
 * the definition, validated, signed with a fresh in-process key and
 * signature-verified — the same pipeline the disk path runs, differing
 * only in the trust root. Extracted so an Owner activating an
 * in-memory plugin at runtime goes through exactly these checks
 * instead of a laxer second path.
 */
async function verifyAndRegisterInMemory(
  tp: InMemoryPlugin,
  opts: BootstrapOpts,
): Promise<RegisterOutcome> {
  const verified = await inPhase("verify", () => verifyInMemoryPlugin(tp));
  return registerLoadedPlugin({
    definition: tp.definition,
    manifest: verified.manifest,
    sourcePath: tp.sourcePath ?? null,
    manifestSignatureHex: verified.signatureHex,
    infra: opts.infra,
    systemActorId: opts.systemActorId,
    // Handing the host a definition IS the activation decision — the
    // caller already chose to run this plugin. Discovery is the case
    // that needs an Owner.
    activation: "explicit",
  });
}

/** A plugin handed to the host as a definition (tests). */
export interface InMemoryPlugin {
  readonly definition: PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>;
  readonly sourcePath?: string;
}

/** A plugin whose manifest, signature and source passed verification. */
export interface VerifiedPlugin {
  readonly definition: PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>;
  readonly manifest: PluginManifest;
  readonly signatureHex: string;
}

/**
 * The verification half of {@link verifyAndRegisterInMemory}: manifest
 * projected from the definition, validated, signed with a fresh in-process
 * key and signature-verified. No side effects — the gateway's dispatch-only
 * host (gateway-attach.ts) runs exactly these checks without registering.
 */
export async function verifyInMemoryPlugin(tp: InMemoryPlugin): Promise<VerifiedPlugin> {
  const ephemeral = await generateManifestKeyPair();
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
    const distDir = resolvePath(tp.sourcePath, "dist");
    if (existsSync(resolvePath(distDir, "index.js"))) {
      validateDistDirectory(distDir, tp.definition.slug);
    }
  }
  return { definition: tp.definition, manifest, signatureHex };
}

/**
 * The options the host booted with. Kept so an Owner activating a
 * plugin at runtime gets it RUNNING immediately — without this the
 * activation would only flip a row and the plugin would stay absent
 * until the next restart, which is exactly the "activated but nothing
 * happened" trap the hard activation state must not introduce.
 */
let bootOpts: BootstrapOpts | null = null;

/** Whether `bootstrap` ran in this process (the reconciler waits for it). */
export function pluginHostBootstrapped(): { infra: PluginHostInfra; systemActorId: string } | null {
  return bootOpts ? { infra: bootOpts.infra, systemActorId: bootOpts.systemActorId } : null;
}

export async function bootstrap(opts: BootstrapOpts): Promise<LoadReport> {
  setHostInfra(opts.infra);
  setHostSystemActorId(opts.systemActorId);
  setContextFactory(makePluginContext);
  bootOpts = opts;
  startRuntimeHeartbeat(opts.infra, opts.systemActorId);

  const loaded: Array<{ slug: string; version: string; tier: 1 | 2 }> = [];
  const inactive: Array<{ slug: string; version: string; status: string }> = [];
  const failed: Array<{ slug: string; reason: string }> = [];

  if (opts.testPlugins) {
    // #387 one-trust-path: in-memory plugins get the SAME verification
    // pipeline as disk plugins — manifest derived from the definition,
    // validator run, Tier-1 manifests signed with an ephemeral key and
    // signature-verified. Only the trust root differs (per-bootstrap
    // key instead of the release/dev key), never the checks.
    for (const tp of opts.testPlugins) {
      try {
        const outcome = await loadReported(
          { infra: opts.infra, systemActorId: opts.systemActorId, slug: tp.definition.slug },
          () => verifyAndRegisterInMemory(tp, opts),
          (o) => o.plugin !== null,
        );
        if (outcome.plugin) {
          loaded.push({
            slug: outcome.plugin.slug,
            version: outcome.plugin.version,
            tier: outcome.plugin.tier,
          });
        } else {
          inactive.push({
            slug: tp.definition.slug,
            version: tp.definition.version,
            status: outcome.status,
          });
        }
      } catch (e) {
        failed.push({ slug: tp.definition.slug, reason: describeLoadError(e) });
      }
    }
    return { loaded, inactive, failed };
  }

  let entries: string[];
  try {
    entries = readdirSync(opts.pluginsRoot);
  } catch (e) {
    // No plugins directory at all — fine on a fresh dev install.
    entries = [];
    failed.push({ slug: "<root>", reason: describeLoadError(e) });
  }

  const publicKeyHex = resolveTrustRoot(opts);

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
      await reportLoadFailure(
        { infra: opts.infra, systemActorId: opts.systemActorId, slug: entry },
        new PluginLoadError("verify", new Error(`manifest JSON parse: ${(e as Error).message}`)),
      );
      continue;
    }
    const slug = (rawManifest as { slug?: unknown }).slug;
    const slugStr = typeof slug === "string" ? slug : entry;
    try {
      const outcome = await loadReported(
        { infra: opts.infra, systemActorId: opts.systemActorId, slug: slugStr },
        () =>
          loadOnePlugin({
            slug: slugStr,
            pluginDir,
            rawManifest,
            infra: opts.infra,
            systemActorId: opts.systemActorId,
            publicKeyHex,
          }),
        (o) => o.plugin !== null,
      );
      if (outcome.plugin) {
        loaded.push({
          slug: outcome.plugin.slug,
          version: outcome.plugin.version,
          tier: outcome.plugin.tier,
        });
      } else {
        // Verified and recorded, deliberately not running. This is the
        // normal state of a freshly installed plugin.
        inactive.push({
          slug: slugStr,
          version: String((rawManifest as { version?: unknown }).version ?? "0.0.0"),
          status: outcome.status,
        });
      }
    } catch (e) {
      // Recorded in plugin_errors / plugin_runtime by loadReported; the
      // plugin's status stays the Owner's decision (#1008).
      failed.push({ slug: slugStr, reason: describeLoadError(e) });
    }
  }

  // Restore active external plugins from their reviewed database source.
  const tier2 = await loadActiveTier2Plugins(opts);
  for (const t of tier2.loaded) loaded.push({ slug: t.slug, version: t.version, tier: 2 });
  for (const f of tier2.failed) failed.push(f);

  return { loaded, inactive, failed };
}

/** Validate database-backed external plugins and register isolated operation proxies. */
async function loadActiveTier2Plugins(
  opts: BootstrapOpts,
  slug?: string,
): Promise<{
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
    source_code: string;
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
          SELECT id::text AS id, slug, version, manifest_json, source_code
          FROM plugins
          WHERE tier = 2 AND status = 'active' AND (${slug ?? null}::text IS NULL OR slug = ${slug ?? null})
          ORDER BY slug ASC
        `)) as unknown as ReadonlyArray<{
          id: string;
          slug: string;
          version: string;
          manifest_json: unknown;
          source_code: string;
        }>,
    );
  } catch (e) {
    // Don't block Tier-1 boot if the DB query fails — log + continue.
    return {
      loaded,
      failed: [{ slug: "<tier2-bootstrap>", reason: describeLoadError(e) }],
    };
  }

  for (const row of rows) {
    try {
      await loadReported(
        { infra: opts.infra, systemActorId: opts.systemActorId, slug: row.slug },
        () => loadTier2Row(opts, row),
        () => true,
      );
      loaded.push({ slug: row.slug, version: row.version });
    } catch (e) {
      failed.push({ slug: row.slug, reason: describeLoadError(e) });
    }
  }
  return { loaded, failed };
}

/** Load one active external plugin from its reviewed database row. */
async function loadTier2Row(
  opts: BootstrapOpts,
  row: { id: string; slug: string; version: string; manifest_json: unknown; source_code: string },
): Promise<void> {
  const { approval, definition } = await inPhase("verify", async () => {
    const approval = await readExternalApproval({
      pluginId: row.id,
      manifest: row.manifest_json,
      infra: opts.infra,
      systemActorId: opts.systemActorId,
    });
    const definition = externalPluginDefinition({
      pluginId: row.id,
      approval,
      manifest: row.manifest_json,
      source: row.source_code,
      infra: opts.infra,
      systemActorId: opts.systemActorId,
    });
    if (definition.slug !== row.slug || definition.version !== row.version) {
      throw new Error("ExternalPluginIdentityMismatch");
    }
    return { approval, definition };
  });
  await assertRequiredPluginsActive(opts.infra, opts.systemActorId, definition);
  // Both the registry and in-chat activation paths use this idempotent provisioning.
  const emitted = schemaFromSpec({
    pluginId: row.id,
    slug: row.slug,
    schema: definition.schema,
  });
  await inPhase("provision", async () => {
    await opts.infra.adapter.provisionPluginPublicSchema({
      pluginId: row.id,
      sql: emitted.sql,
    });
    if (definition.adminSchema && Object.keys(definition.adminSchema).length) {
      const privateSchema = adminSchemaFromSpec({
        pluginId: row.id,
        slug: row.slug,
        adminSchema: definition.adminSchema,
      });
      await opts.infra.adapter.provisionPluginAdminSchema({
        pluginId: row.id,
        sql: privateSchema.sql,
      });
    }
  });
  const actorId = await opts.infra.adapter.withAdminTransaction(
    {
      actorId: opts.systemActorId,
      actorKind: "system",
      requestId: `external-load-${row.slug}`,
    },
    async (tx) => {
      const actors = (await tx.execute(sql`
        INSERT INTO actors (kind, display_name, plugin_id)
        VALUES ('plugin', ${`Plugin: ${row.slug}`}, ${row.id}::uuid)
        ON CONFLICT (plugin_id) WHERE plugin_id IS NOT NULL DO UPDATE
          SET display_name = EXCLUDED.display_name RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      await tx.execute(sql`
        INSERT INTO plugin_schema_migrations (plugin_id, applied_for_version, applied_sql)
        SELECT ${row.id}::uuid, ${row.version}, ${emitted.sql}
        WHERE NOT EXISTS (SELECT 1 FROM plugin_schema_migrations
          WHERE plugin_id = ${row.id}::uuid AND applied_for_version = ${row.version})
      `);
      return actors[0]?.id;
    },
  );
  if (!actorId) throw new Error("ExternalPluginActorMissing");
  // Same check as activation: a tool name must not shadow another
  // plugin's — the chat would dispatch the wrong plugin's operation.
  for (const tool of definition.tools ?? []) {
    const existing = pluginToolsRegistry.resolve(tool.name);
    if (existing && existing.pluginSlug !== row.slug) {
      throw new Error(`Tool name already registered by ${existing.pluginSlug}: ${tool.name}`);
    }
  }
  loadedPlugins.set({
    pluginId: row.id,
    slug: row.slug,
    version: row.version,
    tier: 2,
    provenance: "runtime-authored",
    pluginActorId: actorId,
    externalApproval: approval,
    definition,
  });
  pluginToolsRegistry.unregisterPlugin(row.slug);
  for (const tool of definition.tools ?? []) pluginToolsRegistry.register(row.slug, tool);
}

/**
 * Trust-root resolution (#387): explicit option → env override → the
 * `.tier1-trust-root` drop file written by the signer next to the
 * plugins it signed → the embedded release key inside
 * verifyManifestSignature. The drop file makes dev checkouts and
 * container images self-contained (the key travels with the manifests
 * it covers; image provenance is cosign's job).
 */
export function resolveTrustRoot(
  opts: Pick<BootstrapOpts, "publicKeyHex" | "pluginsRoot">,
): string | undefined {
  const explicit = opts.publicKeyHex ?? process.env.CAELO_TIER1_PUBLIC_KEY;
  if (explicit) return explicit;
  try {
    return readFileSync(resolvePath(opts.pluginsRoot, ".tier1-trust-root"), "utf8").trim();
  } catch {
    // no drop file — the embedded release key is the trust root
    return undefined;
  }
}

interface LoadOpts {
  readonly slug: string;
  readonly pluginDir: string;
  readonly rawManifest: unknown;
  readonly infra: PluginHostInfra;
  readonly systemActorId: string;
  readonly publicKeyHex?: string;
}

async function loadOnePlugin(opts: LoadOpts): Promise<RegisterOutcome> {
  const verified = await inPhase("verify", () => verifyDiskPlugin(opts));
  return registerLoadedPlugin({
    definition: verified.definition,
    manifest: verified.manifest,
    sourcePath: opts.pluginDir,
    manifestSignatureHex: verified.signatureHex,
    infra: opts.infra,
    systemActorId: opts.systemActorId,
    activation: "discovered",
  });
}

/**
 * Verify one disk plugin — manifest shape, Tier 1, Ed25519 signature
 * against the trust root, the validator over every dist file — and import
 * its definition. No side effects: {@link loadOnePlugin} registers the
 * result; the gateway's dispatch-only host only attaches it.
 */
export async function verifyDiskPlugin(
  opts: Pick<LoadOpts, "slug" | "pluginDir" | "rawManifest" | "publicKeyHex">,
): Promise<VerifiedPlugin> {
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

  // 4. Validator (defense-in-depth on Tier 1) — every .js in dist.
  const distPath = resolvePath(opts.pluginDir, "dist", "index.js");
  if (!existsSync(distPath)) {
    throw new Error("missing dist/index.js (run `bun run build` in the plugin dir)");
  }
  validateDistDirectory(resolvePath(opts.pluginDir, "dist"), opts.slug);
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
  return { definition, manifest, signatureHex };
}

/** Loads in flight per slug: concurrent callers share one (see below). */
const activatedLoads = new Map<string, Promise<{ loaded: boolean; reason?: string }>>();

/**
 * Load a plugin the Owner just activated, without a host restart.
 *
 * Call AFTER the `plugins.activate` transaction has committed: the
 * loader opens its own transaction and takes the same row, so calling
 * it from inside the activation would self-deadlock.
 *
 * Re-reads the plugin from disk and runs the full verify pipeline
 * again rather than trusting anything cached — activation is exactly
 * the moment to re-check a signature. Returns the reason instead of
 * throwing so the caller can surface it on the activation screen; the
 * row is already active either way; the failure is recorded (load-outcome.ts)
 * and `plugins.reload` retries it on every server.
 */
export function loadActivatedPlugin(slug: string): Promise<{ loaded: boolean; reason?: string }> {
  // #1008 — the Owner's activation, an installation finishing and the
  // reconciler can each ask for the same plugin at once; two loads racing
  // through provisioning would both register it. Concurrent callers share
  // the one load in flight; a call after it settled loads again (a reload
  // or an update must re-verify).
  const inFlight = activatedLoads.get(slug);
  if (inFlight) return inFlight;
  const load = loadActivatedPluginOnce(slug).finally(() => {
    if (activatedLoads.get(slug) === load) activatedLoads.delete(slug);
  });
  activatedLoads.set(slug, load);
  return load;
}

async function loadActivatedPluginOnce(
  slug: string,
): Promise<{ loaded: boolean; reason?: string }> {
  if (!bootOpts) return { loaded: false, reason: "plugin host not bootstrapped" };
  const external = await loadActiveTier2Plugins(bootOpts, slug);
  if (external.loaded.length) return { loaded: true };
  if (external.failed.length) return { loaded: false, reason: external.failed[0]?.reason };
  if (bootOpts.testPlugins) {
    const tp = bootOpts.testPlugins.find((t) => t.definition.slug === slug);
    if (!tp) return { loaded: false, reason: `no in-memory plugin "${slug}"` };
    const subject = { infra: bootOpts.infra, systemActorId: bootOpts.systemActorId, slug };
    const host = bootOpts;
    try {
      const outcome = await loadReported(
        subject,
        () => verifyAndRegisterInMemory(tp, host),
        (o) => o.plugin !== null,
      );
      return outcome.plugin
        ? { loaded: true }
        : { loaded: false, reason: `plugin is ${outcome.status}, not active` };
    } catch (e) {
      return { loaded: false, reason: describeLoadError(e) };
    }
  }
  const pluginDir = resolvePath(bootOpts.pluginsRoot, slug);
  // #1052 — a tier-1 row with no built-in directory: a plugin Caelo no
  // longer ships. Recorded as the plugin's problem with the Owner's next
  // step, never filed as a blocking core bug from every instance.
  if (!existsSync(pluginDir)) {
    const notInRelease = new PluginNotInReleaseError(slug, pluginDir);
    await reportLoadFailure(
      { infra: bootOpts.infra, systemActorId: bootOpts.systemActorId, slug },
      new PluginLoadError("verify", notInRelease),
    );
    return { loaded: false, reason: notInRelease.message };
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(resolvePath(pluginDir, "manifest.json"), "utf8"));
  } catch (e) {
    const unreadable = new Error(`manifest unreadable: ${(e as Error).message}`, { cause: e });
    await reportLoadFailure(
      { infra: bootOpts.infra, systemActorId: bootOpts.systemActorId, slug },
      new PluginLoadError("verify", unreadable),
    );
    return { loaded: false, reason: unreadable.message };
  }
  const host = bootOpts;
  try {
    const outcome = await loadReported(
      { infra: host.infra, systemActorId: host.systemActorId, slug },
      () =>
        loadOnePlugin({
          slug,
          pluginDir,
          rawManifest,
          infra: host.infra,
          systemActorId: host.systemActorId,
          publicKeyHex: resolveTrustRoot(host),
        }),
      (o) => o.plugin !== null,
    );
    return outcome.plugin
      ? { loaded: true }
      : { loaded: false, reason: `plugin is ${outcome.status}, not active` };
  } catch (e) {
    return { loaded: false, reason: describeLoadError(e) };
  }
}

/** Complete an already recorded Owner decision. Failed preparation preserves the running version. */
export async function activateApprovedExternalPlugin(
  installationId: string,
): Promise<{ loaded: boolean; reason?: string }> {
  if (!bootOpts) return { loaded: false, reason: "plugin host not bootstrapped" };
  const opts = bootOpts;
  const system = {
    actorId: opts.systemActorId,
    actorKind: "system" as const,
    requestId: "external-installation-activate",
  };
  try {
    const prepared = await execute(
      opts.infra.registry,
      opts.infra.adapter,
      system,
      "plugins.get_approved_installation",
      { installationId },
    );
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const artifact = prepared.value as {
      status: "approved" | "active";
      pluginId: string;
      artifactDigest: string;
      manifest: unknown;
      source: string;
      previousManifest: unknown;
      grantIds: string[];
    };
    const manifest = pluginManifest.parse(artifact.manifest);
    // Each capability is enabled here only once its isolated host broker is implemented.
    const supported = new Set([
      "cms_admin_schema",
      "chat_runner_tools",
      "companion_skills",
      "font_assets",
      "private_files",
      "image_generation",
      "site_media_read",
      "consent_provider",
    ]);
    for (const capability of manifest.requestedCapabilities ?? [])
      if (!supported.has(capability))
        throw new Error(`External capability broker unavailable: ${capability}`);
    if (artifact.status === "active") {
      // Finalization may have committed before a transient host load failure.
      // The Query API and loader both verify this is still the exact active artifact.
      const live = await loadActivatedPlugin(manifest.slug);
      if (live.loaded) setPluginDisabled(manifest.slug, false);
      return live;
    }
    const previous = pluginManifest.parse(artifact.previousManifest);
    // Do not silently change existing column types or remove author data on an update.
    for (const key of ["schema", "adminSchema"] as const) {
      for (const [table, columns] of Object.entries(previous[key] ?? {})) {
        for (const [column, type] of Object.entries(columns)) {
          if (manifest[key]?.[table]?.[column] !== type)
            throw new Error(`Incompatible schema update: ${key}.${table}.${column}`);
        }
      }
    }
    for (const tool of manifest.tools ?? []) {
      z.fromJSONSchema(tool.inputJsonSchema);
      const existing = pluginToolsRegistry.resolve(tool.name);
      if (existing && existing.pluginSlug !== manifest.slug)
        throw new Error(`Tool name already registered: ${tool.name}`);
    }
    const context = await makePluginContext({
      plugin: {
        pluginId: artifact.pluginId,
        pluginActorId: system.actorId,
        slug: manifest.slug,
        version: manifest.version,
        tier: 2,
        provenance: "runtime-authored",
        definition: {
          slug: manifest.slug,
          version: manifest.version,
          tier: 2,
          schema: {},
          operations: {},
        },
      },
      infra: opts.infra,
      // Inspection runs no SDK call (denySdkCalls); it acts for nobody.
      invocation: { origin: "system", actorId: system.actorId },
    });
    await runSandbox({
      source: artifact.source,
      manifest,
      operation: "$inspect",
      args: manifest,
      context,
      authorize: async () => {},
      denySdkCalls: true,
    });
    const publicSchema = schemaFromSpec({
      pluginId: artifact.pluginId,
      slug: manifest.slug,
      schema: manifest.schema,
    });
    await opts.infra.adapter.provisionPluginPublicSchema({
      pluginId: artifact.pluginId,
      sql: publicSchema.sql,
    });
    if (manifest.adminSchema) {
      const privateSchema = adminSchemaFromSpec({
        pluginId: artifact.pluginId,
        slug: manifest.slug,
        adminSchema: manifest.adminSchema,
      });
      await opts.infra.adapter.provisionPluginAdminSchema({
        pluginId: artifact.pluginId,
        sql: privateSchema.sql,
      });
    }
    const finalized = await execute(
      opts.infra.registry,
      opts.infra.adapter,
      system,
      "plugins.finalize_installation",
      { installationId, artifactDigest: artifact.artifactDigest, grantIds: artifact.grantIds },
    );
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.error));
    const live = await loadActivatedPlugin(manifest.slug);
    if (live.loaded) setPluginDisabled(manifest.slug, false);
    return live;
  } catch (error) {
    return { loaded: false, reason: describeLoadError(error) };
  }
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
  /**
   * Who decided this plugin should run.
   *
   * `"discovered"` — the host found it on disk. A row that does not
   * exist yet lands at `awaiting_activation` and the plugin is NOT
   * loaded; an existing row's status is left exactly as the Owner left
   * it. Discovery never promotes.
   *
   * `"explicit"` — a caller handed the host a definition to run (the
   * `testPlugins` harness). Passing the definition IS the decision, so
   * a fresh row lands `active`; an Owner's `disabled` still wins.
   */
  readonly activation: "discovered" | "explicit";
}

/**
 * What a registration attempt produced. `plugin` is non-null only when
 * the plugin is genuinely running; otherwise `status` says why not
 * (`awaiting_activation` on a fresh install, `disabled` after an Owner
 * turned it off).
 */
interface RegisterOutcome {
  readonly plugin: LoadedPlugin | null;
  readonly status: string;
}

/**
 * Refuse to load an active plugin whose `requiresPlugins` are not all
 * active. The activation ops already refuse that state, so reaching it
 * means a row was changed around them; the plugin then does not run, and
 * the failure is recorded on it (plugin_errors / plugin_runtime) for the
 * Owner to see. Its status stays theirs to change (CLAUDE.md §2, #1008).
 *
 * @throws PluginLoadError (phase `register`) naming the dependency to activate.
 */
async function assertRequiredPluginsActive(
  infra: PluginHostInfra,
  systemActorId: string,
  def: { readonly slug: string; readonly requiresPlugins?: ReadonlyArray<string> },
): Promise<void> {
  const required = def.requiresPlugins ?? [];
  if (required.length === 0) return;
  const missing = await infra.adapter.withAdminTransaction(
    { actorId: systemActorId, actorKind: "system", requestId: `plugin-requires-${def.slug}` },
    (tx) => inactiveRequiredPlugins(tx, required),
  );
  if (missing.length === 0) return;
  throw new PluginLoadError(
    "register",
    new Error(
      `${requirementsMessage(def.slug, missing)} It is active, so it was not loaded until then.`,
    ),
  );
}

/**
 * Defense-in-depth over a release-signed dist: validate EVERY compiled
 * .js file, not just the entry — a multi-file dist (`import "./x.js"`)
 * must not smuggle an unvalidated sibling past the entry-only check.
 */
function validateDistDirectory(distDir: string, slug: string): void {
  const jsFiles = readdirSync(distDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".js"));
  if (jsFiles.length === 0) throw new Error("dist directory contains no .js files");
  for (const rel of jsFiles) {
    const source = readFileSync(resolvePath(distDir, rel), "utf8");
    const failures = validateSource({
      filename: `${slug}/dist/${rel}`,
      source,
      allowRelativeImports: true,
    });
    if (failures.length > 0) {
      throw new Error(
        `validator rejected source (${rel}): ${failures.map((f) => f.kind).join(", ")}`,
      );
    }
  }
}

async function registerLoadedPlugin(opts: RegisterOpts): Promise<RegisterOutcome> {
  const def = opts.definition;

  // #388 — capability enforcement at the registration seam (defense in
  // depth behind the validator's manifest-cap-missing rule): a tool or
  // worker whose capability was not granted must never register. Checked
  // BEFORE any side effect so a refused plugin leaves no row, no schema,
  // and no registry entry behind.
  const grantedCaps = new Set(def.requestedCapabilities ?? []);
  if ((def.tools?.length ?? 0) > 0 && !grantedCaps.has("chat_runner_tools")) {
    throw new Error(
      `plugin "${def.slug}" declares tools without the chat_runner_tools capability — registration refused`,
    );
  }
  if ((def.workers?.length ?? 0) > 0 && !grantedCaps.has("background_workers")) {
    throw new Error(
      `plugin "${def.slug}" declares workers without the background_workers capability — registration refused`,
    );
  }
  // A `publicOperations` entry naming an operation that does not exist
  // reads as "this is exposed" while exposing nothing — and the reverse
  // typo (an intended-public op misspelled) silently 404s the visitor
  // surface. Both are caught here, at load, rather than in production.
  for (const name of def.publicOperations ?? []) {
    if (!def.operations[name]) {
      throw new Error(
        `plugin "${def.slug}" lists "${name}" in publicOperations, which is not one of its operations`,
      );
    }
  }
  // Client assets run in every visitor's browser on every page. That is
  // the widest blast radius any contribution has, so it is release-signed
  // only — a runtime-authored plugin's frontend stays inside its Shadow
  // DOM component, where the sandbox can still reason about it.
  if (typeof def.buildAssets === "function" && def.tier !== 1) {
    throw new Error(
      `plugin "${def.slug}" declares buildAssets but is not release-signed — refused`,
    );
  }

  // Epic #1107 — list sources, list types and list-resolve overlays each
  // change what pages render, so each needs its own grant; refused here,
  // before any side effect, like tools and workers above.
  if ((def.listTypes?.length ?? 0) > 0 && !grantedCaps.has("list_types")) {
    throw new Error(
      `plugin "${def.slug}" declares listTypes without the list_types capability — registration refused`,
    );
  }
  if (def.listResolveOperation !== undefined) {
    if (!grantedCaps.has("list_resolve")) {
      throw new Error(
        `plugin "${def.slug}" answers list-resolve without the list_resolve capability — registration refused`,
      );
    }
    if (!def.operations[def.listResolveOperation]) {
      throw new Error(
        `plugin "${def.slug}" names listResolveOperation "${def.listResolveOperation}", which is not one of its operations`,
      );
    }
  }
  if (def.listExt) {
    // Compiled now so a schema the host cannot compile fails the load,
    // not the first list-type write that meets it.
    try {
      compileListExt(def.listExt);
    } catch (e) {
      throw new Error(`plugin "${def.slug}" declares a listExt schema the host cannot compile`, {
        cause: e,
      });
    }
  }

  // Declared BEFORE the activation gate on purpose. An inactive plugin
  // contributes nothing, but a module written while it ran still says
  // `{{#its_source}}`; remembering the name lets the renderer report
  // "that plugin is switched off" instead of "unknown source".
  if (def.listSources && def.listSources.length > 0) {
    if (!grantedCaps.has("list_sources")) {
      throw new Error(
        `plugin "${def.slug}" declares listSources without the list_sources capability — registration refused`,
      );
    }
    if (!def.listSourcesOperation) {
      throw new Error(
        `plugin "${def.slug}" declares listSources without a listSourcesOperation to resolve them`,
      );
    }
    if (!def.operations[def.listSourcesOperation]) {
      throw new Error(
        `plugin "${def.slug}" names listSourcesOperation "${def.listSourcesOperation}", which is not one of its operations`,
      );
    }
    pluginListSourcesRegistry.declare(def.slug, def.listSources);
  }

  // Upsert the plugins row + actor row; reuses migration 0036's partial unique index.
  //
  // The status a FRESH row gets is the whole activation model. Discovery
  // records the plugin and stops there — an Owner has to activate it
  // before a single line of it runs. An explicit hand-off (testPlugins)
  // carries its own decision, so it lands active. Neither mode ever
  // moves an EXISTING row: boot refreshes the manifest, signature and
  // version, and leaves the Owner's choice — active, disabled, or still
  // awaiting — exactly where they left it.
  const initialStatus = opts.activation === "explicit" ? "active" : "awaiting_activation";
  const { pluginId, pluginActorId, persistedStatus } =
    await opts.infra.adapter.withAdminTransaction(
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
          ${def.slug}, ${def.version}, ${def.tier}, ${initialStatus},
          (${JSON.stringify(opts.manifest)}::text)::jsonb,
          ${opts.sourcePath},
          ${opts.manifestSignatureHex},
          ${opts.systemActorId}::uuid
        )
        ON CONFLICT (slug) DO UPDATE SET
          version = EXCLUDED.version,
          status = plugins.status,
          manifest_json = EXCLUDED.manifest_json,
          source_path = EXCLUDED.source_path,
          manifest_signature = EXCLUDED.manifest_signature,
          updated_at = now()
        -- #1008: only a changed release writes the row. Every instance
        -- reconciles when the plugin rows change (reconcile.ts), and every
        -- load attempt runs this upsert, so an unconditional update would
        -- make instances retrying a failing plugin wake each other forever.
        WHERE (plugins.version, plugins.manifest_json, plugins.source_path, plugins.manifest_signature)
          IS DISTINCT FROM
          (EXCLUDED.version, EXCLUDED.manifest_json, EXCLUDED.source_path, EXCLUDED.manifest_signature)
        RETURNING id::text AS id, status
      `)) as unknown as { id: string; status: string }[];
        // An unchanged row is not returned by the upsert; read it instead.
        const row =
          rows[0] ??
          (
            (await tx.execute(sql`
              SELECT id::text AS id, status FROM plugins WHERE slug = ${def.slug}
            `)) as unknown as { id: string; status: string }[]
          )[0];
        if (!row) throw new Error("plugins upsert returned no id");
        const { id, status: persistedStatus } = row;

        const actorRows = (await tx.execute(sql`
        INSERT INTO actors (kind, display_name, plugin_id)
        VALUES ('plugin', ${`Plugin: ${def.slug}`}, ${id}::uuid)
        ON CONFLICT (plugin_id) WHERE plugin_id IS NOT NULL DO UPDATE
          SET display_name = EXCLUDED.display_name
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
        const actorId = actorRows[0]?.id;
        if (!actorId) throw new Error("actor upsert returned no id");
        return { pluginId: id, pluginActorId: actorId, persistedStatus };
      },
    );

  // THE ACTIVATION GATE. Everything below this line makes the plugin
  // part of the running system: its schema, its tools, its skills, its
  // workers, its URL and head contributions. A plugin that is not
  // `active` gets none of it — it is recorded and verified, and that is
  // all. "Installed" and "running" are different states and the AI must
  // never see the difference blurred: an inactive plugin's tools are
  // absent from the catalogue, not merely filtered out of it.
  //
  // The operator reaches an inactive plugin through /settings/plugins,
  // or through the chat — the short installed-plugins prompt block and
  // `list_plugins` let the AI notice one and offer to activate it.
  if (persistedStatus !== "active") {
    return { plugin: null, status: persistedStatus };
  }
  await assertRequiredPluginsActive(opts.infra, opts.systemActorId, def);

  // #390 — claim URL slots. Exclusive: a conflict throws here and
  // surfaces to the Owner as "conflicts with <holder>". Claimed only
  // for a running plugin, so an inactive one never holds a slot its
  // activation would have to fight for. urlContributions are
  // release-signed only (runtime-authored plugins never reach
  // registerLoadedPlugin with a definition carrying them — the manifest
  // validator has no claim field for tier 2 to smuggle functions in).
  if (def.urlContributions && def.urlContributions.length > 0) {
    if (def.tier !== 1) {
      throw new Error(
        `plugin "${def.slug}" declares urlContributions but is not release-signed — refused`,
      );
    }
    // Checked now (a conflict fails the activation before anything is
    // provisioned), claimed only once the plugin is loaded — see below.
    urlContributionsRegistry.assertClaimable(def.slug, def.urlContributions);
  }

  // #387 — provision the plugin's declared cms_public schema at load.
  // Before this, only the sandboxed activation path ran `schemaFromSpec`,
  // so release-signed plugins booted `active` with `ctx.query` pointing
  // at tables that did not exist ("relation does not exist" on first
  // use, i.e. a fresh-install break). The emitted DDL is fully
  // IF-NOT-EXISTS guarded, so re-provisioning on every boot is an
  // idempotent no-op for an already-provisioned schema.
  if (Object.keys(def.schema).length > 0) {
    const emitted = schemaFromSpec({ pluginId, slug: def.slug, schema: def.schema });
    await inPhase("provision", () =>
      opts.infra.adapter.provisionPluginPublicSchema({ pluginId, sql: emitted.sql }),
    );
  }

  // #389 — provision the plugin's OWN cms_admin schema (release-signed
  // only; the validator rejects runtime-authored adminSchema and
  // requires the cms_admin_schema capability). ADD COLUMN IF NOT EXISTS
  // in the emitted DDL makes a version bump with new columns an
  // additive evolution; destructive changes are drop-and-recreate
  // (pre-1.0, #393 uninstall drops the schema).
  if (def.adminSchema && Object.keys(def.adminSchema).length > 0) {
    const emitted = adminSchemaFromSpec({
      pluginId,
      slug: def.slug,
      adminSchema: def.adminSchema,
      // #635 — the declared projection's tables republish on every write.
      projectedTables: Object.keys(def.visitorProjection ?? {}),
    });
    await inPhase("provision", () =>
      opts.infra.adapter.provisionPluginAdminSchema({ pluginId, sql: emitted.sql }),
    );
  }

  const lp: LoadedPlugin = {
    pluginId,
    slug: def.slug,
    version: def.version,
    tier: def.tier,
    // Every plugin reaching this point had its manifest verified: disk
    // plugins against the release/dev trust root, test plugins against
    // the per-bootstrap ephemeral key. Runtime-authored (Tier-2) plugins
    // never pass through here — they register via the stub path.
    provenance: def.tier === 1 ? "release-signed" : "runtime-authored",
    definition: def,
    pluginActorId,
  };
  loadedPlugins.set(lp);
  // URL slots + the annotation op go live only now that the plugin can
  // answer: claimed earlier, a render running concurrently with this
  // activation called the annotation op of a plugin not yet loaded
  // (PluginNotFound in every preview during the activation window).
  if (def.urlContributions && def.urlContributions.length > 0) {
    try {
      urlContributionsRegistry.register(
        def.slug,
        def.urlContributions,
        def.urlAnnotationsOperation,
      );
    } catch (e) {
      loadedPlugins.unload(def.slug);
      throw e;
    }
  }

  // Create-time defaults, on main, before anything can read them.
  if (def.onActivate) {
    const ctx = await makePluginContext({
      plugin: lp,
      infra: opts.infra,
      invocation: { origin: "system", actorId: hostSystemActorId() },
    });
    try {
      await def.onActivate(ctx);
    } catch (e) {
      loadedPlugins.unload(def.slug);
      throw new PluginLoadError(
        "activate",
        new Error(`plugin "${def.slug}" onActivate failed`, { cause: e }),
      );
    }
  }

  // Epic #1107 — the plugin's list types go live with it, like its
  // skills: core's own op writes them (validated against every list of
  // the type, snapshotted, owned by this plugin), refreshed from the
  // verified manifest on every load. Availability then follows the
  // plugin's status (`plugin_list_type_available`), so a disable
  // archives them without touching a row.
  if (def.listTypes && def.listTypes.length > 0) {
    await inPhase("activate", async () => {
      const r = await execute(
        opts.infra.registry,
        opts.infra.adapter,
        {
          actorId: opts.systemActorId,
          actorKind: "system",
          requestId: `plugin-list-types-${def.slug}`,
        },
        "list_types.sync_plugin_types",
        { pluginId, listTypes: def.listTypes },
      );
      if (!r.ok) {
        loadedPlugins.unload(def.slug);
        urlContributionsRegistry.unregisterPlugin(def.slug);
        throw new Error(
          `plugin "${def.slug}" list types could not be stored: ${"message" in r.error ? (r.error as { message: string }).message : r.error.kind}`,
        );
      }
    });
  }

  // #1077 — this instance now holds the plugin's verified definition, so
  // its publisher can (re)publish the plugin's visitor projection. A
  // publisher that does not have a plugin leaves its section alone, so
  // without this mark a reload or a new version would keep serving what
  // the previous definition published until the plugin's next write. The
  // flag makes the adapter publish right after this commit, as the outbox
  // triggers do (cms_admin migration 0281).
  try {
    await opts.infra.adapter.withAdminTransaction(
      {
        actorId: opts.systemActorId,
        actorKind: "system",
        requestId: `plugin-projection-${def.slug}`,
      },
      async (tx) => {
        await tx.execute(
          sql`INSERT INTO public_projection_outbox (section) VALUES (${`plugin:${pluginId}`})`,
        );
        await tx.execute(sql`SELECT set_config('caelo.projection_dirty', 'on', true)`);
      },
    );
  } catch (e) {
    loadedPlugins.unload(def.slug);
    throw e;
  }

  // Register tools + workers + prompt-context renderers.
  for (const tool of def.tools ?? []) {
    pluginToolsRegistry.register(def.slug, tool);
  }
  if (def.listSources && def.listSources.length > 0 && def.listSourcesOperation) {
    pluginListSourcesRegistry.register(def.slug, def.listSources, def.listSourcesOperation);
  }
  for (const renderer of def.promptContext ?? []) {
    pluginPromptContextRegistry.register({
      pluginSlug: def.slug,
      label: renderer.label,
      render: () =>
        // Render with a fresh ctx every turn — handles get the live infra.
        Promise.resolve(
          makePluginContext({
            plugin: lp,
            infra: opts.infra,
            invocation: { origin: "system", actorId: hostSystemActorId() },
          }),
        ).then((ctx) => Promise.resolve(renderer.render(ctx as PluginContext))),
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

  // Plugin skills are live the moment the plugin is. Reaching this line
  // means an Owner activated the plugin, and a skill is not a second
  // decision layered on that one — it is part of what the plugin IS.
  // Asking for a second click would leave a shipped capability the AI
  // can call (its tools are registered above) but cannot know about,
  // since the `## Skills` index is the only surface that announces it.
  // The two-level model is intact for skills that are NOT plugin-owned:
  // AI-authored proposals still land awaiting_activation.
  //
  // On re-boot the upsert refreshes body/description but NEVER touches
  // status — an Owner's later archive of an individual skill sticks.
  if (def.skills && def.skills.length > 0) {
    await opts.infra.adapter.withAdminTransaction(
      {
        actorId: opts.systemActorId,
        actorKind: "system",
        requestId: `plugin-skills-${def.slug}`,
      },
      async (tx) => {
        for (const skill of def.skills ?? []) {
          await tx.execute(sql`
            INSERT INTO skills (
              slug, display_name, description, body,
              allowlisted_tools, auto_engagement_hints,
              status, activated_at, plugin_id, plugin_owner_slug
            ) VALUES (
              ${skill.slug}, ${skill.displayName}, ${skill.description}, ${skill.body},
              (${JSON.stringify(skill.allowlistedTools ?? [])}::text)::jsonb,
              (${JSON.stringify(skill.autoEngagementHints ?? {})}::text)::jsonb,
              'active', now(),
              ${pluginId}::uuid, ${def.slug}
            )
            ON CONFLICT (slug) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              description = EXCLUDED.description,
              body = EXCLUDED.body,
              allowlisted_tools = EXCLUDED.allowlisted_tools,
              auto_engagement_hints = EXCLUDED.auto_engagement_hints,
              plugin_id = EXCLUDED.plugin_id,
              plugin_owner_slug = EXCLUDED.plugin_owner_slug,
              -- Every boot re-runs this upsert, so the stamp must only
              -- move on a real transition — otherwise a restart would
              -- re-announce every plugin skill to every open chat.
              activated_at = CASE
                WHEN skills.status = 'active' THEN skills.activated_at
                WHEN skills.status = 'archived' THEN NULL
                ELSE now()
              END,
              -- An Owner who archived one skill of an active plugin made
              -- a per-skill decision; boot refreshes its text but does
              -- not overrule them.
              status = CASE WHEN skills.status = 'archived' THEN 'archived' ELSE 'active' END
          `);
        }
      },
    );
  }

  // A `disabled` plugin no longer reaches this point at all — the
  // activation gate above returns before any registry is touched, so
  // there is nothing left to mark inert at boot. `applyPluginLifecycle`
  // (lifecycle.ts) stays the live path for a disable that happens WHILE
  // the host is running.
  return { plugin: lp, status: persistedStatus };
}

/**
 * Test-only helper: clear all loaded plugins + scheduled workers + registered
 * tools. Use between integration test fixtures.
 */
export function resetPluginHost(): void {
  pluginWorkerScheduler.shutdown();
  pluginToolsRegistry.reset();
  pluginListSourcesRegistry.reset();
  pluginPromptContextRegistry.reset();
  urlContributionsRegistry.reset();
  loadedPlugins.reset();
  // Audit fix #2: also clear the disabled-flags set so a previous test's
  // disable() doesn't leak into the next fixture.
  resetDisabledSet();
  resetLocalLoadOutcomes();
  stopRuntimeHeartbeat();
}

// Silence the "execute is unused" warning when only used in capabilities.
void execute;
