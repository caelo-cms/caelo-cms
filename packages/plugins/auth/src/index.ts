// SPDX-License-Identifier: MPL-2.0
//
// CLAUDE: do not regenerate this file. AI configures it via the
// auth_config table behind the §11.A propose/execute gate
// (`propose_auth_config` op); the security-sensitive code (password
// hashing, session token generation, token comparison) stays
// human-authored. CMS_REQUIREMENTS §14.9 + CLAUDE.md §2 invariant:
// auth plugin core logic is locked from AI regeneration.
//
// #1334 (epic #763 E5): the maintainer approved the hardening of this core
// for that one change explicitly (bounded argon2id, no account
// enumeration, mandatory e-mail verification, atomic tokens, normalised
// addresses, cookie-only sessions, per-account login throttle).

/**
 * @caelo-cms/plugin-auth — Tier-1 plugin: visitor authentication.
 *
 * P12 PR2.6 — visitor signup / login / logout / sessions / password reset.
 * OAuth2 (Google + GitHub) via Arctic lands as a follow-up; v1 ships
 * email + password only.
 *
 * Schema (cms_public.plugin_auth.*):
 *   public_users              — id, email (normalised), password_hash, email_verified_at
 *   visitor_sessions          — id, public_user_id, token_hash, expires_at
 *   password_reset_tokens     — id, public_user_id, token_hash, expires_at, used_at
 *   email_verification_tokens — id, public_user_id, token_hash, password_hash, expires_at, used_at
 *   login_throttle            — failed logins per address hash and window
 *   auth_config               — singleton: signup_open, password_min_length
 *
 * Password accounts exist only with a mail transport (`requires: ["email"]`,
 * epic #763 E12), and an account logs in only after its address was
 * verified by mail. Mail goes through the public mail outbox (#1337): the
 * gateway queues a template, the admin sends it.
 */

import {
  attachCaptchaProof,
  escapeHtml,
  KIT_CSS,
  postPluginJson,
  setStatus,
} from "@caelo-cms/plugin-component-kit";
import {
  defineComponent,
  definePlugin,
  MAIL_RECIPIENT_RE,
  type PluginContextTier1,
  type PluginQuery,
  PublicOperationBusyError,
  PublicOperationError,
  z,
} from "@caelo-cms/plugin-sdk";

const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const PASSWORD_RESET_DURATION_MS = 1000 * 60 * 60; // 1 hour
const EMAIL_VERIFICATION_DURATION_MS = 1000 * 60 * 60 * 48; // 48 hours

/**
 * #1334 (#763 H4) — argon2id at OWASP's 19 MiB / 2 passes instead of
 * Bun's 64 MiB default: the strength the cheat sheet names for this
 * memory, at a third of the memory per request. Hashes stored with the
 * old parameters still verify (the parameters are in the hash).
 */
const ARGON2_PARAMS = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;
/** Hashes or verifies one process runs at once (≈19 MiB each). */
const MAX_CONCURRENT_HASHES = 4;
/** A dummy hash with {@link ARGON2_PARAMS}, verified for an unknown address. */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$s911yW1V9p9TiQXBUecrFR4+8oAtRpgvXjZexn1Dja0$45Exl0ycV5zRzeUmKp3U2V8vpl7X2efLHsRlU8n3nwM";
const PASSWORD_MAX = 1024;
const EMAIL_MAX = 254;
/** Every signup and reset request answers no earlier than this (#763 M5). */
const ENUMERATION_FLOOR_MS = 300;
/** Failed logins per address within the window before logins are refused. */
const LOGIN_THROTTLE_MAX_FAILURES = 5;
const LOGIN_THROTTLE_WINDOW_MS = 1000 * 60 * 15;

/** Bounds for `password_min_length`. 8 is the floor every auth surface
 *  has always enforced; 128 caps it so a config typo can't lock every
 *  visitor out. */
const PASSWORD_MIN_LENGTH_FLOOR = 8;
const PASSWORD_MIN_LENGTH_CEILING = 128;

const passwordMinLength = z
  .number()
  .int()
  .min(PASSWORD_MIN_LENGTH_FLOOR)
  .max(PASSWORD_MIN_LENGTH_CEILING);

/** Shared shape for every write of the config (Owner-direct apply, AI
 *  proposal, proposal execution). Validated at the op boundary so an
 *  out-of-range value never reaches a pending proposal. */
const authConfigArgs = z.object({ signupOpen: z.boolean(), passwordMinLength }).strict();

/** The stored singleton, re-validated on every read: a row that drifted
 *  out of range (manual SQL, a build without the bounds) fails loudly
 *  instead of being silently clamped to the floor. */
const authConfigRow = z.object({
  id: z.string(),
  signup_open: z.boolean(),
  password_min_length: passwordMinLength,
  updated_at: z.unknown(),
});

type AuthConfigRow = z.infer<typeof authConfigRow>;

