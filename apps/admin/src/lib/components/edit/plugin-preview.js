// SPDX-License-Identifier: MPL-2.0
import { isUntrustedToolResult, untrustedToolResultValue } from "@caelo-cms/shared";
/** Only authenticated local plugin-preview endpoints can become editor surfaces. */
export function localPluginPreview(value, origin) {
    if (typeof value !== "string" || value.length > 4096)
        return null;
    try {
        const url = new URL(value, origin);
        if (url.origin !== origin ||
            url.username ||
            url.password ||
            !/^\/plugins\/[a-z0-9]+(?:-[a-z0-9]+)*\/preview$/.test(url.pathname))
            return null;
        const args = url.searchParams.get("args") ?? "{}";
        if (args.length > 2048)
            return null;
        const parsed = JSON.parse(args);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return null;
        const params = new URLSearchParams({ args });
        const view = url.searchParams.get("view");
        if (view) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(view))
                return null;
            params.set("view", view);
        }
        return `${url.pathname}?${params.toString()}`;
    }
    catch {
        return null;
    }
}
/**
 * The preview link a tool result names, if any. A plugin tool's result
 * arrives wrapped as untrusted data (#635); a built-in tool's is plain JSON.
 */
export function previewFromResult(content, origin) {
    try {
        const value = isUntrustedToolResult(content)
            ? untrustedToolResultValue(content)
            : JSON.parse(content);
        return localPluginPreview(value?.previewUrl, origin);
    }
    catch {
        return null;
    }
}
