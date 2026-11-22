// SPDX-License-Identifier: MPL-2.0
//
// CLAUDE: do not regenerate this file. The visitor login core is locked
// from AI regeneration (CMS_REQUIREMENTS §14.9, CLAUDE.md §2): AI
// configures it (auth_config behind the §11.A gate), never rewrites it.
// The security-sensitive code (password hashing, session tokens, token
// comparison) stays human-authored.
//
// #1334 (epic #763 E5): the maintainer approved the hardening of this core
// for that one change (bounded argon2id, no account enumeration, mandatory
// e-mail verification, atomic tokens, normalised addresses, cookie-only
// sessions, per-account login throttle). #1340 moved it, unchanged, from
// the auth plugin into core, so it runs in the gateway as core code: the
// auth plugin declares its tables and activates the blocks.

/**
 * Core building block `visitor-auth.*` — visitor accounts and sessions:
 * sign-up with mandatory e-mail verification, login with a per-account
 * throttle, logout, `me`, and the password reset. The tables are the
 * auth plugin's (`PUBLIC_BLOCK_CONTRACTS` in the SDK names them); the
 * context is the visitor call's, bound to the declared reads and writes.
 */

import {
  LOGIN_THROTTLE_MAX_FAILURES,
  type LoginThrottleRow,
  loginThrottleOf,
  loginThrottleWindowOpen,
  MAIL_RECIPIENT_RE,
  normaliseVisitorEmail,
  type PluginContextTier1,
  type PluginQuery,
  PublicOperationBusyError,
  PublicOperationError,
  readAuthConfig,
  sha256HexOf,
  VISITOR_EMAIL_MAX,
  type visitorAuthInputs,
} from "@caelo-cms/plugin-sdk";
import type { z } from "zod";

const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const PASSWORD_RESET_DURATION_MS = 1000 * 60 * 60; // 1 hour
const EMAIL_VERIFICATION_DURATION_MS = 1000 * 60 * 60 * 48; // 48 hours

/**
 * #1334 (#763 H4) — argon2id with OWASP's minimum (19 MiB, t=2): each
 * hash takes about 19 MiB, bounded by {@link MAX_CONCURRENT_HASHES}.
 */
const ARGON2_PARAMS = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;
const MAX_CONCURRENT_HASHES = 4;
/** A hash with the same parameters, verified for an unknown address (same time either way). */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$s911yW1V9p9TiQXBUecrFR4+8oAtRpgvXjZexn1Dja0$45Exl0ycV5zRzeUmKp3U2V8vpl7X2efLHsRlU8n3nwM";
/** Every answer of signup and the reset request waits this long (#763 M5). */
const ENUMERATION_FLOOR_MS = 300;

/** The address shape signup accepts (and the mail outbox delivers to). */
function isDeliverableEmail(email: string): boolean {
  return email.length <= VISITOR_EMAIL_MAX && MAIL_RECIPIENT_RE.test(email);
}

/**
 * The addresses an account may be stored under: the normalised one, and
 * the address as typed for an account created before #1334 normalised
 * them (it keeps working with the spelling it was created with).
 */
function storedSpellings(typed: string): string[] {
  const normalised = normaliseVisitorEmail(typed);
  const asTyped = typed.trim();
  return asTyped === normalised ? [normalised] : [normalised, asTyped];
}

/** The account stored under one of the address's spellings, the typed one first. */
async function findAccount<T extends { id: string; email: string }>(
  q: PluginQuery,
  typed: string,
): Promise<T | undefined> {
  const spellings = storedSpellings(typed);
  const rows = await q.list<"public_users", T>("public_users", {
    anyOf: { email: spellings },
    limit: 2,
  });
  const asTyped = typed.trim();
  return rows.find((r) => r.email === asTyped) ?? rows.find((r) => r.email === spellings[0]);
}

let hashesInFlight = 0;

/** Test hook: how many hashes run right now in this process. */
export function argon2InFlight(): number {
  return hashesInFlight;
}

/**
 * At most {@link MAX_CONCURRENT_HASHES} argon2 hashes or verifies at once in
 * this process; a request beyond it is refused at once with `Busy` (503,
 * Retry-After) instead of queueing until the instance runs out of memory.
 */
async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (hashesInFlight >= MAX_CONCURRENT_HASHES) {
    throw new PublicOperationBusyError("auth: password hashing is at capacity");
  }
  hashesInFlight += 1;
  try {
    return await fn();
  } finally {
    hashesInFlight -= 1;
  }
}

