// SPDX-License-Identifier: MPL-2.0

/**
 * The auth plugin's operations against an in-memory store with the host's
 * filter semantics (AND-combined equality, `anyOf`, the 1000-row `limit`
 * cap, an atomic `compareAndSwap`) and a recording `ctx.email`. Test-only:
 * the real store is exercised by the integration suites.
 */

import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";

export type Row = Record<string, unknown> & { id: string };

const RESERVED = new Set(["limit", "orderBy", "orderDir", "since", "anyOf"]);

/** The unique indexes of the auth manifest (`indexes.schema`). */
const UNIQUE: ReadonlyArray<[string, string]> = [
  ["login_throttle", "email_hash"],
  ["public_users", "email_key"],
];

/** A mail the plugin queued. */
export interface QueuedMail {
  readonly template: string;
  readonly to: string;
  readonly token?: string;
}

export function world(seed: Partial<Record<string, Row[]>> = {}) {
  let nextId = 0;
  const tables: Record<string, Row[]> = {
    public_users: [],
    visitor_sessions: [],
    password_reset_tokens: [],
    email_verification_tokens: [],
    login_throttle: [],
    auth_config: [],
    auth_config_proposals: [],
    ...seed,
  };
  const t = (name: string): Row[] => {
    const rows = tables[name];
    if (!rows) throw new Error(`undeclared table ${name}`);
    return rows;
  };
  const state = {
    captchaCalls: 0,
    sessionCleared: false,
    sessionSet: 0,
    mails: [] as QueuedMail[],
  };
  const matches = (r: Row, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([k, v]) => RESERVED.has(k) || r[k] === v) &&
    Object.entries((filter.anyOf ?? {}) as Record<string, unknown[]>).every(([k, vs]) =>
      vs.includes(r[k]),
    );
  const ctx = {
    invocation: { origin: "visitor", actorId: "00000000-0000-0000-0000-00000000ffff" },
    captcha: {
      requireProof: async () => {
        state.captchaCalls += 1;
        return true;
      },
    },
    visitor: {
      sessionToken: null as string | null,
      setSession: (s: unknown) => {
        if (s === null) state.sessionCleared = true;
        else state.sessionSet += 1;
      },
    },
    email: {
      send: async () => {
        throw new Error("a visitor call queues, never sends");
      },
      unsubscribeLink: async () => {
        throw new Error("auth mail carries no unsubscribe link");
      },
      queue: async (m: QueuedMail) => {
        state.mails.push(m);
      },
    },
    query: {
      insert: async (table: string, data: Record<string, unknown>) => {
        // A database round trip: concurrent callers interleave here.
        await Promise.resolve();
        // The unique indexes the manifest declares.
        for (const [t2, col] of UNIQUE) {
          if (table === t2 && data[col] != null && t(table).some((r) => r[col] === data[col])) {
            throw new Error(`duplicate key value violates unique constraint (${table}.${col})`);
          }
        }
        nextId += 1;
        const id = `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
        t(table).push({ id, updated_at: null, created_at: new Date().toISOString(), ...data });
        return { id };
      },
      list: async (table: string, filter: Record<string, unknown> = {}) => {
        await Promise.resolve();
        const limit = Math.min(Number(filter.limit ?? 100), 1000);
        let rows = t(table).filter((r) => matches(r, filter));
        if (typeof filter.orderBy === "string") {
          const col = filter.orderBy;
          rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
        }
        return rows.slice(0, limit);
      },
      update: async (table: string, id: string, patch: Record<string, unknown>) => {
        const row = t(table).find((r) => r.id === id);
        if (row) Object.assign(row, patch);
      },
      delete: async (table: string, id: string) => {
        tables[table] = t(table).filter((r) => r.id !== id);
      },
      compareAndSwap: async (
        table: string,
        id: string,
        expected: Record<string, unknown>,
        patch: Record<string, unknown>,
      ) => {
        // A real database round trip: let concurrent callers interleave.
        await Promise.resolve();
        const row = t(table).find((r) => r.id === id);
        if (!row) return false;
        if (!Object.entries(expected).every(([k, v]) => (row[k] ?? null) === v)) return false;
        Object.assign(row, patch);
        return true;
      },
    },
  } as unknown as PluginContextTier1 & { visitor: { sessionToken: string | null } };
  return { ctx, tables, state };
}

export async function run(ctx: PluginContextTier1, op: string, args: unknown): Promise<unknown> {
  const fn = plugin.operations[op];
  if (!fn) throw new Error(`operation ${op} missing`);
  return fn(ctx, args);
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The default config row (signup open, 8-char minimum). */
export const OPEN_CONFIG: Row = {
  id: "c1",
  signup_open: true,
  password_min_length: 8,
  updated_at: null,
};