function issuesOf(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/**
 * Read the auth_config singleton. `onActivate` seeds it, so a missing row
 * means activation never ran — a broken install, not a "use the defaults"
 * case (CLAUDE.md §2 no-fallbacks).
 */
async function readAuthConfig(q: PluginQuery, op: string): Promise<AuthConfigRow> {
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

/** Parse config-write args, turning a Zod failure into an AI-actionable error. */
function parseAuthConfigArgs(op: string, args: unknown): z.infer<typeof authConfigArgs> {
  const parsed = authConfigArgs.safeParse(args);
  if (!parsed.success) {
    throw new Error(
      `${op}: invalid input (${issuesOf(parsed.error)}) — passwordMinLength must be an integer ${PASSWORD_MIN_LENGTH_FLOOR}..${PASSWORD_MIN_LENGTH_CEILING}`,
    );
  }
  return parsed.data;
}

/**
 * Delete every session of one visitor. `list` caps at 1000 rows, so this
 * drains page by page until none remain — a single page would let
 * sessions past the first 1000 survive a password reset.
 */
async function revokeAllSessions(q: PluginQuery, publicUserId: string): Promise<void> {
  for (;;) {
    const page = await q.list<"visitor_sessions", { id: string }>("visitor_sessions", {
      public_user_id: publicUserId,
      limit: 1000,
    });
    if (page.length === 0) return;
    for (const s of page) {
      await q.delete("visitor_sessions", s.id);
    }
  }
}

/**
 * #854 — delete the dead rows of a table, all of them. `list` caps at 1000
 * rows, and the sweep used to read one unordered page: past 1000 rows the
 * expired ones beyond it were never deleted. Pages ordered by `expires_at`
 * put the expired rows first, so the sweep deletes page after page and
 * stops at the first page that reaches a row still valid.
 */
/** #1334 — throttle rows whose window closed, page by page (oldest first). */
async function sweepThrottles(q: PluginQuery, now: Date): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await q.list<"login_throttle", { id: string; window_started_at: string }>(
      "login_throttle",
      { orderBy: "window_started_at", orderDir: "asc", limit: 1000 },
    );
    let reachedOpen = false;
    for (const row of page) {
      if (now.getTime() - new Date(row.window_started_at).getTime() < LOGIN_THROTTLE_WINDOW_MS) {
        reachedOpen = true;
        break;
      }
      await q.delete("login_throttle", row.id);
      deleted += 1;
    }
    if (reachedOpen || page.length < 1000) return deleted;
  }
}

async function sweepByExpiry<Row extends { id: string; expires_at: string }>(
  q: PluginQuery,
  table: "visitor_sessions" | "password_reset_tokens" | "email_verification_tokens",
  now: Date,
  isDead: (row: Row & { used_at: string | null }) => boolean,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await q.list<typeof table, Row & { used_at: string | null }>(table, {
      orderBy: "expires_at",
      orderDir: "asc",
      limit: 1000,
    });
    let reachedLive = false;
    for (const row of page) {
      if (new Date(row.expires_at) >= now) reachedLive = true;
      if (isDead({ ...row, used_at: row.used_at ?? null })) {
        await q.delete(table, row.id);
        deleted += 1;
      }
    }
    if (reachedLive || page.length < 1000) return deleted;
  }
}

/**
 * #1334 — the visitor bodies, validated by the host before a handler runs.
 * A password is at most 1024 characters (argon2 over a 64 KB body was a
 * CPU and memory lever, #763 H4); an address at most 254, the longest SMTP
 * delivers. Session tokens never come in a body: only from the HttpOnly
 * cookie (`ctx.visitor.sessionToken`), so no script can hand one over.
 */
const emailField = z.string().trim().min(3).max(EMAIL_MAX);
const passwordField = z.string().max(PASSWORD_MAX);
const tokenField = z.string().min(16).max(128);
const credentialsInput = z.object({ email: emailField, password: passwordField }).strict();
const sessionInput = z.object({}).strict();
const emailInput = z.object({ email: emailField }).strict();
/** A verification link plus the password chosen at that sign-up. */
const verifyInput = z.object({ token: tokenField, password: passwordField }).strict();
const resetInput = z.object({ token: tokenField, newPassword: passwordField }).strict();
/** The address whose login lockout the site's admin lifts. */
const unlockInput = z.object({ email: emailField }).strict();

/**
 * One spelling per address: Unicode NFC, trimmed, lower case. `A@x` and
 * `a@x` are one account (#763 M6).
 */
function normaliseEmail(email: string): string {
  return email.normalize("NFC").trim().toLowerCase();
}

/** The address shape signup accepts (and the mail outbox delivers to). */
function isDeliverableEmail(email: string): boolean {
  return email.length <= EMAIL_MAX && MAIL_RECIPIENT_RE.test(email);
}

/**
 * The addresses an account may be stored under: the normalised one, and
 * the address as typed for an account created before #1334 normalised
 * them (it keeps working with the spelling it was created with).
 */
function storedSpellings(typed: string): string[] {
  const normalised = normaliseEmail(typed);
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
  // The spelling as typed wins: where a pre-#1334 account (`Alice@x`) and
  // a newer one (`alice@x`) coexist, each stays reachable under its own
  // spelling instead of one silently answering for the other.
  const asTyped = typed.trim();
  return rows.find((r) => r.email === asTyped) ?? rows.find((r) => r.email === spellings[0]);
}

/**
 * #1334 (#763 H4) — at most {@link MAX_CONCURRENT_HASHES} argon2 hashes or
 * verifies run at once in this process. Each takes about 19 MiB, so the
 * bound caps their memory; a request beyond it is refused at once with
 * `Busy` (503, Retry-After) instead of queueing until the instance runs
 * out of memory.
 */
let hashesInFlight = 0;

/** Test hook: how many hashes run right now. */
export function argon2InFlight(): number {
  return hashesInFlight;
}

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

