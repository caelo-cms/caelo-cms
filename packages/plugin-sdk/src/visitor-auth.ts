// SPDX-License-Identifier: MPL-2.0
//
// CLAUDE: do not regenerate this file. The visitor login core is locked
// from AI regeneration (CMS_REQUIREMENTS §14.9, CLAUDE.md §2); its
// security-sensitive parts stay human-authored.

/**
 * #1340 — the parts of the visitor login core (#1334, epic #763 E5) that
 * the auth plugin's admin-side operations and core's `visitor-auth` block
 * (packages/plugin-host/src/public-blocks/visitor-auth.ts) share: the
 * request shapes, the address and token rules, the login throttle and the
 * stored configuration. Pure: no hashing, no session, no mail here.
 */

import { z } from "zod";
import type { PluginQuery } from "./index.js";

/** The shortest password minimum an Owner may configure. */
export const PASSWORD_MIN_LENGTH_FLOOR = 8;
/** The longest password minimum an Owner may configure. */
export const PASSWORD_MIN_LENGTH_CEILING = 128;
/** Failed logins per address in one window before the account is refused without hashing. */
export const LOGIN_THROTTLE_MAX_FAILURES = 5;
/** The login throttle's window. */
export const LOGIN_THROTTLE_WINDOW_MS = 1000 * 60 * 15;

/** A password is at most 1024 characters (argon2 over a large body was a CPU lever, #763 H4). */
export const VISITOR_PASSWORD_MAX = 1024;
/** The longest address SMTP delivers. */
export const VISITOR_EMAIL_MAX = 254;

export const passwordMinLength = z
  .number()
  .int()
  .min(PASSWORD_MIN_LENGTH_FLOOR)
  .max(PASSWORD_MIN_LENGTH_CEILING);

const emailField = z.string().trim().min(3).max(VISITOR_EMAIL_MAX);
const passwordField = z.string().max(VISITOR_PASSWORD_MAX);
const tokenField = z.string().min(16).max(128);

/**
 * The visitor bodies of the login core, validated by the host before the
 * block runs. Session tokens never come in a body: only from the HttpOnly
 * cookie, so no script can hand one over.
 */
export const visitorAuthInputs = {
  credentials: z.object({ email: emailField, password: passwordField }).strict(),
  session: z.object({}).strict(),
  email: z.object({ email: emailField }).strict(),
  /** A verification link plus the password chosen at that sign-up. */
  verify: z.object({ token: tokenField, password: passwordField }).strict(),
  reset: z.object({ token: tokenField, newPassword: passwordField }).strict(),
} as const;

/** The stored singleton `auth_config` row. */
export const authConfigRow = z.object({
  id: z.string(),
  signup_open: z.boolean(),
  password_min_length: passwordMinLength,
  updated_at: z.unknown(),
});
export type AuthConfigRow = z.infer<typeof authConfigRow>;

function issuesOf(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** The `auth_config` row; a missing or out-of-range one is a loud error (no default). */
export async function readAuthConfig(q: PluginQuery, op: string): Promise<AuthConfigRow> {
  const rows = await q.list("auth_config", { limit: 1 });
  const row = rows[0];
  if (!row) {
    throw new Error(
      `${op}: auth_config row missing — the auth plugin's onActivate has not seeded it; re-activate the plugin`,
    );
  }
  const parsed = authConfigRow.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      `${op}: stored auth_config is invalid (${issuesOf(parsed.error)}) — re-apply it via /settings/auth with password_min_length ${PASSWORD_MIN_LENGTH_FLOOR}..${PASSWORD_MIN_LENGTH_CEILING}`,
    );
  }
  return parsed.data;
}

/** One spelling per address: Unicode NFC, trimmed, lower case (`A@x` and `a@x` are one account, #763 M6). */
export function normaliseVisitorEmail(email: string): string {
  return email.normalize("NFC").trim().toLowerCase();
}

/** SHA-256 of a token or a normalised address, hex. */
export async function sha256HexOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A login throttle row: failures of one address hash in its window. */
export interface LoginThrottleRow {
  readonly id: string;
  readonly failures: number;
  readonly window_started_at: string;
}

/**
 * The per-account login throttle, keyed by the hash of the normalised
 * address whether or not an account exists, so the throttle tells nobody
 * which addresses are registered.
 */
export async function loginThrottleOf(
  q: PluginQuery,
  emailHash: string,
): Promise<LoginThrottleRow | undefined> {
  const rows = await q.list<"login_throttle", LoginThrottleRow>("login_throttle", {
    email_hash: emailHash,
    limit: 1,
  });
  return rows[0];
}

/** Whether the throttle row's window is still open at `now`. */
export function loginThrottleWindowOpen(row: LoginThrottleRow, now: number): boolean {
  return now - new Date(row.window_started_at).getTime() < LOGIN_THROTTLE_WINDOW_MS;
}
