// SPDX-License-Identifier: MPL-2.0

/**
 * Server half of the generic plugin-panel renderer
 * (`routes/(authed)/plugins/[slug]/[panel]`).
 *
 * A panel exists only while its plugin runs in this host: the source of
 * truth is the host's loaded plugins (`loadedPlugins`), where an inactive
 * plugin is ABSENT, not filtered (CLAUDE.md §2). `syncPluginHost` in
 * hooks.server.ts reconciles that registry with the plugin rows before
 * every request, so activation and deactivation on any admin instance show
 * up on the next page load. A missing plugin or panel is a 404; the
 * panel's permission is checked on every load and every action.
 *
 * Only what a panel declares can be called: actions are looked up by the
 * section and action ids the form posts, their operation and fixed
 * arguments come from the declaration, and the only operator-supplied
 * values are the declared row / review / field arguments. Fixed arguments
 * are applied last, so nothing posted replaces them.
 */

import type { Permission } from "@caelo-cms/admin-core";
import { isPluginDisabled, loadedPlugins, runPluginOperation } from "@caelo-cms/plugin-host";
import type { PanelSection, PanelTableSection, PluginAdminPanel } from "@caelo-cms/plugin-sdk";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import {
  type ActivePluginPanels,
  conditionsHold,
  fillCopy,
  mapArgs,
  type PanelFilterState,
  type PanelPrimitive,
  type PanelRow,
  primitiveValue,
  type ReviewState,
  type SectionState,
  type TableState,
  valueAt,
} from "#lib/plugin-panels.js";
import { requirePermission, requireUser } from "./guards.js";

/** The panels of every plugin running in this host (inactive ones are not loaded). */
export function activePluginPanels(): ActivePluginPanels[] {
  return loadedPlugins
    .all()
    .filter((p) => !isPluginDisabled(p.slug) && (p.definition.adminPanels?.length ?? 0) > 0)
    .map((p) => ({ slug: p.slug, panels: p.definition.adminPanels ?? [] }));
}

/**
 * The panel `panelSlug` of the running plugin `pluginSlug`, for a viewer
 * holding its permission. 404 when the plugin is not running or declares
 * no such panel; 403 without the permission.
 */
export function requirePanel(
  locals: App.Locals,
  pluginSlug: string,
  panelSlug: string,
): PluginAdminPanel {
  requireUser(locals);
  const plugin = loadedPlugins.bySlug(pluginSlug);
  const panel =
    plugin && !isPluginDisabled(pluginSlug)
      ? plugin.definition.adminPanels?.find((p) => p.slug === panelSlug)
      : undefined;
  if (!panel) throw error(404, "No such plugin page. Is the plugin active?");
  // The SDK repeats the permission catalog; admin-core's permissions test
  // keeps the two identical.
  requirePermission(locals, panel.permission as Permission);
  return panel;
}

/** Result of one panel operation call. */
export type PanelCall = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Calls panel operations as the signed-in person (`owner-panel`, main
 * line), each distinct operation + arguments at most once per request:
 * two sections reading the same operation share one call.
 */
export function panelCaller(locals: App.Locals, pluginSlug: string) {
  const seen = new Map<string, Promise<PanelCall>>();
  return (operation: string, args: Record<string, unknown>): Promise<PanelCall> => {
    const key = `${operation}\u0000${JSON.stringify(args)}`;
    const cached = seen.get(key);
    if (cached) return cached;
    const call = runPluginOperation({
      invocation: { origin: "owner-panel", actorId: locals.ctx.actorId },
      pluginSlug,
      operationName: operation,
      args,
    }).then(
      (r): PanelCall =>
        r.ok ? { ok: true, value: r.value } : { ok: false, message: r.error.message },
    );
    seen.set(key, call);
    return call;
  };
}

/** The URL parameter of a section's filter or cursor. */
export function sectionParam(sectionId: string, name: string): string {
  return `${sectionId}.${name}`;
}

const CURSOR = "cursor";

/**
 * The filter arguments the URL selects for a table. An unknown option is
 * refused (400) rather than ignored, so a stale link does not silently show
 * a different view.
 */
export function selectedFilters(
  section: PanelTableSection,
  url: URL,
): { filters: PanelFilterState[]; args: Record<string, string> } {
  const args: Record<string, string> = {};
  const filters = (section.filters ?? []).map((f): PanelFilterState => {
    const param = sectionParam(section.id, f.arg);
    const raw = url.searchParams.get(param);
    let selected: string | null = raw;
    if (raw === null) {
      // Without "All" the first option is the default view.
      selected = f.allLabel === undefined ? (f.options[0]?.value ?? null) : null;
    } else if (!f.options.some((o) => o.value === raw)) {
      throw error(400, `"${raw}" is not an option of the ${f.label} filter.`);
    }
    if (selected !== null) args[f.arg] = selected;
    return {
      arg: f.arg,
      label: f.label,
      param,
      allLabel: f.allLabel ?? null,
      options: f.options,
      selected,
    };
  });
  return { filters, args };
}

