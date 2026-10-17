// SPDX-License-Identifier: MPL-2.0

/**
 * #847 — the auth plugin honours its own config and fails loudly when it
 * can't: `signup` refuses while registration is closed, both password
 * surfaces enforce the configured minimum, a missing or out-of-range
 * config row is a structured error (never a silent default of 8), a
 * password reset revokes EVERY session (not just the first 1000), and
 * config writes are bounded 8..128 at the propose boundary.
 *
 * Runs the plugin's operations against an in-memory store with the same
 * filter semantics as the host (AND-combined equality, `limit` cap) —
 * the real store is exercised by the integration suite.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";

type Row = Record<string, unknown> & { id: string };

const RESERVED = new Set(["limit", "orderBy", "orderDir", "since"]);

function world(seed: Partial<Record<string, Row[]>> = {}) {
  let nextId = 0;
  const tables: Record<string, Row[]> = {
    public_users: [],
    visitor_sessions: [],
    password_reset_tokens: [],
    auth_config: [],
    auth_config_proposals: [],
    ...seed,
  };
  const t = (name: string): Row[] => {
    const rows = tables[name];
    if (!rows) throw new Error(`undeclared table ${name}`);
    return rows;
  };
  const state = { captchaCalls: 0, sessionCleared: false };
  const ctx = {
    invocation: { origin: "visitor", actorId: "00000000-0000-0000-0000-00000000ffff" },
    captcha: {
      requireProof: async () => {
        state.captchaCalls += 1;
        return true;
      },
    },
    visitor: {
      setSession: (s: unknown) => {
        if (s === null) state.sessionCleared = true;
      },
    },
    query: {
      insert: async (table: string, data: Record<string, unknown>) => {
        nextId += 1;
        const id = `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
        t(table).push({ id, updated_at: null, created_at: new Date().toISOString(), ...data });
        return { id };
      },
      list: async (table: string, filter: Record<string, unknown> = {}) => {
        // The host caps every page at 1000 rows.
        const limit = Math.min(Number(filter.limit ?? 100), 1000);
        return t(table)
          .filter((r) => Object.entries(filter).every(([k, v]) => RESERVED.has(k) || r[k] === v))
          .slice(0, limit);
      },
      update: async (table: string, id: string, patch: Record<string, unknown>) => {
        const row = t(table).find((r) => r.id === id);
        if (row) Object.assign(row, patch);
      },
      delete: async (table: string, id: string) => {
        tables[table] = t(table).filter((r) => r.id !== id);
      },
    },
  } as unknown as PluginContextTier1;
  return { ctx, tables, state };
}

async function run(ctx: PluginContextTier1, op: string, args: unknown): Promise<unknown> {
  const fn = plugin.operations[op];
  if (!fn) throw new Error(`operation ${op} missing`);
  return fn(ctx, args);
}

async function activate(ctx: PluginContextTier1): Promise<void> {
  if (!plugin.onActivate) throw new Error("auth must seed its config in onActivate");
  await plugin.onActivate(ctx);
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("auth config seeding", () => {
  it("onActivate seeds the documented defaults once and is idempotent", async () => {
    const w = world();
    await activate(w.ctx);
    await activate(w.ctx);
    expect(w.tables.auth_config).toHaveLength(1);
    expect(w.tables.auth_config?.[0]).toMatchObject({ signup_open: true, password_min_length: 8 });
  });

  it("a missing config row is a loud error, not a default of 8", async () => {
    const w = world();
    await expect(
      run(w.ctx, "signup", { email: "a@example.com", password: "longenough" }),
    ).rejects.toThrow(/auth_config row missing.*onActivate/);
    await expect(run(w.ctx, "get_auth_config", {})).rejects.toThrow(/auth_config row missing/);
    expect(w.tables.public_users).toHaveLength(0);
  });

  it("a stored minimum below 8 fails loudly instead of being clamped", async () => {
    const w = world({
      auth_config: [{ id: "c1", signup_open: true, password_min_length: 4, updated_at: null }],
    });
    await expect(
      run(w.ctx, "signup", { email: "a@example.com", password: "longenough" }),
    ).rejects.toThrow(/stored auth_config is invalid/);
    expect(w.tables.public_users).toHaveLength(0);
  });

  it("a stored minimum above 128 fails loudly too", async () => {
    const w = world({
      auth_config: [{ id: "c1", signup_open: true, password_min_length: 500, updated_at: null }],
    });
    await expect(run(w.ctx, "get_auth_config", {})).rejects.toThrow(
      /stored auth_config is invalid/,
    );
  });
});

describe("signup honours auth_config", () => {
  it("refuses while signup_open is false", async () => {
    const w = world({
      auth_config: [{ id: "c1", signup_open: false, password_min_length: 8, updated_at: null }],
    });
    await expect(
      run(w.ctx, "signup", { email: "a@example.com", password: "longenough" }),
    ).rejects.toThrow(/registration is closed/);
    expect(w.tables.public_users).toHaveLength(0);
    expect(w.tables.visitor_sessions).toHaveLength(0);
  });

  it("enforces the configured minimum length, not the floor of 8", async () => {
    const w = world({
      auth_config: [{ id: "c1", signup_open: true, password_min_length: 12, updated_at: null }],
    });
    await expect(
      run(w.ctx, "signup", { email: "a@example.com", password: "elevenchars" }),
    ).rejects.toThrow(/password >= 12 chars/);
    expect(w.tables.public_users).toHaveLength(0);
    const ok = await run(w.ctx, "signup", { email: "a@example.com", password: "twelve-chars" });
    expect(ok).toMatchObject({ publicUserId: expect.any(String) });
  });
});

describe("reset_password", () => {
  async function withResetToken(minLength: number, sessionCount: number) {
    const w = world({
      auth_config: [
        { id: "c1", signup_open: true, password_min_length: minLength, updated_at: null },
      ],
      public_users: [{ id: "u1", email: "a@example.com", password_hash: "old" }],
    });
    const token = "reset-token";
    w.tables.password_reset_tokens?.push({
      id: "t1",
      public_user_id: "u1",
      token_hash: await sha256Hex(token),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
    });
    for (let i = 0; i < sessionCount; i += 1) {
      w.tables.visitor_sessions?.push({ id: `s${i}`, public_user_id: "u1", token_hash: `h${i}` });
    }
    // Another visitor's session must survive.
    w.tables.visitor_sessions?.push({ id: "other", public_user_id: "u2", token_hash: "x" });
    return { w, token };
  }

  it("enforces the configured minimum length", async () => {
    const { w, token } = await withResetToken(16, 1);
    await expect(
      run(w.ctx, "reset_password", { token, newPassword: "fifteen-chars!!" }),
    ).rejects.toThrow(/password >= 16 chars/);
    expect(w.tables.public_users?.[0]?.password_hash).toBe("old");
  });

  it("revokes every session of the user, including past the 1000-row list cap", async () => {
    const { w, token } = await withResetToken(8, 2500);
    await run(w.ctx, "reset_password", { token, newPassword: "brand-new-password" });
    const remaining = w.tables.visitor_sessions ?? [];
    expect(remaining.filter((s) => s.public_user_id === "u1")).toHaveLength(0);
    expect(remaining.map((s) => s.id)).toEqual(["other"]);
    expect(w.state.sessionCleared).toBe(true);
  });
});

describe("config writes are bounded 8..128 at the boundary", () => {
  for (const op of ["propose_auth_config", "apply_auth_config"]) {
    it(`${op} rejects out-of-range or non-integer minimums before writing`, async () => {
      const w = world({
        auth_config: [{ id: "c1", signup_open: true, password_min_length: 8, updated_at: null }],
      });
      for (const passwordMinLength of [7, 129, 1000, 10.5, Number.NaN]) {
        await expect(run(w.ctx, op, { signupOpen: true, passwordMinLength })).rejects.toThrow(
          /passwordMinLength must be an integer 8\.\.128/,
        );
      }
      await expect(run(w.ctx, op, { signupOpen: "yes", passwordMinLength: 10 })).rejects.toThrow(
        /invalid input/,
      );
      expect(w.tables.auth_config_proposals).toHaveLength(0);
      expect(w.tables.auth_config?.[0]?.password_min_length).toBe(8);
    });
  }

  it("propose_auth_config queues an in-range proposal", async () => {
    const w = world();
    const r = await run(w.ctx, "propose_auth_config", {
      signupOpen: false,
      passwordMinLength: 128,
    });
    expect(r).toMatchObject({ status: "pending" });
    expect(w.tables.auth_config_proposals?.[0]).toMatchObject({
      proposed_signup_open: false,
      proposed_password_min_length: 128,
    });
  });

  it("execute_proposal refuses a queued out-of-range proposal", async () => {
    const w = world({
      auth_config: [{ id: "c1", signup_open: true, password_min_length: 8, updated_at: null }],
      auth_config_proposals: [
        {
          id: "p1",
          proposed_signup_open: true,
          proposed_password_min_length: 200,
          status: "pending",
        },
      ],
    });
    await expect(run(w.ctx, "execute_proposal", { proposalId: "p1" })).rejects.toThrow(
      /execute_proposal: invalid input/,
    );
    expect(w.tables.auth_config?.[0]?.password_min_length).toBe(8);
    expect(w.tables.auth_config_proposals?.[0]?.status).toBe("pending");
  });

  it("the AI tool schema carries the same integer bounds", () => {
    const tool = plugin.tools?.find((t) => t.name === "propose_auth_config");
    if (!tool) throw new Error("propose_auth_config tool missing");
    const props = (tool.inputJsonSchema as { properties: Record<string, unknown> }).properties;
    expect(props.passwordMinLength).toEqual({ type: "integer", minimum: 8, maximum: 128 });
  });
});