/** Resolve no earlier than {@link ENUMERATION_FLOOR_MS} after `startedAt` (#763 M5). */
async function answerAtFloor<T>(startedAt: number, value: T): Promise<T> {
  const wait = startedAt + ENUMERATION_FLOOR_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return value;
}

function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, ARGON2_PARAMS);
}

function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

function makeToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The single answer of `signup` for every address (#763 M5). */
const SIGNUP_ANSWER = Object.freeze({ awaitingVerification: true as const });
/** The single answer of `request_password_reset` for every address. */
const RESET_REQUEST_ANSWER = Object.freeze({ issued: true as const });

async function recordLoginFailure(
  q: PluginQuery,
  emailHash: string,
  row: LoginThrottleRow | undefined,
): Promise<void> {
  let current = row;
  for (let attempt = 0; attempt < 8; attempt++) {
    const now = Date.now();
    if (!current) {
      try {
        await q.insert("login_throttle", {
          email_hash: emailHash,
          failures: 1,
          window_started_at: new Date(now).toISOString(),
        });
        return;
      } catch (e) {
        current = await loginThrottleOf(q, emailHash);
        if (!current) throw e;
        continue;
      }
    }
    const patch = loginThrottleWindowOpen(current, now)
      ? { failures: current.failures + 1 }
      : { failures: 1, window_started_at: new Date(now).toISOString() };
    if (
      await q.compareAndSwap("login_throttle", current.id, { failures: current.failures }, patch)
    ) {
      return;
    }
    current = await loginThrottleOf(q, emailHash);
  }
  throw new Error("login: the failed attempt could not be counted (contended), refusing");
}

/**
 * Delete every session of one visitor. `list` caps at 1000 rows, so this
 * drains page by page until none remain.
 */
async function revokeAllSessions(q: PluginQuery, publicUserId: string): Promise<void> {
  for (;;) {
    const page = await q.list<"visitor_sessions", { id: string }>("visitor_sessions", {
      public_user_id: publicUserId,
      limit: 1000,
    });
    if (page.length === 0) return;
    for (const s of page) await q.delete("visitor_sessions", s.id);
  }
}

/** Issue a session and hand its token to the gateway's HttpOnly cookie. */
async function startSession(ctx: PluginContextTier1, publicUserId: string): Promise<void> {
  const token = makeToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  await ctx.query.insert("visitor_sessions", {
    public_user_id: publicUserId,
    token_hash: await sha256HexOf(token),
    expires_at: expiresAt,
  });
  ctx.visitor.setSession?.({ sessionToken: token, expiresAt });
}

/** `ctx.email`, which the `email` capability attaches. */
function mailer(ctx: PluginContextTier1): NonNullable<PluginContextTier1["email"]> {
  if (!ctx.email) throw new Error("visitor-auth: the email capability is not attached");
  return ctx.email;
}

/** Queue a verification mail for an account, carrying the password to set on success. */
async function queueVerification(
  ctx: PluginContextTier1,
  publicUserId: string,
  to: string,
  passwordHash: string,
): Promise<void> {
  const token = makeToken();
  await ctx.query.insert("email_verification_tokens", {
    public_user_id: publicUserId,
    token_hash: await sha256HexOf(token),
    // The password of THIS sign-up: whoever proves the inbox with this
    // link sets it. An earlier, unverified sign-up of the same address
    // (someone squatting it) never gets a usable password.
    password_hash: passwordHash,
    expires_at: new Date(Date.now() + EMAIL_VERIFICATION_DURATION_MS).toISOString(),
  });
  await mailer(ctx).queue({ template: "verify_email", to, token });
}

/** Atomically claim a single-use token row (`used_at` from null to now, #763 M6). */
function claimToken(
  q: PluginQuery,
  table: "password_reset_tokens" | "email_verification_tokens",
  id: string,
): Promise<boolean> {
  return q.compareAndSwap(table, id, { used_at: null }, { used_at: new Date().toISOString() });
}

type Credentials = z.infer<(typeof visitorAuthInputs)["credentials"]>;
type Verify = z.infer<(typeof visitorAuthInputs)["verify"]>;
type EmailOnly = z.infer<(typeof visitorAuthInputs)["email"]>;
type Reset = z.infer<(typeof visitorAuthInputs)["reset"]>;

/**
 * Sign-up with a password, verified by mail before the first login (E12,
 * D5). One answer and one response time for every address (#763 M5): a
 * new address gets an account and a verification link; a known, verified
 * one a note that it already has an account; a known, unverified one a new
 * verification link. No session is issued.
 */
async function signup(ctx: PluginContextTier1, args: unknown): Promise<unknown> {
  const startedAt = Date.now();
  const input = args as Credentials;
  const email = normaliseVisitorEmail(input.email);
  if (!isDeliverableEmail(email)) throw new PublicOperationError("signup: invalid email");
  const cfg = await readAuthConfig(ctx.query, "signup");
  if (!cfg.signup_open) throw new PublicOperationError("signup: registration is closed");
  if (input.password.length < cfg.password_min_length) {
    throw new PublicOperationError(`signup: password >= ${cfg.password_min_length} chars`);
  }
  // Hashed on every path, so the work is the same for every address.
  const password_hash = await withHashSlot(() => hashPassword(input.password));
  type Account = { id: string; email: string; email_verified_at: string | null };
  let account = await findAccount<Account>(ctx.query, input.email);
  if (!account) {
    // The account exists from now on, but nobody can log in to it until
    // the link proved the inbox (`login` refuses unverified accounts).
    try {
      const r = await ctx.query.insert("public_users", {
        email,
        email_key: await sha256HexOf(email),
        password_hash,
      });
      await queueVerification(ctx, r.id, email, password_hash);
      return answerAtFloor(startedAt, SIGNUP_ANSWER);
    } catch (e) {
      // A concurrent sign-up of the same address created it first (the
      // unique `email_key`): continue as for a known address.
      account = await findAccount<Account>(ctx.query, input.email);
      if (!account) throw e;
    }
  }
  if (account.email_verified_at) {
    await mailer(ctx).queue({ template: "signup_existing_account", to: email });
  } else {
    await queueVerification(ctx, account.id, email, password_hash);
  }
  return answerAtFloor(startedAt, SIGNUP_ANSWER);
}

/**
 * Redeem a verification link: the account is verified and gets the
 * password chosen at that sign-up. The token is single-use (claimed
 * atomically); every other open link of the account dies.
 */
async function verifyEmail(ctx: PluginContextTier1, args: unknown): Promise<unknown> {
  const input = args as Verify;
  const rows = await ctx.query.list<
    "email_verification_tokens",
    {
      id: string;
      public_user_id: string;
      password_hash: string;
      expires_at: string;
      used_at: string | null;
    }
  >("email_verification_tokens", { token_hash: await sha256HexOf(input.token), limit: 1 });
  const t = rows[0];
  if (!t || t.used_at || new Date(t.expires_at) < new Date()) {
    throw new PublicOperationError("verify_email: invalid or expired link");
  }
  // The link sets the password of the sign-up it came from, so it works
  // only with that password: a squatter's mail cannot be completed by the
  // inbox owner without the squatter's password, and the squatter never
  // gets the mail. The slot is taken before the claim, so a Busy answer
  // does not use up the link.
  await withHashSlot(async () => {
    if (!(await verifyPassword(input.password, t.password_hash))) {
      throw new PublicOperationError("verify_email: invalid or expired link");
    }
    if (!(await claimToken(ctx.query, "email_verification_tokens", t.id))) {
      throw new PublicOperationError("verify_email: invalid or expired link");
    }
  });
  await ctx.query.update("public_users", t.public_user_id, {
    password_hash: t.password_hash,
    email_verified_at: new Date().toISOString(),
  });
  for (const other of await ctx.query.list<"email_verification_tokens", { id: string }>(
    "email_verification_tokens",
    { public_user_id: t.public_user_id, limit: 1000 },
  )) {
    if (other.id !== t.id) await ctx.query.delete("email_verification_tokens", other.id);
  }
  return { verified: true };
}

async function login(ctx: PluginContextTier1, args: unknown): Promise<unknown> {
  const input = args as Credentials;
  const emailHash = await sha256HexOf(normaliseVisitorEmail(input.email));
  const throttle = await loginThrottleOf(ctx.query, emailHash);
  // #1334 (#763 M6) — past the per-account bound, refused without hashing;
  // known and unknown addresses alike.
  if (
    throttle &&
    loginThrottleWindowOpen(throttle, Date.now()) &&
    throttle.failures >= LOGIN_THROTTLE_MAX_FAILURES
  ) {
    throw new PublicOperationError("login: too many attempts, try again later");
  }
  const user = await findAccount<{
    id: string;
    email: string;
    password_hash: string;
    email_verified_at: string | null;
  }>(ctx.query, input.email);
  // An unknown address verifies against a dummy hash with the same
  // parameters, so the answer takes as long either way.
  const passwordOk = await withHashSlot(() =>
    verifyPassword(input.password, user?.password_hash ?? DUMMY_PASSWORD_HASH),
  );
  // An unverified account is refused like a wrong password.
  if (!user || !passwordOk || !user.email_verified_at) {
    await recordLoginFailure(ctx.query, emailHash, throttle);
    throw new PublicOperationError("login: invalid credentials");
  }
  if (throttle) await ctx.query.delete("login_throttle", throttle.id);
  await startSession(ctx, user.id);
  await ctx.query.update("public_users", user.id, { last_login_at: new Date().toISOString() });
  return { publicUserId: user.id };
}

/** Ends the session of the HttpOnly cookie; never a token from the body. */
async function logout(ctx: PluginContextTier1): Promise<unknown> {
  const token = ctx.visitor.sessionToken;
  if (!token) {
    ctx.visitor.setSession?.(null);
    return { loggedOut: true };
  }
  const matches = await ctx.query.list<"visitor_sessions", { id: string }>("visitor_sessions", {
    token_hash: await sha256HexOf(token),
    limit: 1,
  });
  if (matches[0]) await ctx.query.delete("visitor_sessions", matches[0].id);
  ctx.visitor.setSession?.(null);
  return { loggedOut: true };
}

/** The visitor of the HttpOnly session cookie; never a token from the body. */
async function me(ctx: PluginContextTier1): Promise<unknown> {
  const token = ctx.visitor.sessionToken;
  if (!token) return { authenticated: false };
  const sessions = await ctx.query.list<
    "visitor_sessions",
    { public_user_id: string; expires_at: string }
  >("visitor_sessions", { token_hash: await sha256HexOf(token), limit: 1 });
  const session = sessions[0];
  if (!session || new Date(session.expires_at) < new Date()) return { authenticated: false };
  const users = await ctx.query.list<"public_users", { id: string; email: string }>(
    "public_users",
    { id: session.public_user_id, limit: 1 },
  );
  const u = users[0];
  if (!u) return { authenticated: false };
  return { authenticated: true, publicUserId: u.id, email: u.email };
}

/**
 * One answer and one response time for every address (#763 M5): a known
 * account gets a reset link by mail, an unknown address nothing.
 */
async function requestPasswordReset(ctx: PluginContextTier1, args: unknown): Promise<unknown> {
  const startedAt = Date.now();
  const input = args as EmailOnly;
  const user = await findAccount<{ id: string; email: string }>(ctx.query, input.email);
  if (user) {
    const token = makeToken();
    await ctx.query.insert("password_reset_tokens", {
      public_user_id: user.id,
      token_hash: await sha256HexOf(token),
      expires_at: new Date(Date.now() + PASSWORD_RESET_DURATION_MS).toISOString(),
    });
    await mailer(ctx).queue({ template: "password_reset", to: user.email, token });
  }
  return answerAtFloor(startedAt, RESET_REQUEST_ANSWER);
}

async function resetPassword(ctx: PluginContextTier1, args: unknown): Promise<unknown> {
  const input = args as Reset;
  const cfg = await readAuthConfig(ctx.query, "reset_password");
  if (input.newPassword.length < cfg.password_min_length) {
    throw new PublicOperationError(`reset_password: password >= ${cfg.password_min_length} chars`);
  }
  const matches = await ctx.query.list<
    "password_reset_tokens",
    { id: string; public_user_id: string; expires_at: string; used_at: string | null }
  >("password_reset_tokens", { token_hash: await sha256HexOf(input.token), limit: 1 });
  const t = matches[0];
  if (!t || t.used_at || new Date(t.expires_at) < new Date()) {
    throw new PublicOperationError("reset_password: invalid or expired token");
  }
  // The slot first: a Busy answer must not have used up the token.
  await withHashSlot(async () => {
    // Atomic: of two concurrent redemptions, exactly one gets here.
    if (!(await claimToken(ctx.query, "password_reset_tokens", t.id))) {
      throw new PublicOperationError("reset_password: invalid or expired token");
    }
    const password_hash = await hashPassword(input.newPassword);
    // The link came by mail, so it proves the inbox like a verification.
    await ctx.query.update("public_users", t.public_user_id, {
      password_hash,
      email_verified_at: new Date().toISOString(),
    });
  });
  // A reset is the recovery path for a compromised account: every session
  // issued under the old password dies with it.
  await revokeAllSessions(ctx.query, t.public_user_id);
  ctx.visitor.setSession?.(null);
  return { reset: true };
}

/** The `visitor-auth.*` blocks. */
export const VISITOR_AUTH_BLOCKS = {
  "visitor-auth.signup": signup,
  "visitor-auth.verify-email": verifyEmail,
  "visitor-auth.login": login,
  "visitor-auth.logout": logout,
  "visitor-auth.me": me,
  "visitor-auth.request-password-reset": requestPasswordReset,
  "visitor-auth.reset-password": resetPassword,
} as const;