function cursorOf(section: PanelTableSection, url: URL): PanelPrimitive | undefined {
  const raw = url.searchParams.get(sectionParam(section.id, CURSOR));
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw error(400, "This page link is malformed (paging cursor).");
  }
  const v = primitiveValue.safeParse(parsed);
  if (!v.success) throw error(400, "This page link is malformed (paging cursor).");
  return v.data;
}

function withParams(url: URL, set: Record<string, string | null>): string {
  const next = new URL(url);
  for (const [k, v] of Object.entries(set)) {
    if (v === null) next.searchParams.delete(k);
    else next.searchParams.set(k, v);
  }
  return `${next.pathname}${next.search}`;
}

/** The arguments a table's operation (and its CSV download) is called with. */
export function tableArgs(section: PanelTableSection, url: URL) {
  const { filters, args: filterArgs } = selectedFilters(section, url);
  const cursor = section.paging ? cursorOf(section, url) : undefined;
  const args: Record<string, unknown> = {
    ...filterArgs,
    ...(section.paging ? { [section.paging.limitArg]: section.paging.pageSize } : {}),
    ...(section.paging && cursor !== undefined ? { [section.paging.cursor.arg]: cursor } : {}),
    ...section.args,
  };
  return { filters, filterArgs, cursor, args };
}

/** The CSV download link of a table, carrying the filters the view shows. */
function downloadHref(
  section: PanelTableSection,
  filterArgs: Record<string, string>,
  downloadBase: string,
): string {
  const query = new URLSearchParams(
    Object.entries(filterArgs).map(([k, v]) => [sectionParam(section.id, k), v]),
  ).toString();
  return `${downloadBase}/${encodeURIComponent(section.id)}${query ? `?${query}` : ""}`;
}

async function loadTable(
  section: PanelTableSection,
  url: URL,
  call: ReturnType<typeof panelCaller>,
  downloadBase: string,
): Promise<TableState> {
  const { filters, filterArgs, cursor, args } = tableArgs(section, url);
  const base: TableState = {
    kind: "table",
    section,
    error: null,
    rows: [],
    filters,
    nextPageHref: null,
    firstPageHref:
      cursor !== undefined ? withParams(url, { [sectionParam(section.id, CURSOR)]: null }) : null,
    downloadHref: section.download ? downloadHref(section, filterArgs, downloadBase) : null,
  };
  const r = await call(section.operation, args);
  if (!r.ok) return { ...base, error: r.message };
  const rows = valueAt(r.value, section.rowsKey);
  if (!Array.isArray(rows) || rows.some((row) => row === null || typeof row !== "object")) {
    return {
      ...base,
      error: `The plugin's ${section.operation} answer has no list of rows at "${section.rowsKey}".`,
    };
  }
  const out: PanelRow[] = [];
  for (const row of rows) {
    const key = section.rowKey === undefined ? null : valueAt(row, section.rowKey);
    const actions: PanelRow["actions"] = [];
    for (const action of section.rowActions ?? []) {
      if (!conditionsHold(row, action.when)) continue;
      const mapped = mapArgs(action.rowArgs, row);
      // A row without the value an action needs cannot offer it; the
      // declaration names a key the operation does not return.
      if (mapped.ok) actions.push({ id: action.id, args: mapped.args });
    }
    out.push({
      key: primitiveValue.safeParse(key).success ? (key as PanelPrimitive) : null,
      cells: section.columns.map((c) => valueAt(row, c.key)),
      actions,
    });
  }
  let nextPageHref: string | null = null;
  if (section.paging && valueAt(r.value, section.paging.hasMoreKey) === true) {
    const last = rows.at(-1);
    const next = valueAt(last, section.paging.cursor.key);
    if (primitiveValue.safeParse(next).success) {
      nextPageHref = withParams(url, {
        [sectionParam(section.id, CURSOR)]: JSON.stringify(next),
      });
    }
  }
  return { ...base, rows: out, nextPageHref };
}

