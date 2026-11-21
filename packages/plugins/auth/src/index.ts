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
  LOGIN_THROTTLE_MAX_FAILURES,
  LOGIN_THROTTLE_WINDOW_MS,
  loginThrottleOf,
  loginThrottleWindowOpen,
  normaliseVisitorEmail,
  PASSWORD_MIN_LENGTH_CEILING,
  PASSWORD_MIN_LENGTH_FLOOR,
  type PluginContextTier1,
  type PluginQuery,
  passwordMinLength,
  readAuthConfig,
  sha256HexOf,
  visitorAuthInputs,
  z,
} from "@caelo-cms/plugin-sdk";

/**
 * #1340 — the visitor operations (sign-up, verification, login, logout,
 * `me`, password reset) are core's `visitor-auth` building block
 * (packages/plugin-host/src/public-blocks/visitor-auth.ts), run from this
 * plugin's declarations in the gateway; no code of this plugin answers a
 * visitor. What stays here is the Owner's side: the configuration behind
 * the §11.A gate, lifting a lockout, and the sweeps of expired rows.
 */

const authConfigArgs = z.object({ signupOpen: z.boolean(), passwordMinLength }).strict();

function issuesOf(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/**
 * Read the auth_config singleton. `onActivate` seeds it, so a missing row
 * means activation never ran — a broken install, not a "use the defaults"
 * case (CLAUDE.md §2 no-fallbacks).
 */
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

/** The address whose login lockout the site's admin lifts. */
const unlockInput = z.object({ email: visitorAuthInputs.email.shape.email }).strict();

export default definePlugin<PluginContextTier1>({
  slug: "auth",
  version: "1.1.0",
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
      input: visitorAuthInputs.credentials,
      rateLimit: { max: 5, windowSeconds: 60 },
      reads: ["auth_config", "public_users"],
      writes: ["public_users", "email_verification_tokens"],
      run: { action: "block", block: "visitor-auth.signup" },
    },
    {
      name: "verify_email",
      kind: "write",
      input: visitorAuthInputs.verify,
      rateLimit: { max: 10, windowSeconds: 60 },
      reads: ["email_verification_tokens"],
      writes: ["email_verification_tokens", "public_users"],
      run: { action: "block", block: "visitor-auth.verify-email" },
    },
    {
      name: "login",
      kind: "write",
      input: visitorAuthInputs.credentials,
      rateLimit: { max: 10, windowSeconds: 60 },
      reads: ["login_throttle", "public_users"],
      writes: ["login_throttle", "public_users", "visitor_sessions"],
      run: { action: "block", block: "visitor-auth.login" },
    },
    {
      name: "logout",
      kind: "write",
      input: visitorAuthInputs.session,
      // Ends only the caller's own session; the rate limit guards it.
      captcha: "none",
      rateLimit: { max: 30, windowSeconds: 60 },
      reads: ["visitor_sessions"],
      writes: ["visitor_sessions"],
      run: { action: "block", block: "visitor-auth.logout" },
    },
    {
      name: "me",
      kind: "read",
      input: visitorAuthInputs.session,
      captcha: "none",
      rateLimit: { max: 60, windowSeconds: 60 },
      reads: ["visitor_sessions", "public_users"],
      run: { action: "block", block: "visitor-auth.me" },
    },
    {
      name: "request_password_reset",
      kind: "write",
      input: visitorAuthInputs.email,
      rateLimit: { max: 3, windowSeconds: 60 },
      reads: ["public_users"],
      writes: ["password_reset_tokens"],
      run: { action: "block", block: "visitor-auth.request-password-reset" },
    },
    {
      name: "reset_password",
      kind: "write",
      input: visitorAuthInputs.reset,
      rateLimit: { max: 5, windowSeconds: 60 },
      reads: ["auth_config", "password_reset_tokens", "visitor_sessions"],
      writes: ["public_users", "password_reset_tokens", "visitor_sessions"],
      run: { action: "block", block: "visitor-auth.reset-password" },
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
      const row = await loginThrottleOf(
        ctx.query,
        await sha256HexOf(normaliseVisitorEmail(parsed.data.email)),
      );
      if (!row) return { unlocked: false, wasLocked: false };
      const wasLocked =
        loginThrottleWindowOpen(row, Date.now()) && row.failures >= LOGIN_THROTTLE_MAX_FAILURES;
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
