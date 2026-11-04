// SPDX-License-Identifier: MPL-2.0
import { isPluginDisabled, loadedPlugins, runPluginOperation } from "@caelo-cms/plugin-host";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { conditionsHold, fillCopy, mapArgs, primitiveValue, valueAt, } from "#lib/plugin-panels.js";
import { requirePermission, requireUser } from "./guards.js";
/** The panels of every plugin running in this host (inactive ones are not loaded). */
export function activePluginPanels() {
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
export function requirePanel(locals, pluginSlug, panelSlug) {
    requireUser(locals);
    const plugin = loadedPlugins.bySlug(pluginSlug);
    const panel = plugin && !isPluginDisabled(pluginSlug)
        ? plugin.definition.adminPanels?.find((p) => p.slug === panelSlug)
        : undefined;
    if (!panel)
        throw error(404, "No such plugin page. Is the plugin active?");
    // The SDK repeats the permission catalog; admin-core's permissions test
    // keeps the two identical.
    requirePermission(locals, panel.permission);
    return panel;
}
/**
 * Calls panel operations as the signed-in person (`owner-panel`, main
 * line), each distinct operation + arguments at most once per request:
 * two sections reading the same operation share one call.
 */
export function panelCaller(locals, pluginSlug) {
    const seen = new Map();
    return (operation, args) => {
        const key = `${operation}\u0000${JSON.stringify(args)}`;
        const cached = seen.get(key);
        if (cached)
            return cached;
        const call = runPluginOperation({
            invocation: { origin: "owner-panel", actorId: locals.ctx.actorId },
            pluginSlug,
            operationName: operation,
            args,
        }).then((r) => r.ok ? { ok: true, value: r.value } : { ok: false, message: r.error.message });
        seen.set(key, call);
        return call;
    };
}
/** The URL parameter of a section's filter or cursor. */
export function sectionParam(sectionId, name) {
    return `${sectionId}.${name}`;
}
const CURSOR = "cursor";
/**
 * The filter arguments the URL selects for a table. An unknown option is
 * refused (400) rather than ignored, so a stale link does not silently show
 * a different view.
 */
export function selectedFilters(section, url) {
    const args = {};
    const filters = (section.filters ?? []).map((f) => {
        const param = sectionParam(section.id, f.arg);
        const raw = url.searchParams.get(param);
        let selected = raw;
        if (raw === null) {
            // Without "All" the first option is the default view.
            selected = f.allLabel === undefined ? (f.options[0]?.value ?? null) : null;
        }
        else if (!f.options.some((o) => o.value === raw)) {
            throw error(400, `"${raw}" is not an option of the ${f.label} filter.`);
        }
        if (selected !== null)
            args[f.arg] = selected;
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
function cursorOf(section, url) {
    const raw = url.searchParams.get(sectionParam(section.id, CURSOR));
    if (raw === null)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw error(400, "This page link is malformed (paging cursor).");
    }
    const v = primitiveValue.safeParse(parsed);
    if (!v.success)
        throw error(400, "This page link is malformed (paging cursor).");
    return v.data;
}
function withParams(url, set) {
    const next = new URL(url);
    for (const [k, v] of Object.entries(set)) {
        if (v === null)
            next.searchParams.delete(k);
        else
            next.searchParams.set(k, v);
    }
    return `${next.pathname}${next.search}`;
}
/** The arguments a table's operation (and its CSV download) is called with. */
export function tableArgs(section, url) {
    const { filters, args: filterArgs } = selectedFilters(section, url);
    const cursor = section.paging ? cursorOf(section, url) : undefined;
    const args = {
        ...filterArgs,
        ...(section.paging ? { [section.paging.limitArg]: section.paging.pageSize } : {}),
        ...(section.paging && cursor !== undefined ? { [section.paging.cursor.arg]: cursor } : {}),
        ...section.args,
    };
    return { filters, filterArgs, cursor, args };
}
/** The CSV download link of a table, carrying the filters the view shows. */
function downloadHref(section, filterArgs, downloadBase) {
    const query = new URLSearchParams(Object.entries(filterArgs).map(([k, v]) => [sectionParam(section.id, k), v])).toString();
    return `${downloadBase}/${encodeURIComponent(section.id)}${query ? `?${query}` : ""}`;
}
async function loadTable(section, url, call, downloadBase) {
    const { filters, filterArgs, cursor, args } = tableArgs(section, url);
    const base = {
        kind: "table",
        section,
        error: null,
        rows: [],
        filters,
        nextPageHref: null,
        firstPageHref: cursor !== undefined ? withParams(url, { [sectionParam(section.id, CURSOR)]: null }) : null,
        downloadHref: section.download ? downloadHref(section, filterArgs, downloadBase) : null,
    };
    const r = await call(section.operation, args);
    if (!r.ok)
        return { ...base, error: r.message };
    const rows = valueAt(r.value, section.rowsKey);
    if (!Array.isArray(rows) || rows.some((row) => row === null || typeof row !== "object")) {
        return {
            ...base,
            error: `The plugin's ${section.operation} answer has no list of rows at "${section.rowsKey}".`,
        };
    }
    const out = [];
    for (const row of rows) {
        const key = section.rowKey === undefined ? null : valueAt(row, section.rowKey);
        const actions = [];
        for (const action of section.rowActions ?? []) {
            if (!conditionsHold(row, action.when))
                continue;
            const mapped = mapArgs(action.rowArgs, row);
            // A row without the value an action needs cannot offer it; the
            // declaration names a key the operation does not return.
            if (mapped.ok)
                actions.push({ id: action.id, args: mapped.args });
        }
        out.push({
            key: primitiveValue.safeParse(key).success ? key : null,
            cells: section.columns.map((c) => valueAt(row, c.key)),
            actions,
        });
    }
    let nextPageHref = null;
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
export async function loadSections(panel, url, call, downloadBase) {
    return Promise.all(panel.sections.map(async (section) => {
        switch (section.kind) {
            case "table":
                return loadTable(section, url, call, downloadBase);
            case "stats": {
                const r = await call(section.operation, { ...section.args });
                if (!r.ok)
                    return { kind: "stats", section, error: r.message, items: [] };
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
                if (!r.ok)
                    return { kind: "settings", section, error: r.message, values: {} };
                return {
                    kind: "settings",
                    section,
                    error: null,
                    values: Object.fromEntries(section.fields.map((f) => [f.arg, valueAt(r.value, f.valueKey)])),
                };
            }
        }
    }));
}
/** A table section's row action, or 400. */
export function findRowAction(panel, sectionId, actionId) {
    const section = findSection(panel, sectionId, "table");
    const action = section.rowActions?.find((a) => a.id === actionId);
    if (!action)
        throw error(400, `No action "${actionId}" in this section.`);
    return { section, action };
}
/** A section of the given kind, or 400. */
export function findSection(panel, sectionId, kind) {
    const section = panel.sections.find((s) => s.id === sectionId);
    if (!section || section.kind !== kind)
        throw error(400, `No ${kind} section "${sectionId}".`);
    return section;
}
/** The open review of the URL (`?review=<section>.<action>&reviewArgs=<json>`), if any. */
export async function loadReview(panel, url, call) {
    const which = url.searchParams.get("review");
    if (which === null)
        return null;
    const [sectionId = "", actionId = ""] = which.split(".");
    const { action } = findRowAction(panel, sectionId, actionId);
    if (!action.review)
        throw error(400, `Action "${actionId}" has no review step.`);
    const review = action.review;
    let posted;
    try {
        posted = JSON.parse(url.searchParams.get("reviewArgs") ?? "null");
    }
    catch {
        throw error(400, "This review link is malformed.");
    }
    const rowArgs = z
        .strictObject(Object.fromEntries(Object.keys(action.rowArgs).map((a) => [a, primitiveValue])))
        .safeParse(posted);
    if (!rowArgs.success)
        throw error(400, "This review link is malformed.");
    const base = {
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
    if (!r.ok)
        return { ...base, error: r.message };
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
    const submit = {};
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
export function postedJson(form, name, schema) {
    const raw = form.get(name);
    if (typeof raw !== "string")
        throw error(400, `Missing ${name}.`);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw error(400, `${name} is not valid JSON.`);
    }
    const r = schema.safeParse(parsed);
    if (!r.success)
        throw error(400, `${name} does not match what this action takes.`);
    return r.data;
}
/** A string field of a posted form, or 400. */
export function postedString(form, name) {
    const v = form.get(name);
    if (typeof v !== "string" || v.length === 0)
        throw error(400, `Missing ${name}.`);
    return v;
}
