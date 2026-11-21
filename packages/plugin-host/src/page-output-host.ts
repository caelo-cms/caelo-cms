// SPDX-License-Identifier: MPL-2.0

/**
 * Page output for build observers, the host's side (epic #1644, R1, #1647).
 *
 * The generator, building a Stage, sends each chunk's page hashes; the host
 * answers which pages an observer has not seen in this form (by the hash of
 * the final HTML), the generator extracts the facts of those pages only and
 * sends them, and the host calls every observer with the pages whose facts
 * differ from what it last received, at most 200 per call. At the end of the
 * build the host tells each observer which pages are gone and which modules'
 * placement counts changed, in a final call.
 *
 * Deliveries are recorded as pending for the run (`page_output.record`) and
 * count only once the Stage succeeds (`page_output.commit_run` in the
 * trigger's finish step); a failed Stage drops them, so its pages are sent
 * again next time. An observer that throws leaves its pages unrecorded and
 * marks its collections' release of this run failed, which Publish live
 * refuses with the reason.
 */

import { createHash } from "node:crypto";
import {
  type ConfigEntityKind,
  configLeaves,
  PAGE_OUTPUT_BATCH,
  type PageOutputFacts,
  type PageOutputObserverArgs,
  type PlacementChange,
  type PluginCapability,
  parseConfigSchema,
  placementStep,
} from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { hasConfig, makePluginConfigReader } from "./config-handle.js";
import {
  hostInfra,
  hostSystemActorId,
  isPluginDisabled,
  type LoadedPlugin,
  loadedPlugins,
  runPluginOperation,
} from "./dispatch.js";

/** One page the generator offers: its id and the hash of its final HTML. */
export interface OfferedPage {
  readonly pageId: string;
  readonly htmlHash: string;
  /** The modules the page composes, each with its placement count over the build. */
  readonly modules?: readonly (readonly [moduleId: string, placementCount: number])[];
}

/** One page's facts, with the HTML hash they were read from. */
export interface DeliveredPage {
  readonly htmlHash: string;
  readonly facts: PageOutputFacts;
}

/** True when the plugin holds the capability (an Owner grant). */
export function hasGrantedCapability(plugin: LoadedPlugin, capability: PluginCapability): boolean {
  if (plugin.provenance === "runtime-authored")
    return plugin.externalApproval?.capabilities.includes(capability) ?? false;
  return (plugin.definition.requestedCapabilities ?? []).includes(capability);
}

/** Active plugins with a granted page-output observer. */
export function pageOutputObservers(): LoadedPlugin[] {
  return loadedPlugins
    .all()
    .filter(
      (p) =>
        p.definition.pageOutputObserver &&
        !isPluginDisabled(p.slug) &&
        hasGrantedCapability(p, "page_output"),
    );
}

interface RunState {
  /** Per plugin, per needed page: the facts hash it last received (null: never). */
  readonly needs: Map<string, Map<string, string | null>>;
  /** Per plugin, the digest it sees this Stage's pages under. */
  readonly digests: Map<string, string>;
  /** Per plugin, per offered page: the hash recorded for it (HTML + the plugin's page settings). */
  readonly offered: Map<string, Map<string, string>>;
  /** Per plugin with page settings, per offered page: the hash of those settings. */
  readonly settings: Map<string, Map<string, string>>;
  /** Per plugin with placement steps: its thresholds this Stage (from its configuration). */
  readonly steps: Map<string, { thresholds: number[]; halfFrom?: number }>;
  /** Plugins whose observer failed in this run, with the first error. */
  readonly failed: Map<string, string>;
  publishedPageCount: number;
}

const runs = new Map<string, RunState>();

function stateOf(runId: string): RunState {
  let s = runs.get(runId);
  if (!s) {
    s = {
      needs: new Map(),
      digests: new Map(),
      offered: new Map(),
      settings: new Map(),
      steps: new Map(),
      failed: new Map(),
      publishedPageCount: 0,
    };
    runs.set(runId, s);
  }
  return s;
}

const systemCtx = (): ExecutionContext => ({
  actorId: hostSystemActorId(),
  actorKind: "system",
  requestId: "page-output",
});

