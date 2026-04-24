// SPDX-License-Identifier: MPL-2.0

import type { TransactionRunner } from "@caelo/query-api";
import { sql } from "drizzle-orm";

/** Fields that must never appear in the audit input_hash pre-image. */
const SENSITIVE_KEYS = new Set(["password", "token", "csrfToken", "passwordHash"]);

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? "<redacted>" : redact(v);
    }
    return out;
  }
  return value;
}

/** Stable canonical JSON (sorted keys) + sha256, used for the audit row's input_hash column. */
async function canonicalHash(input: unknown): Promise<string> {
  const canonical = JSON.stringify(redact(input), (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) sorted[k] = (val as Record<string, unknown>)[k];
      return sorted;
    }
    return val;
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Record one audit row for the current Query API op. Called from every handler
 * before returning; the row lives in the same transaction as the write, so a
 * handler that throws rolls back both its data *and* its audit entry — good,
 * because an audit log listing actions that didn't happen is worse than none.
 */
export async function recordAudit(
  tx: TransactionRunner,
  opts: {
    actorId: string;
    operation: string;
    input: unknown;
    succeeded: boolean;
  },
): Promise<void> {
  const hash = await canonicalHash(opts.input);
  await tx.execute(sql`
    INSERT INTO audit_events (actor_id, operation, input_hash, succeeded)
    VALUES (${opts.actorId}::uuid, ${opts.operation}, ${hash}, ${opts.succeeded})
  `);
}

export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
