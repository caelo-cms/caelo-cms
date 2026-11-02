// SPDX-License-Identifier: MPL-2.0

/**
 * The one cookie the API gateway reads from a visitor's browser:
 * `__session`, a container of named entries (#1343).
 *
 * ## Why one cookie, and why this name
 *
 * Firebase Hosting forwards exactly one cookie over a rewrite to Cloud Run,
 * the one named `__session`, and strips every other
 * (docs/dev/firebase-hosting-behaviour.md, section 1). On gcp-firebase a
 * gateway cookie by any other name is set in the browser and never comes
 * back. Every provider uses the same container (CLAUDE.md §11.B: one shape
 * per tier), so no provider has a code path of its own and a site moved
 * between providers keeps its visitors' state.
 *
 * ## Shape
 *
 * The cookie value is a URI-encoded `URLSearchParams` string, one parameter
 * per entry: `<key>=<expiresAt>.<value>`. Known keys are in
 * {@link SESSION_ENTRY}; each belongs to one owner, which writes, reads and
 * verifies its own entry's value:
 *
 *   - `vid`     the visitor id (gateway, only with consent, #677)
 *   - `login`   the visitor's login session (gateway, for the auth plugin)
 *   - `staging` reserved for the staging gate's session (E13 (a), #763)
 *
 * A component that updates one entry keeps every other entry it received,
 * so entries of different owners never clash.
 *
 * ## What is and is not protected
 *
 * The container itself is not signed: `expiresAt` is metadata that sets the
 * browser's Max-Age and lets the reader drop an entry that has run out.
 * Changing it buys a client nothing it could not do anyway (keep or drop its
 * own cookie). Every entry VALUE must carry its own integrity check, made
 * and checked by its owner (the gateway HMAC-signs `vid` and `login` with
 * its cookie secret and bounds their age itself).
 */

/** The cookie name, the only one Firebase Hosting passes through a rewrite. */
export const SESSION_COOKIE_NAME = "__session";

/** The entries the container holds, by owner. */
export const SESSION_ENTRY = {
  /** The gateway's visitor id, set only with the visitor's consent (#677). */
  visitorId: "vid",
  /** The gateway's signed visitor login session (auth plugin). */
  login: "login",
  /** Reserved for the staging gate's session cookie (E13 (a), #763). */
  staging: "staging",
} as const;

/** One entry: an owner-verified value and when it runs out. */
export interface SessionEntry {
  readonly value: string;
  /** Unix seconds. Not authenticated; see the module comment. */
  readonly expiresAt: number;
}

/** Entries by key, as {@link readSessionCookie} returns them. */
export type SessionEntries = ReadonlyMap<string, SessionEntry>;

/**
 * The only keys the container holds. An unknown key is visitor input with
 * no owner: reading leaves it out, so the container never grows past these
 * three and a gateway write can never overflow it (PR #1354 review). A new
 * owner adds its key to {@link SESSION_ENTRY}.
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.values(SESSION_ENTRY));
/** Values the entries' owners write: signed tokens, no separators of ours. */
const ENTRY_VALUE = /^[A-Za-z0-9._~-]{1,512}$/;

/** The raw `__session` value of a `Cookie` header, or null. */
function rawSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * Parse the request's `__session` container.
 *
 * Visitor-controlled input: a malformed container, entry or value, a key
 * not in {@link SESSION_ENTRY} and a repeated key are left out rather than
 * failing the request, and an entry past its `expiresAt` is left out too.
 * The caller still verifies each value it uses.
 *
 * @param cookieHeader the request's `Cookie` header.
 * @param nowSeconds the current time, unix seconds.
 */
export function readSessionCookie(cookieHeader: string | null, nowSeconds: number): SessionEntries {
  const out = new Map<string, SessionEntry>();
  const raw = rawSessionCookie(cookieHeader);
  if (!raw) return out;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return out;
  }
  for (const [key, entry] of new URLSearchParams(decoded)) {
    if (!KNOWN_KEYS.has(key) || out.has(key)) continue;
    const dot = entry.indexOf(".");
    const expRaw = entry.slice(0, dot);
    const value = entry.slice(dot + 1);
    if (dot <= 0 || !/^\d{1,12}$/.test(expRaw) || !ENTRY_VALUE.test(value)) continue;
    const expiresAt = Number(expRaw);
    if (expiresAt <= nowSeconds) continue;
    out.set(key, { value, expiresAt });
  }
  return out;
}

/**
 * Serialise entries into a `__session` cookie value (URI-encoded).
 *
 * @throws on a key or value {@link readSessionCookie} would not read back:
 *   an owner writing one is a bug, not visitor input.
 */
export function sessionCookieValue(entries: SessionEntries): string {
  const params = new URLSearchParams();
  for (const [key, e] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`session cookie: unknown entry key "${key}"`);
    if (!ENTRY_VALUE.test(e.value)) throw new Error(`session cookie: invalid value for "${key}"`);
    if (!Number.isInteger(e.expiresAt) || e.expiresAt <= 0) {
      throw new Error(`session cookie: invalid expiresAt for "${key}"`);
    }
    params.append(key, `${e.expiresAt}.${e.value}`);
  }
  return encodeURIComponent(params.toString());
}

/**
 * The `Set-Cookie` header that stores `entries` as the `__session`
 * container, or expires it when no entry is left.
 *
 * HttpOnly and SameSite=Lax always; Secure when `secure` (every deployed
 * environment — plain-http local development cannot keep a Secure cookie).
 * Max-Age follows the longest-lived entry.
 */
export function sessionSetCookieHeader(
  entries: SessionEntries,
  opts: { readonly nowSeconds: number; readonly secure: boolean },
): string {
  const flags =
    entries.size === 0
      ? [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"]
      : [
          `${SESSION_COOKIE_NAME}=${sessionCookieValue(entries)}`,
          "Path=/",
          "HttpOnly",
          "SameSite=Lax",
          `Max-Age=${Math.max(1, Math.max(...[...entries.values()].map((e) => e.expiresAt)) - opts.nowSeconds)}`,
        ];
  if (opts.secure) flags.push("Secure");
  return flags.join("; ");
}