async function op<T>(name: string, input: unknown): Promise<T> {
  const infra = hostInfra();
  const r = await execute(infra.registry, infra.adapter, systemCtx(), name, input);
  if (!r.ok)
    throw new Error(`${name}: ${"message" in r.error ? String(r.error.message) : r.error.kind}`);
  return r.value as T;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** JSON with sorted keys, so equal values hash equally. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function observerInvocation(runId: string) {
  return { origin: "observer" as const, actorId: hostSystemActorId(), stageRunId: runId };
}

/**
 * What shapes a plugin's view of every page: its version and approved
 * artifact, its configuration (the fields that wait for a Stage; an
 * `immediate` field has no visitor-visible effect by contract) and its
 * settings per module, content block and page type. A change makes the next Stage deliver every page again,
 * so a plugin whose rules changed rebuilds what it derived from the site.
 */
async function observerDigest(plugin: LoadedPlugin, runId: string): Promise<string> {
  const parts: Record<string, unknown> = {
    version: plugin.definition.version,
    artifact: plugin.externalApproval?.artifactDigest ?? null,
  };
  if (plugin.definition.config && hasConfig(plugin)) {
    const schema = parseConfigSchema(plugin.definition.config);
    const reader = makePluginConfigReader(plugin, hostInfra(), observerInvocation(runId));
    const value = await reader.get();
    const immediate = new Set(
      configLeaves(schema)
        .filter((l) => "scope" in l.field && l.field.scope === "immediate")
        .map((l) => l.path),
    );
    parts.config = withoutPaths(value, immediate);
    // Settings per module, content block or page type reach every page that
    // shows one, so they are part of the digest. A page's own settings are
    // per page (the page's settings hash, offeredHashes).
    const entityKinds = Object.keys(plugin.definition.entityConfig ?? {})
      .filter((kind) => kind !== "page")
      .sort();
    for (const kind of entityKinds) {
      const ids = [...(await reader.configured(kind as ConfigEntityKind))].sort();
      const values =
        ids.length > 0 ? await reader.entities(kind as ConfigEntityKind, ids) : new Map();
      parts[`entities:${kind}`] = ids.map((id) => [id, values.get(id) ?? {}]);
    }
  }
  return sha256(stableJson(parts));
}

function withoutPaths(
  value: Readonly<Record<string, unknown>>,
  paths: ReadonlySet<string>,
  prefix = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (paths.has(path)) continue;
    out[k] =
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? withoutPaths(v as Record<string, unknown>, paths, path)
        : v;
  }
  return out;
}

/** The plugin's placement thresholds for this Stage, read from its configuration. */
async function placementThresholds(
  plugin: LoadedPlugin,
  runId: string,
  state: RunState,
): Promise<{ thresholds: number[]; halfFrom?: number } | null> {
  const declared = plugin.definition.pageOutputObserver?.placementSteps;
  if (!declared) return null;
  const known = state.steps.get(plugin.pluginId);
  if (known) return known;
  const values = await makePluginConfigReader(plugin, hostInfra(), observerInvocation(runId)).get();
  const thresholds = declared.thresholds.map((path) => {
    let at: unknown = values;
    for (const part of path.split(".")) at = (at as Record<string, unknown> | undefined)?.[part];
    if (typeof at !== "number" || !Number.isInteger(at))
      throw new Error(
        `plugin "${plugin.slug}" names placement threshold "${path}", which is not an int field of its configuration`,
      );
    return at;
  });
  const steps = {
    thresholds: [...thresholds].sort((a, b) => a - b),
    ...(declared.halfFrom !== undefined ? { halfFrom: declared.halfFrom } : {}),
  };
  state.steps.set(plugin.pluginId, steps);
  return steps;
}

/**
 * Per page, the hash recorded for the plugin: its HTML, the plugin's
 * settings for the page when it keeps any (their hash goes to `settings`),
 * and the placement step of each of its modules when the plugin declares
 * steps — so a module crossing a step re-delivers every page it is on.
 */
