// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — test fixtures for redirects as draft state: the LIVE rows
 * (`redirects`) and the pending changes (`pending_redirects`), read and
 * seeded on the raw pool (no op tag), as a system session.
 */

import { redirectAddress } from "@caelo-cms/shared";
import { SQL } from "bun";

async function asSystem<T>(adminUrl: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(adminUrl);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

/** A live rule, as the hosting serves it. */
export interface LiveRule {
  readonly fromPath: string;
  readonly toPath: string;
  readonly statusCode: number;
}

/** Seed live rules directly: the state a release left (the update keeps existing rows live). */
export async function seedLiveRedirects(
  adminUrl: string,
  actorId: string,
  rules: readonly LiveRule[],
): Promise<void> {
  await asSystem(adminUrl, async (tx) => {
    for (const r of rules) {
      await tx`
        INSERT INTO redirects (from_path, to_path, status_code, created_by)
        VALUES (${r.fromPath}, ${r.toPath}, ${r.statusCode}, ${actorId}::uuid)`;
    }
  });
}

/** The live rules whose from path starts with `prefix`, ordered. */
export async function liveRedirects(adminUrl: string, prefix: string): Promise<LiveRule[]> {
  return asSystem(adminUrl, async (tx) => {
    const rows = (await tx`
      SELECT from_path, to_path, status_code FROM redirects
      WHERE from_path LIKE ${`${prefix}%`} ORDER BY from_path`) as {
      from_path: string;
      to_path: string;
      status_code: number;
    }[];
    return rows.map((r) => ({ fromPath: r.from_path, toPath: r.to_path, statusCode: r.status_code }));
  });
}

/** A pending change as stored. */
export interface StoredChange {
  readonly fromPath: string;
  readonly toPath: string | null;
  readonly statusCode: number | null;
  readonly state: "draft" | "staged";
  readonly origin: string;
  readonly chatSessionId: string | null;
}

/** The pending changes whose from path starts with `prefix`, ordered. */
export async function pendingRedirects(adminUrl: string, prefix: string): Promise<StoredChange[]> {
  return asSystem(adminUrl, async (tx) => {
    const rows = (await tx`
      SELECT from_path, to_path, status_code, state, origin, chat_session_id::text AS chat
      FROM pending_redirects WHERE from_path LIKE ${`${prefix}%`} ORDER BY address`) as {
      from_path: string;
      to_path: string | null;
      status_code: number | null;
      state: "draft" | "staged";
      origin: string;
      chat: string | null;
    }[];
    return rows.map((r) => ({
      fromPath: r.from_path,
      toPath: r.to_path,
      statusCode: r.status_code,
      state: r.state,
      origin: r.origin,
      chatSessionId: r.chat,
    }));
  });
}

/** Delete every live rule and pending change under `prefix` (test cleanup). */
export async function wipeRedirects(adminUrl: string, prefix: string): Promise<void> {
  await asSystem(adminUrl, async (tx) => {
    await tx`DELETE FROM pending_redirects WHERE from_path LIKE ${`${prefix}%`}`;
    await tx`DELETE FROM redirect_release_log WHERE address LIKE ${`${prefix}%`}`;
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`${prefix}%`}`;
  });
}

/**
 * The rules under `prefix` as they stand once every pending change (Draft
 * and Staged, any branch) is live: the view `redirects.list` and the
 * Settings page show. A save is observed here, the live site in
 * {@link liveRedirects}.
 */
export async function ruleView(adminUrl: string, prefix: string): Promise<LiveRule[]> {
  const live = await liveRedirects(adminUrl, prefix);
  const pending = await pendingRedirects(adminUrl, prefix);
  const changed = new Set(pending.map((c) => redirectAddress(c.fromPath)));
  const rules = live.filter((r) => !changed.has(redirectAddress(r.fromPath)));
  for (const c of pending) {
    if (c.toPath !== null && c.statusCode !== null) {
      rules.push({ fromPath: c.fromPath, toPath: c.toPath, statusCode: c.statusCode });
    }
  }
  return rules.sort((a, b) => (a.fromPath < b.fromPath ? -1 : a.fromPath > b.fromPath ? 1 : 0));
}