/** Loads every section's data (sections fail one by one, loudly, not the page). */
export async function loadSections(
  panel: PluginAdminPanel,
  url: URL,
  call: ReturnType<typeof panelCaller>,
  downloadBase: string,
): Promise<SectionState[]> {
  return Promise.all(
    panel.sections.map(async (section): Promise<SectionState> => {
      switch (section.kind) {
        case "table":
          return loadTable(section, url, call, downloadBase);
        case "stats": {
          const r = await call(section.operation, { ...section.args });
          if (!r.ok) return { kind: "stats", section, error: r.message, items: [] };
          if (section.items) {
            return {
              kind: "stats",
              section,
              error: null,
              items: section.items.map((d) => ({
                label: d.label,
                display: d,
                value: valueAt(r.value, d.key),
              })),
            };
          }
          const entries = z
            .array(z.object({ label: z.string().max(200), value: z.number() }))
            .max(50)
            .safeParse(valueAt(r.value, section.entriesKey ?? ""));
          if (!entries.success) {
            return {
              kind: "stats",
              section,
              error: `The plugin's ${section.operation} answer has no list of {label, value} at "${section.entriesKey}".`,
              items: [],
            };
          }
          return {
            kind: "stats",
            section,
            error: null,
            items: entries.data.map((e) => ({
              label: e.label,
              display: { key: "value", label: e.label, format: "number" },
              value: e.value,
            })),
          };
        }
        case "form":
          return { kind: "form", section };
        case "settings": {
          const r = await call(section.readOperation, { ...section.readArgs });
          if (!r.ok) return { kind: "settings", section, error: r.message, values: {} };
          return {
            kind: "settings",
            section,
            error: null,
            values: Object.fromEntries(
              section.fields.map((f) => [f.arg, valueAt(r.value, f.valueKey)]),
            ),
          };
        }
      }
    }),
  );
}

/** A table section's row action, or 400. */
export function findRowAction(panel: PluginAdminPanel, sectionId: string, actionId: string) {
  const section = findSection(panel, sectionId, "table");
  const action = section.rowActions?.find((a) => a.id === actionId);
  if (!action) throw error(400, `No action "${actionId}" in this section.`);
  return { section, action };
}

/** A section of the given kind, or 400. */
export function findSection<K extends PanelSection["kind"]>(
  panel: PluginAdminPanel,
  sectionId: string,
  kind: K,
): Extract<PanelSection, { kind: K }> {
  const section = panel.sections.find((s) => s.id === sectionId);
  if (!section || section.kind !== kind) throw error(400, `No ${kind} section "${sectionId}".`);
  return section as Extract<PanelSection, { kind: K }>;
}

/** The open review of the URL (`?review=<section>.<action>&reviewArgs=<json>`), if any. */
export async function loadReview(
  panel: PluginAdminPanel,
  url: URL,
  call: ReturnType<typeof panelCaller>,
): Promise<ReviewState | null> {
  const which = url.searchParams.get("review");
  if (which === null) return null;
  const [sectionId = "", actionId = ""] = which.split(".");
  const { action } = findRowAction(panel, sectionId, actionId);
  if (!action.review) throw error(400, `Action "${actionId}" has no review step.`);
  const review = action.review;
  let posted: unknown;
  try {
    posted = JSON.parse(url.searchParams.get("reviewArgs") ?? "null");
  } catch {
    throw error(400, "This review link is malformed.");
  }
  const rowArgs = z
    .strictObject(Object.fromEntries(Object.keys(action.rowArgs).map((a) => [a, primitiveValue])))
    .safeParse(posted);
  if (!rowArgs.success) throw error(400, "This review link is malformed.");
  const base: ReviewState = {
    sectionId,
    actionId,
    title: review.title,
    description: null,
    error: null,
    fields: [],
    submitArgs: null,
    unavailableMessage: null,
    submitLabel: review.submitLabel,
    confirm: action.confirm ?? null,
    closeHref: withParams(url, { review: null, reviewArgs: null }),
  };
  const r = await call(review.operation, { ...rowArgs.data });
  if (!r.ok) return { ...base, error: r.message };
  const fields = review.fields.map((d) => ({
    label: d.label,
    display: d,
    value: valueAt(r.value, d.key),
  }));
  const description = review.description ? fillCopy(review.description, r.value) : null;
  if (!conditionsHold(r.value, review.submitWhen)) {
    return {
      ...base,
      fields,
      description,
      unavailableMessage: fillCopy(review.unavailableMessage ?? "", r.value),
    };
  }
  const submit: Record<string, unknown> = {};
  for (const [arg, path] of Object.entries(review.submitArgs)) {
    const v = valueAt(r.value, path);
    if (v === undefined) {
      return {
        ...base,
        fields,
        description,
        error: `The plugin's ${review.operation} answer has no "${path}" to submit.`,
      };
    }
    submit[arg] = v;
  }
  return { ...base, fields, description, submitArgs: JSON.stringify(submit) };
}

/** JSON a form posted in `name`, validated by `schema`; 400 when it does not fit. */
export function postedJson<T>(form: FormData, name: string, schema: z.ZodType<T>): T {
  const raw = form.get(name);
  if (typeof raw !== "string") throw error(400, `Missing ${name}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw error(400, `${name} is not valid JSON.`);
  }
  const r = schema.safeParse(parsed);
  if (!r.success) throw error(400, `${name} does not match what this action takes.`);
  return r.data;
}

/** A string field of a posted form, or 400. */
export function postedString(form: FormData, name: string): string {
  const v = form.get(name);
  if (typeof v !== "string" || v.length === 0) throw error(400, `Missing ${name}.`);
  return v;
}
