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

import {
  PAGE_OUTPUT_BATCH,
  type PageOutputFacts,
  type PageOutputObserverArgs,
  type PlacementChange,
  type PluginCapability,
} from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
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
  /** Plugins whose observer failed in this run, with the first error. */
  readonly failed: Map<string, string>;
  publishedPageCount: number;
}

const runs = new Map<string, RunState>();

function stateOf(runId: string): RunState {
  let s = runs.get(runId);
  if (!s) {
    s = { needs: new Map(), failed: new Map(), publishedPageCount: 0 };
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
  const out = new Set<string>();
  for (let i = 0; i < pages.length; i += 1000) {
    const r = await op<{ needs: { pluginId: string; pageId: string; factsHash: string | null }[] }>(
      "page_output.needs",
      {
        pluginIds: observers.map((p) => p.pluginId),
        pages: pages.slice(i, i + 1000),
      },
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
    invocation: { origin: "observer", actorId: hostSystemActorId(), stageRunId: runId },
  });
  if (!r.ok) {
    state.failed.set(plugin.pluginId, r.error.message);
    return false;
  }
  return true;
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
    const changed = mine.filter((d) => needs.get(d.facts.pageId) !== d.facts.outputHash);
    for (let i = 0; i < changed.length; i += PAGE_OUTPUT_BATCH) {
      const batch = changed.slice(i, i + PAGE_OUTPUT_BATCH);
      const ok = await callObserver(
        plugin,
        runId,
        {
          runId,
          pages: batch.map((d) => d.facts),
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
            htmlHash: d.htmlHash,
            factsHash: d.facts.outputHash,
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
