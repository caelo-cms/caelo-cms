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
import { makePluginContext } from "./capabilities.js";
import { pluginDataListsRegistry } from "./data-lists.js";
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
  tp: {
    readonly definition: PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>;
    readonly sourcePath?: string;
  },
  opts: BootstrapOpts,
): Promise<RegisterOutcome> {
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
  return registerLoadedPlugin({
    definition: tp.definition,
    manifest,
    sourcePath: tp.sourcePath ?? null,
    manifestSignatureHex: signatureHex,
    infra: opts.infra,
    systemActorId: opts.systemActorId,
    // Handing the host a definition IS the activation decision — the
    // caller already chose to run this plugin. Discovery is the case
    // that needs an Owner.
    activation: "explicit",
  });
}

/**
 * The options the host booted with. Kept so an Owner activating a
 * plugin at runtime gets it RUNNING immediately — without this the
 * activation would only flip a row and the plugin would stay absent
 * until the next restart, which is exactly the "activated but nothing
 * happened" trap the hard activation state must not introduce.
 */
let bootOpts: BootstrapOpts | null = null;

export async function bootstrap(opts: BootstrapOpts): Promise<LoadReport> {
  setHostInfra(opts.infra);
  setContextFactory(makePluginContext);
  bootOpts = opts;

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
        const outcome = await verifyAndRegisterInMemory(tp, opts);
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
        failed.push({ slug: tp.definition.slug, reason: (e as Error).message });
      }
    }
    return { loaded, inactive, failed };
  }

  let entries: string[];
  try {
    entries = readdirSync(opts.pluginsRoot);
  } catch (e) {
    // No plugins directory at all — fine on a fresh dev install.
    return { loaded, inactive, failed: [{ slug: "<root>", reason: (e as Error).message }] };
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
      continue;
    }
    const slug = (rawManifest as { slug?: unknown }).slug;
    const slugStr = typeof slug === "string" ? slug : entry;
    try {
      const outcome = await loadOnePlugin({
        slug: slugStr,
        pluginDir,
        rawManifest,
        infra: opts.infra,
        systemActorId: opts.systemActorId,
        publicKeyHex,
      });
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

  return { loaded, inactive, failed };
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
        provenance: "runtime-authored",
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

/**
 * Trust-root resolution (#387): explicit option → env override → the
 * `.tier1-trust-root` drop file written by the signer next to the
 * plugins it signed → the embedded release key inside
 * verifyManifestSignature. The drop file makes dev checkouts and
 * container images self-contained (the key travels with the manifests
 * it covers; image provenance is cosign's job).
 */
function resolveTrustRoot(opts: BootstrapOpts): string | undefined {
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

  return registerLoadedPlugin({
    definition,
    manifest,
    sourcePath: opts.pluginDir,
    manifestSignatureHex: signatureHex,
    infra: opts.infra,
    systemActorId: opts.systemActorId,
    activation: "discovered",
  });
}

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
 * row is already active either way, and the next boot retries.
 */
export async function loadActivatedPlugin(
  slug: string,
): Promise<{ loaded: boolean; reason?: string }> {
  if (!bootOpts) return { loaded: false, reason: "plugin host not bootstrapped" };
  if (bootOpts.testPlugins) {
    const tp = bootOpts.testPlugins.find((t) => t.definition.slug === slug);
    if (!tp) return { loaded: false, reason: `no in-memory plugin "${slug}"` };
    try {
      const outcome = await verifyAndRegisterInMemory(tp, bootOpts);
      return outcome.plugin
        ? { loaded: true }
        : { loaded: false, reason: `plugin is ${outcome.status}, not active` };
    } catch (e) {
      return { loaded: false, reason: (e as Error).message };
    }
  }
  const pluginDir = resolvePath(bootOpts.pluginsRoot, slug);
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(resolvePath(pluginDir, "manifest.json"), "utf8"));
  } catch (e) {
    return { loaded: false, reason: `manifest unreadable: ${(e as Error).message}` };
  }
  try {
    const outcome = await loadOnePlugin({
      slug,
      pluginDir,
      rawManifest,
      infra: bootOpts.infra,
      systemActorId: bootOpts.systemActorId,
      publicKeyHex: resolveTrustRoot(bootOpts),
    });
    return outcome.plugin
      ? { loaded: true }
      : { loaded: false, reason: `plugin is ${outcome.status}, not active` };
  } catch (e) {
    return { loaded: false, reason: (e as Error).message };
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
  // Client assets run in every visitor's browser on every page. That is
  // the widest blast radius any contribution has, so it is release-signed
  // only — a runtime-authored plugin's frontend stays inside its Shadow
  // DOM component, where the sandbox can still reason about it.
  if (typeof def.buildAssets === "function" && def.tier !== 1) {
    throw new Error(
      `plugin "${def.slug}" declares buildAssets but is not release-signed — refused`,
    );
  }

  // Declared BEFORE the activation gate on purpose. An inactive plugin
  // contributes nothing, but a module written while it ran still says
  // `{{#its_list}}`; remembering the name lets the renderer report "that
  // plugin is switched off" instead of "unknown field".
  if (def.dataLists && def.dataLists.length > 0) {
    if (def.tier !== 1) {
      throw new Error(
        `plugin "${def.slug}" declares dataLists but is not release-signed — refused`,
      );
    }
    if (!def.dataListsOperation) {
      throw new Error(
        `plugin "${def.slug}" declares dataLists without a dataListsOperation to resolve them`,
      );
    }
    if (!def.operations[def.dataListsOperation]) {
      throw new Error(
        `plugin "${def.slug}" names dataListsOperation "${def.dataListsOperation}", which is not one of its operations`,
      );
    }
    pluginDataListsRegistry.declare(def.slug, def.dataLists);
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
        RETURNING id::text AS id, status
      `)) as unknown as { id: string; status: string }[];
        const id = rows[0]?.id;
        if (!id) throw new Error("plugins upsert returned no id");
        const persistedStatus = rows[0]?.status ?? initialStatus;

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
  // The operator reaches an inactive plugin through /security/plugins,
  // or through the chat — the short installed-plugins prompt block and
  // `list_plugins` let the AI notice one and offer to activate it.
  if (persistedStatus !== "active") {
    return { plugin: null, status: persistedStatus };
  }

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
    urlContributionsRegistry.register(def.slug, def.urlContributions, def.urlAnnotationsOperation);
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
    await opts.infra.adapter.provisionPluginPublicSchema({ pluginId, sql: emitted.sql });
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
    });
    await opts.infra.adapter.provisionPluginAdminSchema({ pluginId, sql: emitted.sql });
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

  // Register tools + workers + prompt-context renderers.
  for (const tool of def.tools ?? []) {
    pluginToolsRegistry.register(def.slug, tool);
  }
  if (def.dataLists && def.dataLists.length > 0 && def.dataListsOperation) {
    pluginDataListsRegistry.register(def.slug, def.dataLists, def.dataListsOperation);
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
              status, activated_at, plugin_id
            ) VALUES (
              ${skill.slug}, ${skill.displayName}, ${skill.description}, ${skill.body},
              (${JSON.stringify(skill.allowlistedTools ?? [])}::text)::jsonb,
              (${JSON.stringify(skill.autoEngagementHints ?? {})}::text)::jsonb,
              'active', now(),
              ${pluginId}::uuid
            )
            ON CONFLICT (slug) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              description = EXCLUDED.description,
              body = EXCLUDED.body,
              allowlisted_tools = EXCLUDED.allowlisted_tools,
              auto_engagement_hints = EXCLUDED.auto_engagement_hints,
              plugin_id = EXCLUDED.plugin_id,
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
  pluginDataListsRegistry.reset();
  pluginPromptContextRegistry.reset();
  urlContributionsRegistry.reset();
  loadedPlugins.reset();
  // Audit fix #2: also clear the disabled-flags set so a previous test's
  // disable() doesn't leak into the next fixture.
  resetDisabledSet();
}

// Silence the "execute is unused" warning when only used in capabilities.
void execute;
