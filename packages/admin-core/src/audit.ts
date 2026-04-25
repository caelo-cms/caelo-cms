// SPDX-License-Identifier: MPL-2.0

import type { TransactionRunner } from "@caelo/query-api";
import { sql } from "drizzle-orm";

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
 * Record one audit row. The `entityId` + `resultSummary` columns distinguish
 * two events whose input_hash collides — e.g. a failed `users.delete` and a
 * successful one with the same target id, or a regenerated session that uses
 * the same email but yields a different token.
 */
export async function recordAudit(
  tx: TransactionRunner,
  opts: {
    actorId: string;
    operation: string;
    input: unknown;
    succeeded: boolean;
    /** The subject of the operation (target user id, role id, etc.). */
    entityId?: string | null;
    /** Short, redaction-aware fingerprint of the result. Never put secrets here. */
    resultSummary?: string | null;
  },
): Promise<void> {
  const hash = await canonicalHash(opts.input);
  const entityId = opts.entityId ?? null;
  const resultSummary = opts.resultSummary ?? null;
  await tx.execute(sql`
    INSERT INTO audit_events (actor_id, operation, input_hash, succeeded, entity_id, result_summary)
    VALUES (
      ${opts.actorId}::uuid,
      ${opts.operation},
      ${hash},
      ${opts.succeeded},
      ${entityId === null ? null : sql`${entityId}::uuid`},
      ${resultSummary}
    )
  `);
}

export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