/**
 * Resolve no earlier than {@link ENUMERATION_FLOOR_MS} after `startedAt`.
 * Signup and reset do different writes for a known and an unknown address;
 * every answer waits for the same floor, so neither the body nor the time
 * tells them apart (#763 M5). The floor is far above the work it hides.
 */
async function answerAtFloor<T>(startedAt: number, value: T): Promise<T> {
  const wait = startedAt + ENUMERATION_FLOOR_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return value;
}

async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, ARGON2_PARAMS);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

function makeToken(): string {
  // 32 random bytes hex-encoded → 64-char opaque token.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string): Promise<string> {
  // SHA-256 of the raw token; we never store the token itself.
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The single answer of `signup` for every address (#763 M5). */
const SIGNUP_ANSWER = Object.freeze({ awaitingVerification: true as const });
/** The single answer of `request_password_reset` for every address. */
const RESET_REQUEST_ANSWER = Object.freeze({ issued: true as const });

interface ThrottleRow {
  id: string;
  failures: number;
  window_started_at: string;
}

/**
 * #1334 (#763 M6) — the per-account login throttle, keyed by the hash of
 * the normalised address whether or not an account exists, so the
 * throttle itself tells nobody which addresses are registered.
 */
async function loginThrottle(q: PluginQuery, emailHash: string): Promise<ThrottleRow | undefined> {
  const rows = await q.list<"login_throttle", ThrottleRow>("login_throttle", {
    email_hash: emailHash,
    limit: 1,
  });
  return rows[0];
}

function throttleWindowOpen(row: ThrottleRow, now: number): boolean {
  return now - new Date(row.window_started_at).getTime() < LOGIN_THROTTLE_WINDOW_MS;
}

async function recordLoginFailure(
  q: PluginQuery,
  emailHash: string,
  row: ThrottleRow | undefined,
): Promise<void> {
  // Atomic against concurrent failures for one address, on any gateway
  // instance: one row per address (a unique index on `email_hash`), and
  // every change is a compare-and-swap on the count it read. A lost race
  // reads again and retries, so no failure goes uncounted.
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
        // Another request inserted the address's row first.
        current = await loginThrottle(q, emailHash);
        if (!current) throw e;
        continue;
      }
    }
    const patch = throttleWindowOpen(current, now)
      ? { failures: current.failures + 1 }
      : { failures: 1, window_started_at: new Date(now).toISOString() };
    if (
      await q.compareAndSwap("login_throttle", current.id, { failures: current.failures }, patch)
    ) {
      return;
    }
    current = await loginThrottle(q, emailHash);
  }
  throw new Error("login: the failed attempt could not be counted (contended), refusing");
}

/** Issue a session and hand its token to the gateway's HttpOnly cookie. */
async function startSession(ctx: PluginContextTier1, publicUserId: string): Promise<void> {
  const token = makeToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  await ctx.query.insert("visitor_sessions", {
    public_user_id: publicUserId,
    token_hash: await hashToken(token),
    expires_at: expiresAt,
  });
  // The token is NOT returned in the body, so it never lands in
  // JS-readable storage.
  ctx.visitor.setSession?.({ sessionToken: token, expiresAt });
}

/** Queue a verification mail for `account`, carrying the password to set on success. */
async function queueVerification(
  ctx: PluginContextTier1,
  publicUserId: string,
  to: string,
  passwordHash: string,
): Promise<void> {
  const token = makeToken();
  await ctx.query.insert("email_verification_tokens", {
    public_user_id: publicUserId,
    token_hash: await hashToken(token),
    // The password of THIS sign-up: whoever proves the inbox with this
    // link sets it. An earlier, unverified sign-up of the same address
    // (someone squatting it) never gets a usable password.
    password_hash: passwordHash,
    expires_at: new Date(Date.now() + EMAIL_VERIFICATION_DURATION_MS).toISOString(),
  });
  await mailer(ctx).queue({ template: "verify_email", to, token });
}

/** `ctx.email`, which the `email` capability always attaches. */
function mailer(ctx: PluginContextTier1): NonNullable<PluginContextTier1["email"]> {
  if (!ctx.email) throw new Error("auth: the email capability is not attached");
  return ctx.email;
}

/**
 * Atomically claim a single-use token row (`used_at` from null to now).
 * Two concurrent redemptions of one token: exactly one wins (#763 M6).
 */
async function claimToken(
  q: PluginQuery,
  table: "password_reset_tokens" | "email_verification_tokens",
  id: string,
): Promise<boolean> {
  return q.compareAndSwap(table, id, { used_at: null }, { used_at: new Date().toISOString() });
}

