// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1645) — the generated settings form of one plugin. The form
 * is built from the plugin's declared schema (no plugin code): the client
 * sends the changed fields as one merge patch, the server validates it with
 * the schema and stores it on main, where the next Stage freezes it.
 *
 * An Owner editing here is the decision an approval-gated field waits for
 * (CLAUDE.md §11.A: the gate obtains a human's decision), so the save passes
 * `approved` for the human actor.
 */

import { execute } from "@caelo-cms/query-api";
import { error, fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { opErrorMessage } from "#lib/server/op-error.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export interface ConfigFieldInfo {
  path: string;
  type: string;
  label: string;
  description: string;
  effect: string;
  gate: string;
  scope: string;
  allowed: string;
}

export const load: PageServerLoad = async ({ locals, params }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "plugin_config.get", {
    pluginSlug: params.slug,
  });
  if (!r.ok)
    error(404, opErrorMessage(r.error, "This plugin has no settings, or it is not active."));
  const value = r.value as {
    values: Record<string, unknown>;
    fields: ConfigFieldInfo[];
    entityFields: Record<string, ConfigFieldInfo[]>;
  };
  const types = await execute(registry, adapter, locals.ctx, "page_types.list", {});
  const pageTypes = types.ok
    ? ((types.value as { pageTypes: { slug: string; name: string }[] }).pageTypes ?? []).map(
        (t) => ({ slug: t.slug, name: t.name }),
      )
    : [];
  const listed = await execute(registry, adapter, locals.ctx, "lists.list", {});
  const lists = listed.ok
    ? (listed.value as { lists: { id: string; name: string; type: string }[] }).lists.map((l) => ({
        id: l.id,
        name: l.name,
        type: l.type,
      }))
    : [];
  // The entities that have settings, per kind, and what to pick a new one from.
  const configured: Record<
    string,
    { id: string; label: string; values: Record<string, unknown> }[]
  > = {};
  let modules: { id: string; name: string }[] = [];
  for (const kind of Object.keys(value.entityFields)) {
    const e = await execute(registry, adapter, locals.ctx, "plugin_config.get_entities", {
      pluginSlug: params.slug,
      kind,
      configuredOnly: true,
    });
    const rows = e.ok
      ? (e.value as { entities: { id: string; values: Record<string, unknown> }[] }).entities
      : [];
    if (kind === "module" && modules.length === 0) {
      const m = await execute(registry, adapter, locals.ctx, "modules.list", {});
      modules = m.ok
        ? (m.value as { modules: { id: string; displayName: string }[] }).modules.map((x) => ({
            id: x.id,
            name: x.displayName,
          }))
        : [];
    }
    const label = (id: string) =>
      kind === "module"
        ? (modules.find((x) => x.id === id)?.name ?? id)
        : kind === "pageType"
          ? (pageTypes.find((t) => t.slug === id)?.name ?? id)
          : id;
    configured[kind] = rows.map((r) => ({ id: r.id, label: label(r.id), values: r.values }));
  }
  return { slug: params.slug, ...value, pageTypes, lists, configured, modules };
};

export const actions: Actions = {
  saveEntity: async ({ request, locals, params }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const kind = String(form.get("kind") ?? "");
    const id = String(form.get("id") ?? "").trim();
    let values: unknown;
    try {
      values = JSON.parse(String(form.get("values") ?? "{}"));
    } catch {
      return fail(400, {
        error: "The form sent no readable values. Reload the page and try again.",
      });
    }
    if (!id) return fail(400, { error: "Pick what the settings are for first." });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "plugin_config.set_entities", {
      pluginSlug: params.slug,
      items: [{ kind, id, values }],
    });
    if (!r.ok) return fail(400, { error: opErrorMessage(r.error, "save failed") });
    return {
      ok: true,
      message: "Saved. The new values reach the site with the next Stage and Publish live.",
    };
  },
  save: async ({ request, locals, params }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    let patch: unknown;
    try {
      patch = JSON.parse(String(form.get("patch") ?? "{}"));
    } catch {
      return fail(400, {
        error: "The form sent no readable changes. Reload the page and try again.",
      });
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "plugin_config.update", {
      pluginSlug: params.slug,
      patch,
      approved: true,
    });
    if (!r.ok) return fail(400, { error: opErrorMessage(r.error, "save failed") });
    const changed = (r.value as { changed: { path: string; scope: string }[] }).changed;
    if (changed.length === 0) return { ok: true, message: "Nothing changed." };
    const staged = changed.some((c) => c.scope !== "immediate");
    return {
      ok: true,
      message: staged
        ? "Saved. The new values reach the site with the next Stage and Publish live."
        : "Saved and applied.",
    };
  },
};