async function offeredHashes(
  plugin: LoadedPlugin,
  runId: string,
  pages: readonly OfferedPage[],
  state: RunState,
  settingsOut: Map<string, string>,
): Promise<Map<string, string>> {
  const steps = await placementThresholds(plugin, runId, state);
  const stepsOf = (p: OfferedPage): string =>
    steps
      ? (p.modules ?? [])
          .map(
            ([id, count]) =>
              `${id}:${placementStep(count, state.publishedPageCount, steps.thresholds, steps.halfFrom)}`,
          )
          .sort()
          .join(",")
      : "";
  const withSteps = (p: OfferedPage, base: string): string =>
    steps ? sha256(`${base}\n${stepsOf(p)}`) : base;
  if (!plugin.definition.entityConfig?.page || !hasConfig(plugin)) {
    return new Map(pages.map((p) => [p.pageId, withSteps(p, p.htmlHash)] as const));
  }
  const reader = makePluginConfigReader(plugin, hostInfra(), observerInvocation(runId));
  const settings = await reader.entities(
    "page",
    pages.map((p) => p.pageId),
  );
  const out = new Map<string, string>();
  for (const p of pages) {
    const settingsHash = sha256(stableJson(settings.get(p.pageId) ?? {}));
    settingsOut.set(p.pageId, settingsHash);
    out.set(p.pageId, withSteps(p, sha256(`${p.htmlHash}\n${settingsHash}`)));
  }
  return out;
}

/**
 * What a plugin last received for a page, as recorded: the facts, and its
 * settings for the page when it keeps any — a changed setting is a change
 * the plugin must see even when the page's facts are the same.
 */
function receivedHash(state: RunState, pluginId: string, facts: PageOutputFacts): string {
  const settings = state.settings.get(pluginId)?.get(facts.pageId);
  return settings ? sha256(`${facts.outputHash}\n${settings}`) : facts.outputHash;
}

/** The pages whose facts some observer needs. */
export async function pageOutputNeeds(
  runId: string,
  pages: readonly OfferedPage[],
  publishedPageCount: number,
): Promise<string[]> {
  const observers = pageOutputObservers();
  if (observers.length === 0 || pages.length === 0) return [];
  const state = stateOf(runId);
  state.publishedPageCount = publishedPageCount;
  for (const plugin of observers) {
    if (!state.digests.has(plugin.pluginId))
      state.digests.set(plugin.pluginId, await observerDigest(plugin, runId));
  }
  const out = new Set<string>();
  for (let i = 0; i < pages.length; i += 1000) {
    const chunk = pages.slice(i, i + 1000);
    const plugins = [];
    for (const plugin of observers) {
      let settings = state.settings.get(plugin.pluginId);
      if (!settings) {
        settings = new Map();
        state.settings.set(plugin.pluginId, settings);
      }
      const hashes = await offeredHashes(plugin, runId, chunk, state, settings);
      let offered = state.offered.get(plugin.pluginId);
      if (!offered) {
        offered = new Map();
        state.offered.set(plugin.pluginId, offered);
      }
      for (const [pageId, hash] of hashes) offered.set(pageId, hash);
      plugins.push({
        pluginId: plugin.pluginId,
        digest: state.digests.get(plugin.pluginId) as string,
        pages: chunk.map((p) => ({ pageId: p.pageId, hash: hashes.get(p.pageId) as string })),
      });
    }
    const r = await op<{ needs: { pluginId: string; pageId: string; factsHash: string | null }[] }>(
      "page_output.needs",
      { plugins },
    );
    for (const n of r.needs) {
      let m = state.needs.get(n.pluginId);
      if (!m) {
        m = new Map();
        state.needs.set(n.pluginId, m);
      }
      m.set(n.pageId, n.factsHash);
      out.add(n.pageId);
    }
  }
  return [...out];
}

async function callObserver(
  plugin: LoadedPlugin,
  runId: string,
  args: PageOutputObserverArgs,
  state: RunState,
): Promise<boolean> {
  if (state.failed.has(plugin.pluginId)) return false;
  const operation = plugin.definition.pageOutputObserver?.operation as string;
  const r = await runPluginOperation({
    pluginSlug: plugin.slug,
    operationName: operation,
    args,
    invocation: observerInvocation(runId),
  });
  if (!r.ok) {
    state.failed.set(plugin.pluginId, r.error.message);
    return false;
  }
  return true;
}

