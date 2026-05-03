// SPDX-License-Identifier: MPL-2.0
//
// CLAUDE: do not regenerate this file. AI configures it via the
// auth_config table behind the §11.A propose/execute gate
// (`propose_auth_config` op); the security-sensitive code (password
// hashing, session token generation, token comparison) stays
// human-authored. CMS_REQUIREMENTS §14.9 + CLAUDE.md §2 invariant:
// auth plugin core logic is locked from AI regeneration.

/**
 * @caelo/plugin-auth — Tier-1 plugin: visitor authentication.
 *
 * P12 PR2.6 — visitor signup / login / logout / sessions / password reset.
 * OAuth2 (Google + GitHub) via Arctic lands as a follow-up; v1 ships
 * email + password only.
 *
 * Schema (cms_public.plugin_auth.*):
 *   public_users          — id, email, password_hash, email_verified_at
 *   visitor_sessions      — id, public_user_id, token_hash, expires_at
 *   password_reset_tokens — id, public_user_id, token_hash, expires_at, used_at
 *   auth_config           — singleton: signup_open, password_min_length
 */

import {
  attachCaptchaProof,
  escapeHtml,
  KIT_CSS,
  postPluginJson,
  setStatus,
} from "@caelo/plugin-component-kit";
import { defineComponent, definePlugin, type PluginContextTier1 } from "@caelo/plugin-sdk";

const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const PASSWORD_RESET_DURATION_MS = 1000 * 60 * 60; // 1 hour

interface SignupInput {
  email: string;
  password: string;
}

interface LoginInput {
  email: string;
  password: string;
}