export default definePlugin<PluginContextTier1>({
  slug: "auth",
  version: "1.0.0",
  tier: 1,
  schema: {
    public_users: {
      id: "uuid",
      email: "string",
      /**
       * #1334 — SHA-256 of the normalised address, unique: two concurrent
       * sign-ups of one address create one account. Accounts created before
       * have none (a unique index admits any number of nulls).
       */
      email_key: "string",
      password_hash: "string",
      email_verified_at: "timestamp_nullable",
      created_at: "timestamp",
      last_login_at: "timestamp_nullable",
    },
    visitor_sessions: {
      id: "uuid",
      public_user_id: "string",
      token_hash: "string",
      expires_at: "timestamp",
      created_at: "timestamp",
    },
    password_reset_tokens: {
      id: "uuid",
      public_user_id: "string",
      token_hash: "string",
      expires_at: "timestamp",
      used_at: "timestamp_nullable",
      created_at: "timestamp",
    },
    /** #1334 — a sign-up's mailed link and the password it sets on success. */
    email_verification_tokens: {
      id: "uuid",
      public_user_id: "string",
      token_hash: "string",
      password_hash: "string",
      expires_at: "timestamp",
      used_at: "timestamp_nullable",
      created_at: "timestamp",
    },
    /** #1334 — failed logins per address hash (known or not) and window. */
    login_throttle: {
      id: "uuid",
      email_hash: "string",
      failures: "int",
      window_started_at: "timestamp",
      created_at: "timestamp",
    },
    auth_config: {
      id: "uuid",
      signup_open: "bool",
      password_min_length: "int",
      updated_at: "timestamp",
    },
    /**
     * P12 review-pass #4 — real §11.A propose/execute split.
     * AI submits a proposal here; an Owner reviews + applies via
     * /settings/auth/pending. The auth_config singleton is only
     * mutated by `apply_auth_config` (Owner-direct) or
     * `execute_proposal` (Owner-approves-AI).
     */
    auth_config_proposals: {
      id: "uuid",
      proposed_signup_open: "bool",
      proposed_password_min_length: "int",
      proposed_by: "string",
      status: "enum:pending,applied,rejected",
      decided_at: "timestamp_nullable",
      reason: "text",
      created_at: "timestamp",
    },
  },
  /** #1292 — what the visitor path and the sweeps read by. */
  indexes: {
    schema: {
      // Hash: a stored email may predate the 254-character signup bound,
      // and a btree entry holds at most ~2.7 KB (it would fail the build).
      public_users: [
        { columns: ["email"], method: "hash" },
        { columns: ["email_key"], unique: true },
      ],
      visitor_sessions: [["token_hash"], ["public_user_id"], ["expires_at"]],
      password_reset_tokens: [["token_hash"], ["expires_at"]],
      email_verification_tokens: [["token_hash"], ["public_user_id"], ["expires_at"]],
      login_throttle: [{ columns: ["email_hash"], unique: true }, ["window_started_at"]],
      auth_config_proposals: [["status", "created_at"]],
    },
  },
  requestedCapabilities: ["chat_runner_tools", "email", "background_workers"],
  /**
   * #1334 (E12) — password accounts only with a mail transport: an account
   * logs in only after the link in its verification mail was opened.
   */
  requires: ["email"],
  /** #1334 — the mails the auth core queues (#1337 outbox). */
  mailTemplates: {
    verify_email: {
      subject: "Confirm your e-mail address",
      body: [
        "Please confirm your e-mail address to finish creating your account.",
        "If you did not sign up, ignore this mail: without the confirmation nobody can use the account.",
      ],
      link: {
        operation: "verify_email",
        label: "Confirm e-mail address",
        done: "Your e-mail address is confirmed. You can log in now.",
        fields: [{ name: "password", label: "The password you signed up with", type: "password" }],
      },
    },
    signup_existing_account: {
      subject: "You already have an account",
      body: [
        "Someone tried to create an account with this e-mail address, which already has one.",
        "If it was you, log in with your password, or reset it if you no longer know it. If not, you can ignore this mail.",
      ],
    },
    password_reset: {
      subject: "Reset your password",
      body: [
        "Someone asked to reset the password of the account with this e-mail address. The link works once, for one hour.",
        "If it was not you, ignore this mail: your password stays as it is.",
      ],
      link: {
        operation: "reset_password",
        label: "Set a new password",
        done: "Your password is changed. You can log in with it now.",
        fields: [{ name: "newPassword", label: "New password", type: "password" }],
      },
    },
  },
  /** Seed the auth_config singleton with the documented defaults (signup
   *  open, 8-char minimum). Idempotent; read paths never seed. */
  onActivate: async (ctx) => {
    const existing = await ctx.query.list("auth_config", { limit: 1 });
    if (existing.length === 0) {
      await ctx.query.insert("auth_config", {
        signup_open: true,
        password_min_length: PASSWORD_MIN_LENGTH_FLOOR,
      });
    }
  },
  /** Visitor-facing surface (default deny — everything else is
   *  refused a visitor-context dispatch). */
  //
  // #1332 — the declarative contract: shapes, captcha, rate limits and
  // table access. Every write here needs a proof-of-work bound to it,
  // login and both reset steps included (#763 M2).
  publicOperations: [
    {
      name: "signup",
      kind: "write",
      input: credentialsInput,
      rateLimit: { max: 5, windowSeconds: 60 },
      reads: ["auth_config", "public_users"],
      writes: ["public_users", "email_verification_tokens"],
    },
    {
      name: "verify_email",
      kind: "write",
      input: verifyInput,
      rateLimit: { max: 10, windowSeconds: 60 },
      reads: ["email_verification_tokens"],
      writes: ["email_verification_tokens", "public_users"],
    },
    {
      name: "login",
      kind: "write",
      input: credentialsInput,
      rateLimit: { max: 10, windowSeconds: 60 },
      reads: ["login_throttle", "public_users"],
      writes: ["login_throttle", "public_users", "visitor_sessions"],
    },
    {
      name: "logout",
      kind: "write",
      input: sessionInput,
      // Ends only the caller's own session; the rate limit guards it.
      captcha: "none",
      rateLimit: { max: 30, windowSeconds: 60 },
      reads: ["visitor_sessions"],
      writes: ["visitor_sessions"],
    },
    {
      name: "me",
      kind: "read",
      input: sessionInput,
      captcha: "none",
      rateLimit: { max: 60, windowSeconds: 60 },
      reads: ["visitor_sessions", "public_users"],
    },
    {
      name: "request_password_reset",
      kind: "write",
      input: emailInput,
      rateLimit: { max: 3, windowSeconds: 60 },
      reads: ["public_users"],
      writes: ["password_reset_tokens"],
    },
    {
      name: "reset_password",
      kind: "write",
      input: resetInput,
      rateLimit: { max: 5, windowSeconds: 60 },
      reads: ["auth_config", "password_reset_tokens", "visitor_sessions"],
      writes: ["public_users", "password_reset_tokens", "visitor_sessions"],
    },
  ],
  /**
   * #1332 — accounts, sessions and reset tokens are visitor state; the
   * config is the Owner's and visitors only read it; proposals never
   * leave the admin.
   */
  tableKinds: {
    public_users: "visitor-state",
    visitor_sessions: "visitor-state",
    password_reset_tokens: "visitor-state",
    email_verification_tokens: "visitor-state",
    login_throttle: "visitor-state",
    auth_config: "published",
    auth_config_proposals: "private",
  },
  operations: {
    /**
     * #1334 — sign-up with a password, verified by mail before the first
     * login (E12, D5). One answer and one response time for every address
     * (#763 M5): a new address gets an account and a verification link; a
     * known, verified one a note that it already has an account; a known,
     * unverified one a new verification link. No session is issued.
     */
    signup: async (ctx, args) => {
      const startedAt = Date.now();
      const input = args as z.infer<typeof credentialsInput>;
      const email = normaliseEmail(input.email);
      if (!isDeliverableEmail(email)) throw new PublicOperationError("signup: invalid email");
      const cfg = await readAuthConfig(ctx.query, "signup");
      if (!cfg.signup_open) throw new PublicOperationError("signup: registration is closed");
      if (input.password.length < cfg.password_min_length) {
        throw new PublicOperationError(`signup: password >= ${cfg.password_min_length} chars`);
      }
      // Hashed on every path, so the work is the same for every address.
      const password_hash = await withHashSlot(() => hashPassword(input.password));
      const existing = await findAccount<{
        id: string;
        email: string;
        email_verified_at: string | null;
      }>(ctx.query, input.email);
      let account = existing;
      if (!account) {
        // The account exists from now on, but nobody can log in to it until
        // the link proved the inbox (`login` refuses unverified accounts).
        try {
          const r = await ctx.query.insert("public_users", {
            email,
            email_key: await hashToken(email),
            password_hash,
          });
          await queueVerification(ctx, r.id, email, password_hash);
          return answerAtFloor(startedAt, SIGNUP_ANSWER);
        } catch (e) {
          // A concurrent sign-up of the same address created it first
          // (the unique `email_key`): continue as for a known address.
          account = await findAccount<{
            id: string;
            email: string;
            email_verified_at: string | null;
          }>(ctx.query, input.email);
          if (!account) throw e;
        }
      }
      if (account.email_verified_at) {
        await mailer(ctx).queue({ template: "signup_existing_account", to: email });
      } else {
        await queueVerification(ctx, account.id, email, password_hash);
      }
      return answerAtFloor(startedAt, SIGNUP_ANSWER);
    },

    /**
     * #1334 — redeem a verification link: the account is verified and
     * gets the password chosen at that sign-up. The token is single-use
     * (claimed atomically); every other open link of the account dies.
     */
    verify_email: async (ctx, args) => {
      const input = args as z.infer<typeof verifyInput>;
      const rows = await ctx.query.list<
        "email_verification_tokens",
        {
          id: string;
          public_user_id: string;
          password_hash: string;
          expires_at: string;
          used_at: string | null;
        }
      >("email_verification_tokens", { token_hash: await hashToken(input.token), limit: 1 });
      const t = rows[0];
      if (!t || t.used_at || new Date(t.expires_at) < new Date()) {
        throw new PublicOperationError("verify_email: invalid or expired link");
      }
      // The link sets the password of the sign-up it came from, so it works
      // only with that password: a mail an earlier sign-up of someone else
      // triggered (a squatter's) cannot be completed by the inbox owner
      // without knowing the squatter's password, and the squatter never
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
    },

    login: async (ctx, args) => {
      const input = args as z.infer<typeof credentialsInput>;
      const emailHash = await hashToken(normaliseEmail(input.email));
      const throttle = await loginThrottle(ctx.query, emailHash);
      // #1334 (#763 M6) — past the per-account bound, refused without
      // hashing; known and unknown addresses alike.
      if (
        throttle &&
        throttleWindowOpen(throttle, Date.now()) &&
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
      // An unverified account is refused like a wrong password: its
      // password was never confirmed by the inbox owner.
      if (!user || !passwordOk || !user.email_verified_at) {
        await recordLoginFailure(ctx.query, emailHash, throttle);
        throw new PublicOperationError("login: invalid credentials");
      }
      if (throttle) await ctx.query.delete("login_throttle", throttle.id);
      await startSession(ctx, user.id);
      await ctx.query.update("public_users", user.id, {
        last_login_at: new Date().toISOString(),
      });
      return { publicUserId: user.id };
    },

    /** Ends the session of the HttpOnly cookie; never a token from the body. */
    logout: async (ctx, _args) => {
      const token = ctx.visitor.sessionToken;
      if (!token) {
        ctx.visitor.setSession?.(null);
        return { loggedOut: true };
      }
      const matches = await ctx.query.list<"visitor_sessions", { id: string }>("visitor_sessions", {
        token_hash: await hashToken(token),
        limit: 1,
      });
      if (matches[0]) await ctx.query.delete("visitor_sessions", matches[0].id);
      ctx.visitor.setSession?.(null);
      return { loggedOut: true };
    },

    /** The visitor of the HttpOnly session cookie; never a token from the body. */
    me: async (ctx, _args) => {
      const token = ctx.visitor.sessionToken;
      if (!token) return { authenticated: false };
      const sessions = await ctx.query.list<
        "visitor_sessions",
        { public_user_id: string; expires_at: string }
      >("visitor_sessions", { token_hash: await hashToken(token), limit: 1 });
      const session = sessions[0];
      if (!session) return { authenticated: false };
      if (new Date(session.expires_at) < new Date()) return { authenticated: false };
      const users = await ctx.query.list<"public_users", { id: string; email: string }>(
        "public_users",
        { id: session.public_user_id, limit: 1 },
      );
      const u = users[0];
      if (!u) return { authenticated: false };
      return { authenticated: true, publicUserId: u.id, email: u.email };
    },

    /**
     * One answer and one response time for every address (#763 M5): a
     * known account gets a reset link by mail, an unknown address nothing.
     */
    request_password_reset: async (ctx, args) => {
      const startedAt = Date.now();
      const input = args as z.infer<typeof emailInput>;
      const user = await findAccount<{ id: string; email: string }>(ctx.query, input.email);
      if (user) {
        const token = makeToken();
        await ctx.query.insert("password_reset_tokens", {
          public_user_id: user.id,
          token_hash: await hashToken(token),
          expires_at: new Date(Date.now() + PASSWORD_RESET_DURATION_MS).toISOString(),
        });
        await mailer(ctx).queue({ template: "password_reset", to: user.email, token });
      }
      return answerAtFloor(startedAt, RESET_REQUEST_ANSWER);
    },

    reset_password: async (ctx, args) => {
      const input = args as z.infer<typeof resetInput>;
      const cfg = await readAuthConfig(ctx.query, "reset_password");
      if (input.newPassword.length < cfg.password_min_length) {
        throw new PublicOperationError(
          `reset_password: password >= ${cfg.password_min_length} chars`,
        );
      }
      const matches = await ctx.query.list<
        "password_reset_tokens",
        { id: string; public_user_id: string; expires_at: string; used_at: string | null }
      >("password_reset_tokens", { token_hash: await hashToken(input.token), limit: 1 });
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
      // A reset is the recovery path for a compromised account: every
      // session issued under the old password dies with it.
      await revokeAllSessions(ctx.query, t.public_user_id);
      ctx.visitor.setSession?.(null);
      return { reset: true };
    },

    /**
     * #1334 (maintainer decision 2026-11-04) — the site's admin lifts the
     * login lockout of one address before its window ends (a visitor who
     * mistyped their password five times). Routine and reversible: the
     * next failed logins count from zero again. Admin side only (the Owner
     * panel and the AI tool); visitors never reach it. Audited by the host
     * like every admin-side operation (input digest, no address).
     */
    unlock_login: async (ctx, args) => {
      const parsed = unlockInput.safeParse(args);
      if (!parsed.success) {
        throw new Error(
          "unlock_login: invalid input — pass { email } with the address exactly as the visitor signs in",
        );
      }
      const row = await loginThrottle(
        ctx.query,
        await hashToken(normaliseEmail(parsed.data.email)),
      );
      if (!row) return { unlocked: false, wasLocked: false };
      const wasLocked =
        throttleWindowOpen(row, Date.now()) && row.failures >= LOGIN_THROTTLE_MAX_FAILURES;
      await ctx.query.delete("login_throttle", row.id);
      return { unlocked: true, wasLocked };
    },

    /**
     * §11.A propose-style configuration. AI calls this to suggest
     * config changes; an Owner approves separately. v1 ships only the
     * propose half — Owner reviews queued rows in /settings/auth/pending.
     */
    /**
     * `get_auth_config` — read the singleton auth_config row (seeded by
     * `onActivate`; a missing or out-of-range row is a loud error).
     */
    get_auth_config: async (ctx, _args) => {
      const row = await readAuthConfig(ctx.query, "get_auth_config");
      return {
        id: row.id,
        signupOpen: row.signup_open,
        passwordMinLength: row.password_min_length,
        updatedAt: row.updated_at,
      };
    },

    /**
     * `apply_auth_config` — Owner-direct write of the singleton row.
     * Bypasses the propose flow because the Owner UI is the authority.
     * AI must use `propose_auth_config` (which is identical in v1 but
     * documented as the AI's path so the queue can split out later).
     */
    apply_auth_config: async (ctx, args) => {
      const input = parseAuthConfigArgs("apply_auth_config", args);
      const existing = await ctx.query.list<"auth_config", { id: string }>("auth_config", {
        limit: 1,
      });
      if (existing[0]) {
        await ctx.query.update("auth_config", existing[0].id, {
          signup_open: input.signupOpen,
          password_min_length: input.passwordMinLength,
        });
      } else {
        await ctx.query.insert("auth_config", {
          signup_open: input.signupOpen,
          password_min_length: input.passwordMinLength,
        });
      }
      return { applied: true };
    },

    /**
     * P12 review-pass #4 — true §11.A propose op. AI calls this; the
     * row lands at status='pending' in `auth_config_proposals`. The
     * operator approves on the chat's proposal card (queue: /settings/auth/pending); the
     * admin then calls `execute_proposal` which is Owner-gated. AI
     * calling `execute_proposal` directly hits ActorScopeRejected at
     * the registry layer (not enforced here at the plugin level — see
     * the auth admin route's gating).
     */
    propose_auth_config: async (ctx, args) => {
      const input = parseAuthConfigArgs("propose_auth_config", args);
      const r = await ctx.query.insert("auth_config_proposals", {
        proposed_signup_open: input.signupOpen,
        proposed_password_min_length: input.passwordMinLength,
        // The actor that proposed it. Not a visitor operation, so this was
        // never a visitor id (outside the gateway ctx.visitor.id is the
        // system placeholder).
        proposed_by: ctx.invocation.actorId,
        status: "pending",
        reason: "",
      });
      return {
        proposalId: r.id,
        status: "pending" as const,
        message: "Owner reviews queued proposals at /settings/auth/pending.",
      };
    },

    list_pending_proposals: async (ctx, _args) => {
      const rows = await ctx.query.list<
        "auth_config_proposals",
        {
          id: string;
          proposed_signup_open: boolean;
          proposed_password_min_length: number;
          proposed_by: string;
          status: string;
          created_at: string;
        }
      >("auth_config_proposals", {
        status: "pending",
        orderBy: "created_at",
        orderDir: "desc",
        limit: 100,
      });
      return { proposals: rows };
    },

    execute_proposal: async (ctx, args) => {
      const input = args as { proposalId: string };
      const matches = await ctx.query.list<
        "auth_config_proposals",
        {
          id: string;
          proposed_signup_open: boolean;
          proposed_password_min_length: number;
          status: string;
        }
      >("auth_config_proposals", { id: input.proposalId, limit: 1 });
      const p = matches[0];
      if (!p) throw new Error("execute_proposal: proposal not found");
      if (p.status !== "pending") {
        throw new Error(`execute_proposal: proposal is ${p.status}, not pending`);
      }
      // Re-checked at apply time too: a row queued before the propose-time
      // bounds existed must not be applied out of range.
      parseAuthConfigArgs("execute_proposal", {
        signupOpen: p.proposed_signup_open,
        passwordMinLength: p.proposed_password_min_length,
      });
      // Apply the proposed values to the singleton.
      const existing = await ctx.query.list<"auth_config", { id: string }>("auth_config", {
        limit: 1,
      });
      if (existing[0]) {
        await ctx.query.update("auth_config", existing[0].id, {
          signup_open: p.proposed_signup_open,
          password_min_length: p.proposed_password_min_length,
        });
      } else {
        await ctx.query.insert("auth_config", {
          signup_open: p.proposed_signup_open,
          password_min_length: p.proposed_password_min_length,
        });
      }
      await ctx.query.update("auth_config_proposals", p.id, {
        status: "applied",
        decided_at: new Date().toISOString(),
      });
      return { applied: true };
    },

    reject_proposal: async (ctx, args) => {
      const input = args as { proposalId: string; reason?: string };
      await ctx.query.update("auth_config_proposals", input.proposalId, {
        status: "rejected",
        reason: input.reason ?? "",
        decided_at: new Date().toISOString(),
      });
      return { rejected: true };
    },

    /**
     * Worker handler. Sweeps expired sessions + used password-reset tokens.
     * Runs hourly.
     */
    _sweep_expired: async (ctx, _args) => {
      const now = new Date();
      const sessions = await sweepByExpiry(
        ctx.query,
        "visitor_sessions",
        now,
        (s) => new Date(s.expires_at) < now,
      );
      // A used token is dead too; one used within the hour expires (and
      // goes) at the latest on the next hourly run.
      const tokens = await sweepByExpiry(
        ctx.query,
        "password_reset_tokens",
        now,
        (t) => t.used_at !== null || new Date(t.expires_at) < now,
      );
      const verifications = await sweepByExpiry(
        ctx.query,
        "email_verification_tokens",
        now,
        (t) => t.used_at !== null || new Date(t.expires_at) < now,
      );
      const throttles = await sweepThrottles(ctx.query, now);
      return { deleted: sessions + tokens + verifications + throttles };
    },
  },
  /** #1334 — the Owner lifts a visitor's login lockout (also as the AI tool below). */
  adminPanels: [
    {
      slug: "visitor-logins",
      title: "Visitor logins",
      description: "Lift the lockout of a visitor who had too many failed logins.",
      icon: "users",
      permission: "settings.write",
      sections: [
        {
          kind: "form",
          id: "unlock",
          title: "Unlock a visitor's login",
          description:
            "After 5 failed logins within 15 minutes an address is locked for the rest of those 15 minutes. Unlock it now, for example after the visitor asked for help.",
          operation: "unlock_login",
          fields: [
            {
              arg: "email",
              label: "E-mail address",
              input: "text",
              required: true,
              placeholder: "visitor@example.com",
              maxLength: 254,
            },
          ],
          submitLabel: "Unlock",
          successMessage: "Done: the address can log in again.",
        },
      ],
    },
  ],
  tools: [
    {
      name: "unlock_visitor_login",
      description:
        "Lift the login lockout of one visitor address (auth plugin: 5 failed logins in 15 minutes lock that address until the window ends). Use when the operator asks to unlock a visitor, e.g. 'unlock x@y'. Reversible; the address keeps its account and password. `wasLocked: false` means it was not locked.",
      operationName: "unlock_login",
      requiredPermission: "settings.write",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["email"],
        properties: { email: { type: "string", maxLength: 254 } },
      },
    },
    {
      name: "propose_auth_config",
      description:
        "TWO-STEP: propose changes to the auth plugin's config (signupOpen, passwordMinLength). " +
        "This only QUEUES the proposal — the operator approves it on the chat's proposal card (queue: /settings/auth/pending). " +
        "DO NOT claim the change is live; tell the user to review the queue.",
      operationName: "propose_auth_config",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["signupOpen", "passwordMinLength"],
        properties: {
          signupOpen: { type: "boolean" },
          passwordMinLength: { type: "integer", minimum: 8, maximum: 128 },
        },
      },
    },
  ],
  workers: [{ name: "sweep_expired", cron: "0 0 * * * *", operationName: "_sweep_expired" }],
  /**
   * Web Component `<caelo-auth>` — single multi-mode auth surface.
   *
   * Attributes:
   *   mode  — "login" | "signup" | "account" (default "login")
   *
   * P12 review-pass #2: the session token lives in an HttpOnly cookie
   * (set by the gateway on login/signup, cleared on logout). The
   * component never touches the token directly; it just hits
   * /api/plugin/auth/me to discover whether a session is live.
   */
  component: defineComponent({
    tag: "caelo-auth",
    shadowMode: "open",
    mounted: async (host) => {
      const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      const mode = (host.getAttribute("mode") ?? "login") as "login" | "signup" | "account";

      const css = `${KIT_CSS} form { max-width: 24rem; }`;

      function renderLogin(): void {
        root.innerHTML = `
          <style>${css}</style>
          <form novalidate>
            <h3>Log in</h3>
            <input name="email" type="email" placeholder="you@example.com" required autocomplete="email" />
            <input name="password" type="password" placeholder="Password" required autocomplete="current-password" />
            <button type="submit">Log in</button>
            <p data-status aria-live="polite"></p>
          </form>
        `;
        const form = root.querySelector("form") as HTMLFormElement;
        const status = root.querySelector("[data-status]") as HTMLParagraphElement;
        form.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          setStatus(status, "clear");
          const fd = new FormData(form);
          const captcha = await attachCaptchaProof("auth", "login").catch(() => null);
          const r = await postPluginJson("auth", "login", {
            email: fd.get("email"),
            password: fd.get("password"),
            ...(captcha ? { _caelo_captcha: captcha } : {}),
          });
          if (r.ok) {
            host.dispatchEvent(new CustomEvent("caelo-auth:login", { bubbles: true }));
            await renderAccount();
          } else {
            setStatus(
              status,
              "err",
              "Login failed. If you just signed up, confirm your address with the link we mailed you first.",
            );
          }
        });
      }

      function renderSignup(): void {
        root.innerHTML = `
          <style>${css}</style>
          <form novalidate>
            <h3>Sign up</h3>
            <input name="email" type="email" placeholder="you@example.com" required autocomplete="email" />
            <input name="password" type="password" placeholder="Password (8+ chars)" required minlength="8" maxlength="1024" autocomplete="new-password" />
            <button type="submit">Create account</button>
            <p data-status aria-live="polite"></p>
          </form>
        `;
        const form = root.querySelector("form") as HTMLFormElement;
        const status = root.querySelector("[data-status]") as HTMLParagraphElement;
        form.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          setStatus(status, "clear");
          const fd = new FormData(form);
          const captcha = await attachCaptchaProof("auth", "signup").catch(() => null);
          const r = await postPluginJson("auth", "signup", {
            email: fd.get("email"),
            password: fd.get("password"),
            ...(captcha ? { _caelo_captcha: captcha } : {}),
          });
          if (r.ok) {
            // #1334 — the account works once its address is confirmed.
            host.dispatchEvent(new CustomEvent("caelo-auth:signup", { bubbles: true }));
            form.reset();
            setStatus(
              status,
              "ok",
              "Check your inbox: confirm your address with the link we sent you, then log in.",
            );
          } else {
            setStatus(status, "err", "Sign-up failed. Please check your entries and try again.");
          }
        });
      }

      async function renderAccount(): Promise<void> {
        const me = await postPluginJson<{ authenticated: boolean; email?: string }>(
          "auth",
          "me",
          {},
        );
        if (!me.ok || !me.data?.authenticated) {
          renderLogin();
          return;
        }
        const email = me.data.email ?? "";
        root.innerHTML = `
          <style>${css}</style>
          <div>
            <p>Signed in as <strong>${escapeHtml(email)}</strong></p>
            <button type="button" class="secondary" data-logout>Log out</button>
          </div>
        `;
        const logoutBtn = root.querySelector("[data-logout]") as HTMLButtonElement;
        logoutBtn.addEventListener("click", async () => {
          await postPluginJson("auth", "logout", {});
          host.dispatchEvent(new CustomEvent("caelo-auth:logout", { bubbles: true }));
          renderLogin();
        });
      }

      if (mode === "signup") renderSignup();
      else if (mode === "account") await renderAccount();
      else renderLogin();
    },
  }),
});