/**
 * The bytes one observer call's pages may take: an installed plugin's call
 * crosses the sandbox's 1 MB message line with its other arguments.
 */
export const PAGE_OUTPUT_BATCH_BYTES = 768 * 1024;

/** Splits facts into calls of at most {@link PAGE_OUTPUT_BATCH} pages and {@link PAGE_OUTPUT_BATCH_BYTES}. */
export function factBatches(facts: readonly PageOutputFacts[]): PageOutputFacts[][] {
  const out: PageOutputFacts[][] = [];
  let batch: PageOutputFacts[] = [];
  let bytes = 0;
  for (const f of facts) {
    const size = Buffer.byteLength(JSON.stringify(f));
    if (
      batch.length > 0 &&
      (batch.length === PAGE_OUTPUT_BATCH || bytes + size > PAGE_OUTPUT_BATCH_BYTES)
    ) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(f);
    bytes += size;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/** Delivers facts to every observer that has not seen them. */
export async function observePageOutputs(
  runId: string,
  delivered: readonly DeliveredPage[],
): Promise<void> {
  const state = stateOf(runId);
  for (const plugin of pageOutputObservers()) {
    const needs = state.needs.get(plugin.pluginId);
    if (!needs) continue;
    const mine = delivered.filter((d) => needs.has(d.facts.pageId));
    const changed = mine.filter(
      (d) => needs.get(d.facts.pageId) !== receivedHash(state, plugin.pluginId, d.facts),
    );
    for (const batch of factBatches(changed.map((d) => d.facts))) {
      const ok = await callObserver(
        plugin,
        runId,
        {
          runId,
          pages: batch,
          removed: [],
          placementChanges: [],
          final: false,
          publishedPageCount: state.publishedPageCount,
        },
        state,
      );
      if (!ok) break;
    }
    // Unchanged facts behind a changed HTML are recorded too, so the next
    // Stage does not extract them again; nothing is recorded after a failure.
    if (!state.failed.has(plugin.pluginId) && mine.length > 0) {
      for (let i = 0; i < mine.length; i += 1000) {
        await op("page_output.record", {
          runId,
          pluginId: plugin.pluginId,
          pages: mine.slice(i, i + 1000).map((d) => ({
            pageId: d.facts.pageId,
            htmlHash: state.offered.get(plugin.pluginId)?.get(d.facts.pageId) ?? d.htmlHash,
            factsHash: receivedHash(state, plugin.pluginId, d.facts),
          })),
        });
      }
    }
    for (const d of mine) needs.delete(d.facts.pageId);
  }
}

/** What the end of a build reports: which plugins' observers failed, with why. */
export interface PageOutputFinish {
  readonly failed: readonly {
    readonly pluginId: string;
    readonly slug: string;
    readonly error: string;
  }[];
}

/** The final call: pages gone and placement counts changed. */
export async function finishPageOutput(
  runId: string,
  builtPageIds: readonly string[],
  moduleCounts: readonly (readonly [string, number])[],
): Promise<PageOutputFinish> {
  const state = stateOf(runId);
  try {
    for (const plugin of pageOutputObservers()) {
      if (state.failed.has(plugin.pluginId)) continue;
      const plan = await op<{ removed: string[]; placementChanges: PlacementChange[] }>(
        "page_output.finish_plan",
        {
          runId,
          pluginId: plugin.pluginId,
          digest: state.digests.get(plugin.pluginId) ?? (await observerDigest(plugin, runId)),
          builtPageIds,
          moduleCounts,
        },
      );
      await callObserver(
        plugin,
        runId,
        {
          runId,
          pages: [],
          removed: plan.removed,
          placementChanges: plan.placementChanges,
          final: true,
          publishedPageCount: builtPageIds.length,
        },
        state,
      );
    }
    const failed = [...state.failed.entries()].map(([pluginId, error]) => ({
      pluginId,
      slug: loadedPlugins.byId(pluginId)?.slug ?? pluginId,
      error,
    }));
    return { failed };
  } finally {
    runs.delete(runId);
  }
}

/** For tests: forget every run in flight. */
export function resetPageOutputRuns(): void {
  runs.clear();
}
