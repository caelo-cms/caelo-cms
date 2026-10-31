// SPDX-License-Identifier: MPL-2.0
import { z } from "zod";
/**
 * The value at a key path (`approvedSend.status`) of an operation result.
 * `undefined` when any step is missing or not an object.
 */
export function valueAt(source, path) {
    let current = source;
    for (const part of path.split(".")) {
        if (current === null || typeof current !== "object" || Array.isArray(current)) {
            return undefined;
        }
        if (!Object.hasOwn(current, part))
            return undefined;
        current = current[part];
    }
    return current;
}
/** Whether every condition holds on `source`. A missing value compares as `null`. */
export function conditionsHold(source, conditions) {
    for (const c of conditions ?? []) {
        const raw = valueAt(source, c.key);
        const value = raw === undefined ? null : raw;
        if (c.in !== undefined && !c.in.some((v) => v === value))
            return false;
        if (c.notIn?.some((v) => v === value))
            return false;
    }
    return true;
}
/**
 * `copy` with each `{key.path}` replaced by that value of `source`, as
 * text. A placeholder whose value is missing is left as written, so a
 * declaration naming the wrong key shows up instead of reading "fine".
 */
export function fillCopy(copy, source) {
    return copy.replace(/\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (whole, path) => {
        const v = valueAt(source, path);
        if (v === undefined)
            return whole;
        return v === null ? "none" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
}
/** The text a value shows in the given display. Missing values show as an empty string. */
export function formatValue(display, value, locale) {
    if (value === undefined || value === null)
        return "";
    switch (display.format) {
        case "datetime": {
            const date = value instanceof Date ? value : new Date(String(value));
            return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(locale);
        }
        case "number": {
            const n = typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(n))
                return String(value);
            const scaled = display.divisor ? n / display.divisor : n;
            return display.decimals === undefined ? String(scaled) : scaled.toFixed(display.decimals);
        }
        case "list":
            return Array.isArray(value)
                ? value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ")
                : String(value);
        case "json":
            return JSON.stringify(value, null, 2);
        default:
            return typeof value === "object" ? JSON.stringify(value) : String(value);
    }
}
/** The badge style for a value; values the declaration does not name are `outline`. */
export function badgeVariant(display, value) {
    return display.badgeVariants?.[String(value)] ?? "outline";
}
/** Whether a value can travel as a row argument. */
export function isPrimitive(value) {
    return (value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)));
}
/**
 * The arguments `mapping` (argument → key path) takes from `source`, or
 * the first key path that has no primitive value there.
 */
export function mapArgs(mapping, source) {
    const args = {};
    for (const [arg, path] of Object.entries(mapping)) {
        const v = valueAt(source, path);
        if (!isPrimitive(v))
            return { ok: false, missing: path };
        args[arg] = v;
    }
    return { ok: true, args };
}
/** Primitive argument values a row contributes. */
export const primitiveValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
/** Read the submitted value of each field; `null` = left empty. */
function rawFieldValue(field, form) {
    const raw = form.get(field.arg);
    if (typeof raw !== "string")
        return null;
    return raw.length === 0 ? null : raw;
}
/**
 * Validate a submitted form against its declared fields. An empty
 * optional field is left out of the arguments; a checkbox is always sent
 * (checked = true).
 */
export function parseFields(fields, form) {
    const args = {};
    for (const field of fields) {
        if (field.input === "checkbox") {
            args[field.arg] = form.get(field.arg) === "on";
            continue;
        }
        const raw = rawFieldValue(field, form);
        if (raw === null) {
            if (field.required)
                return { ok: false, error: `${field.label}: required.` };
            continue;
        }
        switch (field.input) {
            case "text":
            case "textarea": {
                if (raw.length > field.maxLength) {
                    return {
                        ok: false,
                        error: `${field.label}: at most ${field.maxLength} characters.`,
                    };
                }
                if (field.minLength !== undefined && raw.length < field.minLength) {
                    return {
                        ok: false,
                        error: `${field.label}: at least ${field.minLength} characters.`,
                    };
                }
                args[field.arg] = raw;
                break;
            }
            case "number": {
                const n = Number(raw);
                if (!Number.isFinite(n))
                    return { ok: false, error: `${field.label}: not a number.` };
                if (field.integer && !Number.isInteger(n)) {
                    return { ok: false, error: `${field.label}: a whole number, please.` };
                }
                if (field.min !== undefined && n < field.min) {
                    return { ok: false, error: `${field.label}: at least ${field.min}.` };
                }
                if (field.max !== undefined && n > field.max) {
                    return { ok: false, error: `${field.label}: at most ${field.max}.` };
                }
                args[field.arg] = n;
                break;
            }
            case "select": {
                if (!field.options.some((o) => o.value === raw)) {
                    return { ok: false, error: `${field.label}: not one of the offered options.` };
                }
                args[field.arg] = raw;
                break;
            }
        }
    }
    return { ok: true, args };
}
/** The URL of a panel. */
export function panelHref(pluginSlug, panelSlug) {
    return `/plugins/${encodeURIComponent(pluginSlug)}/${encodeURIComponent(panelSlug)}`;
}
/**
 * The "Plugins" side-nav links one viewer gets: every panel of an active
 * plugin whose permission they hold, by plugin slug and then in declared
 * order. Empty means no "Plugins" entry at all.
 *
 * @param plugins the panels of the plugins running in this host (inactive
 *   plugins are not loaded, so they are not in this list).
 * @param perms the viewer's effective permissions.
 */
export function pluginNavLinks(plugins, perms) {
    const has = (p) => Array.isArray(perms) ? perms.includes(p) : perms.has(p);
    return [...plugins]
        .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
        .flatMap((plugin) => plugin.panels
        .filter((panel) => has(panel.permission))
        .map((panel) => ({
        href: panelHref(plugin.slug, panel.slug),
        label: panel.title,
        icon: panel.icon,
    })));
}