async function hashPassword(password: string): Promise<string> {
  // Bun-native argon2id. Same algo as admin user passwords (P2).
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

function makeSessionToken(): string {
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

export default definePlugin<PluginContextTier1>({
  slug: "auth",
  version: "1.0.0",
  tier: 1,
  schema: {
    public_users: {
      id: "uuid",
      email: "string",
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
    auth_config: {
      id: "uuid",
      signup_open: "bool",
      password_min_length: "int",
      updated_at: "timestamp",
    },
    /**
     * P12 review-pass #4 — real §11.A propose/execute split.
     * AI submits a proposal here; an Owner reviews + applies via
     * /security/auth/pending. The auth_config singleton is only
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
  requestedCapabilities: ["chat_runner_tools", "email", "background_workers"],
  operations: {
    signup: async (ctx, args) => {
      const input = args as SignupInput;
      if (!input.email.includes("@")) throw new Error("signup: invalid email");
      if (input.password.length < 8) throw new Error("signup: password >= 8 chars");
      const ok = await ctx.captcha.requireProof(null);
      if (!ok) throw new Error("signup: captcha verification failed");

      const existing = await ctx.query.list<"public_users", { id: string }>("public_users", {
        email: input.email,
        limit: 1,
      });
      if (existing[0]) throw new Error("signup: email already registered");

      const password_hash = await hashPassword(input.password);
      const r = await ctx.query.insert("public_users", {
        email: input.email,
        password_hash,
      });

      // Issue a session immediately so the visitor is logged in.
      const token = makeSessionToken();
      const token_hash = await hashToken(token);
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
      await ctx.query.insert("visitor_sessions", {
        public_user_id: r.id,
        token_hash,
        expires_at: expiresAt,
      });
      // P12 review-pass #2 — gateway sets HttpOnly cookie from this
      // marker. The token is NOT returned in the response body so it
      // never lands in localStorage / JS-readable storage.
      ctx.visitor.setSession?.({ sessionToken: token, expiresAt });
      return { publicUserId: r.id };
    },

    login: async (ctx, args) => {
      const input = args as LoginInput;
      const matches = await ctx.query.list<"public_users", { id: string; password_hash: string }>(
        "public_users",
        { email: input.email, limit: 1 },
      );
      const user = matches[0];
      if (!user) {
        // Constant-time-ish: still hash a dummy to avoid timing leak. Bun's
        // verify takes ~50ms regardless on a real hash; we just call it.
        await verifyPassword(
          input.password,
          "$argon2id$v=19$m=65536,t=2,p=1$Z2VuZXJpY2dlbmVyaWM$0YpuVZB+B3oAU6CWBe1uCC2YJ8YTJYjzCqj5VZmqDzg",
        );
        throw new Error("login: invalid credentials");
      }
      const ok = await verifyPassword(input.password, user.password_hash);
      if (!ok) throw new Error("login: invalid credentials");

      const token = makeSessionToken();
      const token_hash = await hashToken(token);
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
      await ctx.query.insert("visitor_sessions", {
        public_user_id: user.id,
        token_hash,
        expires_at: expiresAt,
      });
      await ctx.query.update("public_users", user.id, {
        last_login_at: new Date().toISOString(),
      });
      // P12 review-pass #2 — set the HttpOnly cookie via the marker.
      ctx.visitor.setSession?.({ sessionToken: token, expiresAt });
      return { publicUserId: user.id };
    },

    /**
     * Reads the session token from the HttpOnly cookie via
     * ctx.visitor.sessionToken (set by the gateway from `caelo_session`).
     * No token in the request body — there's nothing for client-side
     * JS to forge. Tests / internal calls may pass `sessionToken` as
     * an arg as a fallback, but production traffic never does.
     */
    logout: async (ctx, args) => {
      const argInput = (args ?? {}) as { sessionToken?: string };
      const token = argInput.sessionToken ?? ctx.visitor.sessionToken;
      if (!token) {
        ctx.visitor.setSession?.(null);
        return { loggedOut: true };
      }
      const tokenHash = await hashToken(token);
      const matches = await ctx.query.list<"visitor_sessions", { id: string }>("visitor_sessions", {
        token_hash: tokenHash,
        limit: 1,
      });
      if (matches[0]) await ctx.query.delete("visitor_sessions", matches[0].id);
      // P12 review-pass #2 — clear the HttpOnly cookie via the marker.
      ctx.visitor.setSession?.(null);
      return { loggedOut: true };
    },

    me: async (ctx, args) => {
      const argInput = (args ?? {}) as { sessionToken?: string };
      const token = argInput.sessionToken ?? ctx.visitor.sessionToken;
      if (!token) return { authenticated: false };
      const tokenHash = await hashToken(token);
      const sessions = await ctx.query.list<
        "visitor_sessions",
        { public_user_id: string; expires_at: string }
      >("visitor_sessions", { token_hash: tokenHash, limit: 1 });
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

    request_password_reset: async (ctx, args) => {
      const input = args as { email: string };
      const matches = await ctx.query.list<"public_users", { id: string }>("public_users", {
        email: input.email,
        limit: 1,
      });
      // Always return ok — never reveal whether the email exists.
      if (!matches[0]) return { issued: true };
      const token = makeSessionToken();
      const token_hash = await hashToken(token);
      await ctx.query.insert("password_reset_tokens", {
        public_user_id: matches[0].id,
        token_hash,
        expires_at: new Date(Date.now() + PASSWORD_RESET_DURATION_MS).toISOString(),
      });
      if (ctx.email) {
        await ctx.email.send({
          to: input.email,
          subject: "Reset your password",
          html: `<p>Use this token within 1 hour: <code>${token}</code></p>`,
        });
      }
      return { issued: true };
    },

    reset_password: async (ctx, args) => {
      const input = args as { token: string; newPassword: string };
      if (input.newPassword.length < 8) throw new Error("reset_password: password >= 8 chars");
      const tokenHash = await hashToken(input.token);
      const matches = await ctx.query.list<
        "password_reset_tokens",
        { id: string; public_user_id: string; expires_at: string; used_at: string | null }
      >("password_reset_tokens", { token_hash: tokenHash, limit: 1 });
      const t = matches[0];
      if (!t) throw new Error("reset_password: invalid token");
      if (t.used_at) throw new Error("reset_password: token already used");
      if (new Date(t.expires_at) < new Date()) throw new Error("reset_password: token expired");
      const password_hash = await hashPassword(input.newPassword);
      await ctx.query.update("public_users", t.public_user_id, { password_hash });
      await ctx.query.update("password_reset_tokens", t.id, {
        used_at: new Date().toISOString(),
      });
      return { reset: true };
    },

    /**
     * §11.A propose-style configuration. AI calls this to suggest
     * config changes; an Owner approves separately. v1 ships only the
     * propose half — Owner reviews queued rows in /security/auth/pending.
     */
    /**
     * `get_auth_config` — read the singleton auth_config row. Returns
     * defaults (`signupOpen=true, passwordMinLength=8`) when the row
     * doesn't exist yet (fresh install).
     */
    get_auth_config: async (ctx, _args) => {
      const rows = await ctx.query.list<
        "auth_config",
        { id: string; signup_open: boolean; password_min_length: number; updated_at: string }
      >("auth_config", { limit: 1 });
      if (!rows[0]) {
        return { id: null, signupOpen: true, passwordMinLength: 8, updatedAt: null };
      }
      return {
        id: rows[0].id,
        signupOpen: rows[0].signup_open,
        passwordMinLength: rows[0].password_min_length,
        updatedAt: rows[0].updated_at,
      };
    },

    /**
     * `apply_auth_config` — Owner-direct write of the singleton row.
     * Bypasses the propose flow because the Owner UI is the authority.
     * AI must use `propose_auth_config` (which is identical in v1 but
     * documented as the AI's path so the queue can split out later).
     */
    apply_auth_config: async (ctx, args) => {
      const input = args as { signupOpen: boolean; passwordMinLength: number };
      if (input.passwordMinLength < 8) throw new Error("apply_auth_config: min 8 chars");
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
     * Owner reviews + clicks Approve at /security/auth/pending; the
     * admin then calls `execute_proposal` which is Owner-gated. AI
     * calling `execute_proposal` directly hits ActorScopeRejected at
     * the registry layer (not enforced here at the plugin level — see
     * the auth admin route's gating).
     */
    propose_auth_config: async (ctx, args) => {
      const input = args as { signupOpen: boolean; passwordMinLength: number };
      if (input.passwordMinLength < 8) throw new Error("propose_auth_config: min 8 chars");
      const r = await ctx.query.insert("auth_config_proposals", {
        proposed_signup_open: input.signupOpen,
        proposed_password_min_length: input.passwordMinLength,
        proposed_by: ctx.visitor.id,
        status: "pending",
        reason: "",
      });
      return {
        proposalId: r.id,
        status: "pending" as const,
        message: "Owner reviews queued proposals at /security/auth/pending.",
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
      const sessions = await ctx.query.list<"visitor_sessions", { id: string; expires_at: string }>(
        "visitor_sessions",
        { limit: 1000 },
      );
      let deleted = 0;
      const now = new Date();
      for (const s of sessions) {
        if (new Date(s.expires_at) < now) {
          await ctx.query.delete("visitor_sessions", s.id);
          deleted += 1;
        }
      }
      const tokens = await ctx.query.list<
        "password_reset_tokens",
        { id: string; expires_at: string; used_at: string | null }
      >("password_reset_tokens", { limit: 1000 });
      for (const t of tokens) {
        if (t.used_at || new Date(t.expires_at) < now) {
          await ctx.query.delete("password_reset_tokens", t.id);
          deleted += 1;
        }
      }
      return { deleted };
    },
  },
  tools: [
    {
      name: "propose_auth_config",
      description:
        "TWO-STEP: propose changes to the auth plugin's config (signupOpen, passwordMinLength). " +
        "This only QUEUES the proposal — an Owner must click Approve at /security/auth/pending. " +
        "DO NOT claim the change is live; tell the user to review the queue.",
      operationName: "propose_auth_config",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["signupOpen", "passwordMinLength"],
        properties: {
          signupOpen: { type: "boolean" },
          passwordMinLength: { type: "number", minimum: 8, maximum: 128 },
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
          const captcha = await attachCaptchaProof().catch(() => null);
          const r = await postPluginJson("auth", "login", {
            email: fd.get("email"),
            password: fd.get("password"),
            ...(captcha ? { _caelo_captcha: captcha } : {}),
          });
          if (r.ok) {
            host.dispatchEvent(new CustomEvent("caelo-auth:login", { bubbles: true }));
            await renderAccount();
          } else {
            setStatus(status, "err", r.error?.message ?? "Login failed.");
          }
        });
      }

      function renderSignup(): void {
        root.innerHTML = `
          <style>${css}</style>
          <form novalidate>
            <h3>Sign up</h3>
            <input name="email" type="email" placeholder="you@example.com" required autocomplete="email" />
            <input name="password" type="password" placeholder="Password (8+ chars)" required minlength="8" autocomplete="new-password" />
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
          const captcha = await attachCaptchaProof().catch(() => null);
          const r = await postPluginJson("auth", "signup", {
            email: fd.get("email"),
            password: fd.get("password"),
            ...(captcha ? { _caelo_captcha: captcha } : {}),
          });
          if (r.ok) {
            host.dispatchEvent(new CustomEvent("caelo-auth:signup", { bubbles: true }));
            await renderAccount();
          } else {
            setStatus(status, "err", r.error?.message ?? "Signup failed.");
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
