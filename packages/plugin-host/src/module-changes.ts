// SPDX-License-Identifier: MPL-2.0

/**
 * Module changes (#1214) — telling plugins which modules a committed write
 * changed, so a verdict they derive from module content stays current
 * where it is stored.
 *
 * consent-manager decides per module whether it reaches a third party.
 * Its render hooks used to rescan every module and content instance on
 * each preview to find out; they now read the stored verdicts instead,
 * which is only correct if every write that changes a module's content
 * updates its verdict — on the writer's branch, because a draft edit must
 * show in that draft's preview and reach main with the merge.
 *
 * Called from admin-core's snapshot emitter (every write emits one) once
 * the write's transaction has committed: no pooled connection is held
 * while the plugin runs, and a rolled-back write tells nobody anything.
 *
 * A plugin's failure is recorded against the plugin (the dispatcher logs
 * every throw to `plugin_errors`, #1008) and never undoes or fails the
 * write: the write is the editor's, the stale verdict the plugin's to fix.
 */

import type { PluginInvocation } from "@caelo-cms/plugin-sdk";
import { isPluginDisabled, loadedPlugins, runPluginOperation } from "./dispatch.js";

/** The most module ids one call carries; a larger change is split. */
const MAX_IDS_PER_CALL = 1000;

/** Who wrote, and on which branch — the scope the plugin acts in. */
export interface ModuleChangeScope {
  readonly actorId: string;
  readonly chatBranchId: string | null;
}

/** Slugs of the active plugins that want to hear about module changes, sorted. */
export function moduleChangeContributors(): string[] {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.moduleChangesOperation === "string")
    .map((lp) => lp.slug)
    .sort();
}

/**
 * The invocation a module-change call runs under: the writer's chat
 * branch when there is one (so the plugin's rows land on that branch and
 * publish with it), main otherwise.
 *
 * Deliberately WITHOUT the writer's task: the rows written here are
 * derived from module content, not authored. Under the writer's task they
 * would take its per-task lease, so two sibling tasks editing different
 * content of one module would collide on the derived row and the second
 * re-judgement would be refused after its write had committed. Undo
 * needs no task tag either: undoing the module edit emits a snapshot,
 * which re-judges the module again.
 */
export function moduleChangeInvocation(scope: ModuleChangeScope): PluginInvocation {
  if (scope.chatBranchId) {
    return { origin: "chat", actorId: scope.actorId, chatBranchId: scope.chatBranchId };
  }
  return { origin: "system", actorId: scope.actorId };
}

/**
 * Tell every contributing plugin that `moduleIds` changed.
 *
 * @returns one entry per plugin call that failed (already recorded under
 *   the plugin by the dispatcher), so the caller can log the write that
 *   left a verdict stale.
 */
export async function notifyModuleChanges(
  moduleIds: ReadonlyArray<string>,
  scope: ModuleChangeScope,
): Promise<Array<{ slug: string; message: string }>> {
  const ids = [...new Set(moduleIds)];
  if (ids.length === 0) return [];
  const failures: Array<{ slug: string; message: string }> = [];
  for (const slug of moduleChangeContributors()) {
    const operationName = loadedPlugins.bySlug(slug)?.definition.moduleChangesOperation;
    if (typeof operationName !== "string") continue;
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_CALL) {
      const r = await runPluginOperation({
        invocation: moduleChangeInvocation(scope),
        pluginSlug: slug,
        operationName,
        args: { moduleIds: ids.slice(i, i + MAX_IDS_PER_CALL) },
      });
      if (!r.ok) failures.push({ slug, message: `${r.error.kind}: ${r.error.message}` });
    }
  }
  return failures;
}
