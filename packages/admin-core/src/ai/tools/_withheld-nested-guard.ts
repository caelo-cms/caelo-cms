// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1708 — write-time hint: a module a plugin withholds (a
 * consent-gated video, map or booking widget) was just written into another
 * module's `module` / `module-list` field.
 *
 * A withheld module can be parked behind its plugin's gate only where it is
 * placed on the page directly; nested in a field it would load before the
 * visitor consents, so the preview and the build leave it out and Publish
 * live refuses the page (the `render` check, `nested-module-withheld`). The
 * AI cannot see that from the write: whether a module is withheld is the
 * plugin's verdict, and embed modules are nested routinely (a section with a
 * video in its `module` field). So the write's result says it at once, in
 * the same turn, instead of the next Stage's audit.
 *
 * A warning on an already-successful write, like the other write guards,
 * never a gate. It asks the plugins only when the write holds a nested ref
 * and a running plugin withholds modules at all; a plugin that fails is
 * named in the result (loud, CLAUDE.md §2), and the write stands.
 */

import {
  hasDeferralContributors,
  type PluginRenderFailure,
  resolveModuleDeferrals,
} from "@caelo-cms/plugin-host";
import type { DeferralCandidate } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { collectNestedRefs, type ExecutionContext } from "@caelo-cms/shared";
import { nestedModuleWithheldHint } from "../../deploy/render-failures.js";
import { describeError } from "./_describe-error.js";
import type { ToolContext } from "./dispatch.js";

/**
 * Modules / instances one read takes (the list ops' bound). A write nests
 * far fewer: its tools take a bounded number of items, each with a handful
 * of nested refs, and the Stage's `render` check covers every one anyway.
 */
const MAX_READ_IDS = 1000;

/**
 * Hints for the withheld modules `written` nests ("" when there is none).
 *
 * @param written the content values the tool just wrote.
 */
export async function withheldNestedSuffix(
  ctx: ExecutionContext,
  toolCtx: Pick<ToolContext, "registry" | "adapter">,
  written: readonly Readonly<Record<string, unknown>>[],
): Promise<string> {
  const refs = written.flatMap((values) => collectNestedRefs(values));
  // Nothing to ask without a nested ref, or without a plugin that withholds.
  if (refs.length === 0 || !hasDeferralContributors()) return "";
  const moduleIds = [...new Set(refs.map((r) => r.moduleId))].slice(0, MAX_READ_IDS);
  const instanceIds = [...new Set(refs.map((r) => r.contentInstanceId))].slice(0, MAX_READ_IDS);
  // The chat's view of both (branch-aware like the write): what the
  // preview of its draft renders.
  const mods = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.list", { moduleIds });
  const cis = await execute(toolCtx.registry, toolCtx.adapter, ctx, "content_instances.list", {
    ids: instanceIds,
  });
  if (!mods.ok || !cis.ok) {
    const why = !mods.ok ? describeError(mods.error) : !cis.ok ? describeError(cis.error) : "";
    return ` ⚠️ Could not check whether a plugin withholds a module this write nests (${why}); inspect_page_render flags it if one does.`;
  }
  const valuesByModule = new Map<string, unknown[]>();
  for (const ci of (cis.value as { instances: { moduleId: string; values: unknown }[] })
    .instances) {
    const list = valuesByModule.get(ci.moduleId) ?? [];
    list.push(ci.values);
    valuesByModule.set(ci.moduleId, list);
  }
  const rows = (
    mods.value as {
      modules: {
        id: string;
        slug: string;
        html: string;
        css: string;
        js: string;
        fields: unknown;
      }[];
    }
  ).modules;
  const candidates: DeferralCandidate[] = rows.map((m) => ({
    moduleId: m.id,
    html: m.html,
    css: m.css,
    js: m.js,
    fields: m.fields,
    contentValues: valuesByModule.get(m.id) ?? [],
  }));
  const failures: PluginRenderFailure[] = [];
  let verdicts: Awaited<ReturnType<typeof resolveModuleDeferrals>>;
  try {
    verdicts = await resolveModuleDeferrals(candidates, {
      chatBranchId: ctx.chatBranchId ?? null,
      onPluginFailure: (f) => failures.push(f),
    });
  } catch (e) {
    // A malformed verdict or a missing placeholder throws (loud, as in a
    // render); the write itself already succeeded, so say it here.
    return ` ⚠️ Could not check whether a plugin withholds a module this write nests: ${e instanceof Error ? e.message : String(e)}`;
  }
  const slugOf = new Map(rows.map((m) => [m.id, m.slug]));
  const hints = [...verdicts].map(
    ([moduleId, v]) =>
      ` ⚠️ ${nestedModuleWithheldHint(
        { moduleId, pluginSlug: v.pluginSlug, reason: v.reason },
        "the module you wrote",
        slugOf.get(moduleId),
      )}`,
  );
  const failed = failures.map(
    (f) =>
      ` ⚠️ plugin ${f.slug} could not say whether it withholds a module this write nests: ${f.reason}`,
  );
  return [...hints, ...failed].join("");
}
