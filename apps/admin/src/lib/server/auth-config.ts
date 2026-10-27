// SPDX-License-Identifier: MPL-2.0

/**
 * The auth plugin's config as /settings/auth loads it (#854).
 *
 * When `get_auth_config` fails the page shows the structured error and no
 * values. It used to fill the form with built-in defaults next to the
 * error, so an Owner could read — and save — values that were never the
 * stored config (CLAUDE.md §2: no fallbacks).
 */

/** The singleton row `get_auth_config` returns. */
export interface AuthConfig {
  id: string | null;
  signupOpen: boolean;
  passwordMinLength: number;
  updatedAt: string | null;
}

/** What the page renders: the stored config, or only the error. */
export type AuthConfigView = { config: AuthConfig; error: null } | { config: null; error: string };

/**
 * Map the `get_auth_config` result to the page data.
 *
 * @param result - the plugin operation's result.
 */
export function authConfigView(
  result: { ok: true; value: unknown } | { ok: false; error: { message: string } },
): AuthConfigView {
  if (!result.ok) return { config: null, error: result.error.message };
  return { config: result.value as AuthConfig, error: null };
}

/**
 * Parse the apply form's minimum password length. A missing or
 * non-numeric value is refused, never replaced by a default.
 */
export function parsePasswordMinLength(raw: FormDataEntryValue | null): number | string {
  if (typeof raw !== "string" || raw.trim() === "") return "passwordMinLength is required (8..128)";
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 8 || n > 128) return "passwordMinLength must be 8..128";
  return n;
}
