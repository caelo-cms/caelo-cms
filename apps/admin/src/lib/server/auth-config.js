// SPDX-License-Identifier: MPL-2.0
/**
 * Map the `get_auth_config` result to the page data.
 *
 * @param result - the plugin operation's result.
 */
export function authConfigView(result) {
    if (!result.ok)
        return { config: null, error: result.error.message };
    return { config: result.value, error: null };
}
/**
 * Parse the apply form's minimum password length. A missing or
 * non-numeric value is refused, never replaced by a default.
 */
export function parsePasswordMinLength(raw) {
    if (typeof raw !== "string" || raw.trim() === "")
        return "passwordMinLength is required (8..128)";
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n) || n < 8 || n > 128)
        return "passwordMinLength must be 8..128";
    return n;
}
