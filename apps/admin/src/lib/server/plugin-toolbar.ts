// SPDX-License-Identifier: MPL-2.0

/**
 * Server half of the plugin places in the live editor's top bar (the SDK's
 * `editorToolbar`, `@caelo-cms/plugin-sdk` ./editor-toolbar.ts).
 *
 * An item exists only while its plugin runs in this host: the source is the
 * host's loaded plugins, where an inactive plugin is ABSENT (CLAUDE.md §2),
 * and the viewer must hold the item's permission. Its state comes from the
 * plugin's operation, called with the shown page as a read-only render
 * invocation on the editor's chat branch, and is validated here before the
 * editor sees it. A failing operation or an invalid answer is not hidden:
 * the item stays in the bar with the error, so a broken plugin is loud
 * where the operator works (#1008: surfaced, never switched off).
 */

import {
  isPluginDisabled,
  loadedPlugins,
  renderInvocation,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { type PluginEditorToolbarItem, pluginEditorToolbarState } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { EditorToolbarSlot } from "#lib/plugin-toolbar.js";
import { getQueryContext } from "./query.js";

export type { EditorToolbarSlot };

/** What one operation call returned, as `runPluginOperation` reports it. */
export type ToolbarCall = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * The slot for one declared item from its operation's answer, or null when
 * the plugin says the item has nothing to show on this page. Pure: the
 * validation and the error wording live here so they are unit-tested.
 */
export function toToolbarSlot(
  pluginSlug: string,
  item: PluginEditorToolbarItem,
  call: ToolbarCall,
): EditorToolbarSlot | null {
  const base = {
    key: `${pluginSlug}/${item.id}`,
    pluginSlug,
    title: item.title,
    icon: item.icon,
    prompts: (item.prompts ?? []).map((p) => ({ label: p.label, text: p.text })),
  };
  if (!call.ok) {
    return {
      ...base,
      state: null,
      error: `The ${pluginSlug} plugin could not load this: ${call.message}`,
    };
  }
  const parsed = pluginEditorToolbarState.safeParse(call.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (${issue.path.join(".")})` : "";
    return {
      ...base,
      state: null,
      error: `The ${pluginSlug} plugin answered in a shape the editor cannot show${where}: ${issue?.message ?? "invalid"}. This is a fault in the plugin; report it to its author.`,
    };
  }
  if (parsed.data.hidden) return null;
  return { ...base, state: parsed.data, error: null };
}

/**
 * `slots` with the page link of every entry whose page `openable` does not
 * hold removed: such an entry is shown, but not offered to open (a plugin
 * may name a page this chat deleted, or no page at all).
 */
export function withOpenablePages(
  slots: readonly EditorToolbarSlot[],
  openable: ReadonlySet<string>,
): EditorToolbarSlot[] {
  return slots.map((slot) =>
    slot.state?.items
      ? {
          ...slot,
          state: {
            ...slot.state,
            items: slot.state.items.map((entry) => {
              if (entry.pageId === undefined || openable.has(entry.pageId)) return entry;
              const { pageId: _gone, ...rest } = entry;
              return rest;
            }),
          },
        }
      : slot,
  );
}

/**
 * The editor toolbar slots for `pageId` in the chat on `chatBranchId`, for a
 * viewer holding `permissions`. Plugins in slug order, items in declaration
 * order, so the bar does not reshuffle between loads. An entry links a page
 * only when that page exists in the chat's view (`branchCtx`): looked up by
 * the ids the entries name (#1269), not against the site's page list.
 */
export async function loadEditorToolbar(opts: {
  readonly permissions: ReadonlySet<string>;
  readonly pageId: string;
  readonly chatBranchId: string;
  readonly branchCtx: ExecutionContext;
}): Promise<EditorToolbarSlot[]> {
  const declared = loadedPlugins
    .all()
    .filter((p) => !isPluginDisabled(p.slug) && (p.definition.editorToolbar?.length ?? 0) > 0)
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .flatMap((p) =>
      (p.definition.editorToolbar ?? [])
        .filter((item) => opts.permissions.has(item.permission))
        .map((item) => ({ pluginSlug: p.slug, item })),
    );
  const slots = await Promise.all(
    declared.map(async ({ pluginSlug, item }) => {
      const r = await runPluginOperation({
        invocation: renderInvocation({ chatBranchId: opts.chatBranchId }),
        pluginSlug,
        operationName: item.operation,
        args: { pageId: opts.pageId },
      });
      const call: ToolbarCall = r.ok
        ? { ok: true, value: r.value }
        : { ok: false, message: r.error.message };
      return toToolbarSlot(pluginSlug, item, call);
    }),
  );
  const shown = slots.filter((s): s is EditorToolbarSlot => s !== null);
  const named = [
    ...new Set(shown.flatMap((s) => (s.state?.items ?? []).flatMap((e) => e.pageId ?? []))),
  ];
  if (named.length === 0) return shown;
  const { adapter, registry } = getQueryContext();
  const listed = await execute(registry, adapter, opts.branchCtx, "pages.list", {
    pageIds: named,
  });
  if (!listed.ok) {
    throw new Error(
      `The pages the plugin places link to could not be checked: ${listed.error.kind}.`,
    );
  }
  const openable = new Set((listed.value as { pages: { id: string }[] }).pages.map((p) => p.id));
  return withOpenablePages(shown, openable);
}
