// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/gateway-attach — the API gateway's dispatch-only
 * plugin host (issue #613).
 *
 * The admin owns the plugin registry: it records discovered plugins, an
 * Owner activates them, and it provisions their schemas, registers their
 * tools/skills and runs their workers (loader.ts `bootstrap`). The gateway
 * used to run that same bootstrap, which is why it needed admin_role: every
 * boot upserted `plugins`/`actors`/`skills` rows, ran schema DDL and
 * `onActivate`, and scheduled a second copy of every worker.
 *
 * The gateway now only MIRRORS the registry, read-only, as `gateway_role`:
 *
 *   - At boot it verifies every plugin it can run — disk plugins against
 *     the trust root, exactly as the admin does (`verifyDiskPlugin`) — but
 *     registers nothing.
 *   - {@link syncDispatchPlugins} reads the registry (one query, at most
 *     every {@link SYNC_TTL_MS}) and attaches each plugin the admin marks
 *     `active` under the admin's plugin id and actor, and detaches any that
 *     is no longer active. So an Owner's activation or disable reaches the
 *     gateway within seconds, without a gateway restart, and a gateway
 *     that booted before migrations (a fresh install) picks plugins up as
 *     soon as the registry exists.
 *
 * Nothing here writes cms_admin; attached plugins answer visitor calls only
 * (dispatch.ts enforces `publicOperations`).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { PluginContext, PluginContextTier1, PluginDefinition } from "@caelo-cms/plugin-sdk";
import { sql } from "drizzle-orm";
import { makePluginContext } from "./capabilities.js";
import {
  type LoadedPlugin,
  loadedPlugins,
  type PluginHostInfra,
  setContextFactory,
  setHostInfra,
  setHostSystemActorId,
} from "./dispatch.js";
import { readExternalApproval } from "./external-authorization.js";
import { externalPluginDefinition } from "./external-plugin.js";
import {
  type InMemoryPlugin,
  type LoadReport,
  resolveTrustRoot,
  verifyDiskPlugin,
  verifyInMemoryPlugin,
} from "./loader.js";

/** How stale the gateway's view of the registry may get. Matches the gateway's settings TTL. */
export const SYNC_TTL_MS = 5_000;

export interface DispatchOnlyBootstrapOpts {
  /** Infra whose admin pool is the gateway's read-only `gateway_role` login. */
  readonly infra: PluginHostInfra;
  /** Absolute path to `packages/plugins`. */
  readonly pluginsRoot: string;
  readonly systemActorId: string;
  /** Trust root override (same precedence as the admin host's bootstrap). */
  readonly publicKeyHex?: string;
  /** Tests: definitions verified in memory instead of read from disk. */
  readonly testPlugins?: ReadonlyArray<InMemoryPlugin>;
}

type Definition = PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>;

interface RegistryRow {
  readonly id: string;
  readonly slug: string;
  readonly tier: number;
  readonly status: string;
  readonly version: string;
  readonly actor_id: string | null;
}

let state: {
  readonly opts: DispatchOnlyBootstrapOpts;
  /** Release-signed definitions this gateway verified, by slug. */
  readonly verified: Map<string, Definition>;
  syncedAt: number;
  inFlight: Promise<void> | null;
  lastError: string | null;
} | null = null;

/**
 * Verify every plugin this gateway can run and attach the ones the admin
 * marks active. A registry that cannot be read yet (the database is still
 * being migrated, the role has no password yet) is not fatal: the report
 * says so and the next {@link syncDispatchPlugins} retries.
 */
export async function bootstrapDispatchOnly(opts: DispatchOnlyBootstrapOpts): Promise<LoadReport> {
  setHostInfra(opts.infra);
  setHostSystemActorId(opts.systemActorId);
  setContextFactory(makePluginContext);
  loadedPlugins.reset();

  const verified = new Map<string, Definition>();
  const failed: Array<{ slug: string; reason: string }> = [];
  if (opts.testPlugins) {
    for (const tp of opts.testPlugins) {
      try {
        verified.set(tp.definition.slug, (await verifyInMemoryPlugin(tp)).definition);
      } catch (e) {
        failed.push({ slug: tp.definition.slug, reason: (e as Error).message });
      }
    }
  } else {
    const publicKeyHex = resolveTrustRoot(opts);
    for (const disk of diskPlugins(opts.pluginsRoot, failed)) {
      try {
        const v = await verifyDiskPlugin({ ...disk, publicKeyHex });
        verified.set(v.definition.slug, v.definition);
      } catch (e) {
        failed.push({ slug: disk.slug, reason: (e as Error).message });
      }
    }
  }

  state = { opts, verified, syncedAt: 0, inFlight: null, lastError: null };
  await syncDispatchPlugins({ force: true });
  if (state.lastError) failed.push({ slug: "<registry>", reason: state.lastError });
  return {
    loaded: loadedPlugins.all().map((p) => ({ slug: p.slug, version: p.version, tier: p.tier })),
    inactive: [],
    failed,
  };
}

/** The `packages/plugins/<slug>` directories that carry a manifest. */
function diskPlugins(
  pluginsRoot: string,
  failed: Array<{ slug: string; reason: string }>,
): Array<{ slug: string; pluginDir: string; rawManifest: unknown }> {
  let entries: string[];
  try {
    entries = readdirSync(pluginsRoot);
  } catch (e) {
    failed.push({ slug: "<root>", reason: (e as Error).message });
    return [];
  }
  const out: Array<{ slug: string; pluginDir: string; rawManifest: unknown }> = [];
  for (const entry of entries) {
    const pluginDir = resolvePath(pluginsRoot, entry);
    const manifestPath = resolvePath(pluginDir, "manifest.json");
    try {
      if (!statSync(pluginDir).isDirectory() || !existsSync(manifestPath)) continue;
    } catch {
      continue;
    }
    try {
      const rawManifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      const slug = (rawManifest as { slug?: unknown }).slug;
      out.push({ slug: typeof slug === "string" ? slug : entry, pluginDir, rawManifest });
    } catch (e) {
      failed.push({ slug: entry, reason: `manifest JSON parse: ${(e as Error).message}` });
    }
  }
  return out;
}

/**
 * Bring the attached plugins in line with the admin's registry. Cheap when
 * the last sync is younger than {@link SYNC_TTL_MS}; concurrent callers share
 * one read. A failed read keeps the current attachments (a database blip
 * must not take every plugin endpoint down) and is retried next time.
 */
export async function syncDispatchPlugins(opts: { force?: boolean } = {}): Promise<void> {
  const s = state;
  if (!s) return;
  if (s.inFlight) return s.inFlight;
  if (!opts.force && Date.now() - s.syncedAt < SYNC_TTL_MS) return;
  s.inFlight = (async () => {
    try {
      await reconcile(s.opts, s.verified, await readRegistry(s.opts));
      s.lastError = null;
    } catch (e) {
      s.lastError = (e as Error).message;
      console.error(`[plugin-host] gateway registry sync failed: ${s.lastError}`);
    } finally {
      s.syncedAt = Date.now();
      s.inFlight = null;
    }
  })();
  return s.inFlight;
}

async function readRegistry(opts: DispatchOnlyBootstrapOpts): Promise<RegistryRow[]> {
  return (await opts.infra.adapter.withAdminTransaction(
    { actorId: opts.systemActorId, actorKind: "system", requestId: "gateway-plugin-sync" },
    async (tx) =>
      tx.execute(sql`
        SELECT p.id::text AS id, p.slug, p.tier, p.status, p.version, a.id::text AS actor_id
        FROM plugins p
        LEFT JOIN actors a ON a.plugin_id = p.id
        WHERE p.status = 'active'
      `),
  )) as unknown as RegistryRow[];
}

async function reconcile(
  opts: DispatchOnlyBootstrapOpts,
  verified: ReadonlyMap<string, Definition>,
  rows: readonly RegistryRow[],
): Promise<void> {
  const active = new Map(rows.map((r) => [r.slug, r]));
  for (const p of loadedPlugins.all()) {
    const row = active.get(p.slug);
    // A runtime-authored plugin's version names the reviewed artifact, so
    // a new one is re-attached from its new source. A release-signed one
    // runs the definition shipped in this image whatever version the
    // admin's image registered — during an upgrade the admin rolls first,
    // and detaching would take its endpoints down until the gateway rolls.
    const stale = !row || row.id !== p.pluginId || (p.tier === 2 && row.version !== p.version);
    if (stale) loadedPlugins.unload(p.slug);
  }
  for (const row of rows) {
    if (loadedPlugins.bySlug(row.slug)) continue;
    if (!row.actor_id) {
      console.error(`[plugin-host] ${row.slug} is active but has no actor row; not attached`);
      continue;
    }
    try {
      const plugin =
        row.tier === 1
          ? attachReleaseSigned(row, verified.get(row.slug))
          : await attachRuntimeAuthored(opts, row);
      if (plugin) loadedPlugins.set(plugin);
    } catch (e) {
      console.error(`[plugin-host] ${row.slug} not attached: ${(e as Error).message}`);
    }
  }
}

/**
 * A release-signed plugin runs from the definition THIS gateway verified;
 * the registry only says whether it runs and under which id and actor.
 */
function attachReleaseSigned(
  row: RegistryRow,
  definition: Definition | undefined,
): LoadedPlugin | null {
  if (!definition) return null; // active in the admin, not shipped in this image
  return {
    pluginId: row.id,
    slug: row.slug,
    version: definition.version,
    tier: 1,
    provenance: "release-signed",
    definition,
    pluginActorId: row.actor_id as string,
  };
}

/** A runtime-authored plugin runs its Owner-approved source from the registry. */
async function attachRuntimeAuthored(
  opts: DispatchOnlyBootstrapOpts,
  row: RegistryRow,
): Promise<LoadedPlugin> {
  const rows = (await opts.infra.adapter.withAdminTransaction(
    { actorId: opts.systemActorId, actorKind: "system", requestId: `gateway-attach-${row.slug}` },
    async (tx) =>
      tx.execute(sql`
        SELECT manifest_json, source_code FROM plugins WHERE id = ${row.id}::uuid
      `),
  )) as unknown as { manifest_json: unknown; source_code: string | null }[];
  const source = rows[0]?.source_code;
  if (!source) throw new Error("ExternalPluginSourceMissing");
  const approval = await readExternalApproval({
    pluginId: row.id,
    manifest: rows[0]?.manifest_json,
    infra: opts.infra,
    systemActorId: opts.systemActorId,
  });
  const definition = externalPluginDefinition({
    pluginId: row.id,
    approval,
    manifest: rows[0]?.manifest_json,
    source,
    infra: opts.infra,
    systemActorId: opts.systemActorId,
  });
  if (definition.slug !== row.slug || definition.version !== row.version) {
    throw new Error("ExternalPluginIdentityMismatch");
  }
  return {
    pluginId: row.id,
    slug: row.slug,
    version: row.version,
    tier: 2,
    provenance: "runtime-authored",
    pluginActorId: row.actor_id as string,
    externalApproval: approval,
    definition,
  };
}

/** Test-only: forget the dispatch-only host's state. */
export function resetDispatchOnlyHost(): void {
  state = null;
  loadedPlugins.reset();
}
