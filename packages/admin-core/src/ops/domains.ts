// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — domains registry ops.
 *
 *  domains.list                   read-only — open to all actor kinds
 *  domains.add                    Owner-only — creates a row, kind in
 *                                 admin / public / locale-public; the
 *                                 cms-provision regenerate-caddy step
 *                                 reads the table at deploy.
 *  domains.remove                 Owner-only — soft-removes by deleting
 *                                 the row; cms-provision drops the vhost
 *                                 on next reload.
 *  domains.verify                 Owner-only — runs DNS lookups via Bun's
 *                                 native dns module; updates last_verified_at
 *                                 + tls_status when ACME hasn't yet seen
 *                                 the host.
 *  domains.set_tls_status         system-only — Caddy hook (P14 review pass
 *                                 will wire it via webhook); for now the
 *                                 op exists so the schema is complete.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";

const domainKind = z.enum(["admin", "public", "locale-public"]);
const tlsStatus = z.enum(["pending", "active", "failed", "unknown"]);

const domainRow = z.object({
  id: z.string(),
  hostname: z.string(),
  kind: domainKind,
  localeCode: z.string().nullable(),
  tlsStatus,
  tlsExpiresAt: z.string().nullable(),
  tlsError: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  createdAt: z.string(),
});

interface DomainRow {
  id: string;
  hostname: string;
  kind: "admin" | "public" | "locale-public";
  locale_code: string | null;
  tls_status: "pending" | "active" | "failed" | "unknown";
  tls_expires_at: string | Date | null;
  tls_error: string | null;
  last_verified_at: string | Date | null;
  created_at: string | Date;
}

function toApi(r: DomainRow): z.infer<typeof domainRow> {
  return {
    id: r.id,
    hostname: r.hostname,
    kind: r.kind,
    localeCode: r.locale_code,
    tlsStatus: r.tls_status,
    tlsExpiresAt: r.tls_expires_at
      ? r.tls_expires_at instanceof Date
        ? r.tls_expires_at.toISOString()
        : String(r.tls_expires_at)
      : null,
    tlsError: r.tls_error,
    lastVerifiedAt: r.last_verified_at
      ? r.last_verified_at instanceof Date
        ? r.last_verified_at.toISOString()
        : String(r.last_verified_at)
      : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export const listDomainsOp = defineOperation({
  name: "domains.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ domains: z.array(domainRow) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, hostname, kind, locale_code, tls_status,
             tls_expires_at, tls_error, last_verified_at, created_at
      FROM domains
      ORDER BY created_at DESC
    `)) as unknown as DomainRow[];
    return ok({ domains: rows.map(toApi) });
  },
});

export const addDomainOp = defineOperation({
  name: "domains.add",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      hostname: z
        .string()
        .min(1)
        .max(253)
        .transform((s) => s.toLowerCase().trim())
        .refine((s) => HOSTNAME_RE.test(s), "must be a valid hostname"),
      kind: domainKind,
      localeCode: z.string().min(2).max(20).optional(),
    })
    .strict(),
  output: z.object({ domainId: z.string() }),
  handler: async (ctx, input, tx) => {
    if (input.kind === "locale-public" && !input.localeCode) {
      return err({
        kind: "HandlerError",
        operation: "domains.add",
        message: "locale-public domains require localeCode",
      });
    }
    const rows = (await tx.execute(sql`
      INSERT INTO domains (hostname, kind, locale_code, created_by)
      VALUES (${input.hostname}, ${input.kind}, ${input.localeCode ?? null}, ${ctx.actorId}::uuid)
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "domains.add",
        message: "no row returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "domains.add",
      input,
      succeeded: true,
      resultSummary: `${input.kind} ${input.hostname}`,
    });
    return ok({ domainId: id });
  },
});

export const removeDomainOp = defineOperation({
  name: "domains.remove",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ domainId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`DELETE FROM domains WHERE id = ${input.domainId}::uuid`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "domains.remove",
      input,
      succeeded: true,
      resultSummary: `removed ${input.domainId}`,
    });
    return ok({});
  },
});

/**
 * P14 — Owner clicks "Verify DNS now". Resolves A + AAAA records via
 * Bun's native dns module; if either resolves the domain is reachable.
 * TLS status flips to 'active' only after Caddy + ACME confirm — this
 * op only updates `last_verified_at` and a synthesised `tls_status`
 * when ACME hasn't yet probed the host.
 */
export const verifyDomainOp = defineOperation({
  name: "domains.verify",
  // v0.2.30 — widened to AI: the op is diagnostic (DNS lookup +
  // last_verified_at refresh), no destructive side effect; the AI
  // calls it after the Owner approves a propose_add to surface an
  // immediate TLS status indicator without a second Owner round-trip.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ domainId: z.string().uuid() }).strict(),
  output: z.object({
    hostname: z.string(),
    a: z.array(z.string()),
    aaaa: z.array(z.string()),
    resolved: z.boolean(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT hostname FROM domains WHERE id = ${input.domainId}::uuid LIMIT 1
    `)) as unknown as { hostname: string }[];
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "domains.verify",
        message: "domain not found",
      });
    }
    const dns = await import("node:dns/promises");
    let a: string[] = [];
    let aaaa: string[] = [];
    try {
      a = await dns.resolve4(r.hostname);
    } catch {
      // not resolved
    }
    try {
      aaaa = await dns.resolve6(r.hostname);
    } catch {
      // not resolved
    }
    const resolved = a.length > 0 || aaaa.length > 0;
    await tx.execute(sql`
      UPDATE domains
         SET last_verified_at = now(),
             tls_status = CASE WHEN tls_status IN ('active','failed') THEN tls_status
                               WHEN ${resolved} THEN 'pending' ELSE 'unknown' END
       WHERE id = ${input.domainId}::uuid
    `);
    return ok({ hostname: r.hostname, a, aaaa, resolved });
  },
});

export const setDomainTlsStatusOp = defineOperation({
  name: "domains.set_tls_status",
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      hostname: z.string().min(1).max(253),
      tlsStatus,
      tlsExpiresAt: z.string().optional(),
      tlsError: z.string().max(2000).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE domains
         SET tls_status = ${input.tlsStatus},
             tls_expires_at = ${input.tlsExpiresAt ?? null},
             tls_error = ${input.tlsError ?? null},
             last_verified_at = now()
       WHERE hostname = ${input.hostname}
    `);
    return ok({});
  },
});
