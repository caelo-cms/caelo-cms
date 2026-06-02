// SPDX-License-Identifier: MPL-2.0

/**
 * P9 — locale registry + URL strategies + the §11.A propose/execute split.
 *
 * Why the split: adding/removing a locale, flipping the default, or
 * changing a URL strategy fans out across every page (URL changes,
 * hreflang rewrites, redirect rows). Per CLAUDE.md §11.A, the AI can
 * draft + queue the change, but a human Owner clicks Approve to apply.
 *
 *   locales.list                — read (open).
 *   locales.get                 — read (open).
 *   locales.propose_create      — AI/Owner queue an "add locale" intent.
 *   locales.propose_delete      — queue a "remove locale" intent.
 *   locales.propose_set_default — queue a "swap default locale" intent.
 *   locales.propose_update_strategy — queue a "change URL strategy" intent.
 *   locales.list_pending        — Owner queue + AI's own pending check.
 *   locales.execute_proposal    — human+system; the Approve button.
 *   locales.reject_proposal     — human+system; the Reject button.
 *
 * The Validator rejects AI calls to execute/reject_proposal with
 * ActorScopeRejected → the AI surfaces "click Approve at /security/locales/pending".
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation } from "@caelo-cms/query-api";
import {
  err,
  type LocaleConfig,
  ok,
  PROPOSAL_STATUSES,
  type ProposalStatus,
  proposalStatus,
  resolveLocaleUrl,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";

// BCP-47-ish: lowercase letter pair, optional region. Loose; the
// browser still accepts it as a valid lang tag.
const localeCodeSchema = z
  .string()
  .min(2)
  .max(10)
  .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, "BCP-47 like 'en' or 'de-AT'");

const urlStrategySchema = z.enum(["none", "subdirectory", "subdomain", "domain"]);

const localeRowSchema = z.object({
  code: z.string(),
  displayName: z.string(),
  urlStrategy: urlStrategySchema,
  urlHost: z.string().nullable(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

interface LocaleDbRow {
  code: string;
  display_name: string;
  url_strategy: "none" | "subdirectory" | "subdomain" | "domain";
  url_host: string | null;
  is_default: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToOut(r: LocaleDbRow): z.infer<typeof localeRowSchema> {
  return {
    code: r.code,
    displayName: r.display_name,
    urlStrategy: r.url_strategy,
    urlHost: r.url_host,
    isDefault: r.is_default,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export const listLocalesOp = defineOperation({
  name: "locales.list",
  // CLAUDE.md §11: read surface open so the AI can plan multi-locale
  // edits without a human round-trip.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ locales: z.array(localeRowSchema) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT code, display_name, url_strategy, url_host, is_default,
             created_at, updated_at
      FROM locales
      ORDER BY is_default DESC, code ASC
    `)) as unknown as LocaleDbRow[];
    return ok({ locales: rows.map(rowToOut) });
  },
});

export const getLocaleOp = defineOperation({
  name: "locales.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ code: localeCodeSchema }).strict(),
  output: z.object({ locale: localeRowSchema.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT code, display_name, url_strategy, url_host, is_default,
             created_at, updated_at
      FROM locales WHERE code = ${input.code} LIMIT 1
    `)) as unknown as LocaleDbRow[];
    const r = rows[0];
    return ok({ locale: r ? rowToOut(r) : null });
  },
});

// ---------------------------------------------------------------------
// Pending-action proposals (§11.A propose/execute split).
// ---------------------------------------------------------------------

const actionKindSchema = z.enum(["create", "delete", "set_default", "update_strategy"]);

const proposalRowSchema = z.object({
  id: z.string(),
  actionKind: actionKindSchema,
  payload: z.unknown(),
  preview: z.unknown(),
  proposedBy: z.string(),
  proposedAt: z.string(),
  status: proposalStatus,
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
});

interface ProposalDbRow {
  id: string;
  action_kind: "create" | "delete" | "set_default" | "update_strategy";
  payload: unknown;
  preview: unknown;
  proposed_by: string;
  proposed_at: string | Date;
  status: ProposalStatus;
  decided_by: string | null;
  decided_at: string | Date | null;
  decision_note: string | null;
}

function proposalToOut(r: ProposalDbRow): z.infer<typeof proposalRowSchema> {
  return {
    id: r.id,
    actionKind: r.action_kind,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    preview: typeof r.preview === "string" ? JSON.parse(r.preview) : r.preview,
    proposedBy: r.proposed_by,
    proposedAt: r.proposed_at instanceof Date ? r.proposed_at.toISOString() : String(r.proposed_at),
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt:
      r.decided_at === null
        ? null
        : r.decided_at instanceof Date
          ? r.decided_at.toISOString()
          : String(r.decided_at),
    decisionNote: r.decision_note,
  };
}

/**
 * Compute the blast-radius preview shown next to the Approve button.
 * Reads on the same tx so the count reflects the moment the proposal
 * was queued.
 */
async function computePreview(
  tx: TransactionRunner,
  actionKind: "create" | "delete" | "set_default" | "update_strategy",
  payload: { code?: string; urlStrategy?: string; urlHost?: string | null; displayName?: string },
): Promise<{
  affectedPageCount: number;
  redirectsToCreate: number;
  warnings: string[];
}> {
  const warnings: string[] = [];
  let affectedPageCount = 0;
  let redirectsToCreate = 0;

  if (actionKind === "create") {
    if (payload.urlStrategy === "subdomain" || payload.urlStrategy === "domain") {
      if (!payload.urlHost || payload.urlHost.trim().length === 0) {
        warnings.push(`url_host required for url_strategy='${payload.urlStrategy}'`);
      }
      warnings.push(
        `url_strategy='${payload.urlStrategy}' requires SSL + DNS + CDN configuration before publish`,
      );
    }
  }

  if (actionKind === "delete" && payload.code) {
    const rows = (await tx.execute(sql`
      SELECT count(*)::int AS c FROM pages WHERE locale = ${payload.code} AND deleted_at IS NULL
    `)) as unknown as { c: number }[];
    affectedPageCount = rows[0]?.c ?? 0;
    redirectsToCreate = affectedPageCount;
    if (affectedPageCount > 0) {
      warnings.push(
        `${affectedPageCount} pages exist in '${payload.code}' — deleting will require ${affectedPageCount} redirects to avoid broken links`,
      );
    }
  }

  if (actionKind === "set_default" && payload.code) {
    const rows = (await tx.execute(sql`
      SELECT count(*)::int AS c FROM pages WHERE locale != ${payload.code} AND deleted_at IS NULL
    `)) as unknown as { c: number }[];
    affectedPageCount = rows[0]?.c ?? 0;
    if (affectedPageCount > 0) {
      warnings.push(
        `swapping default to '${payload.code}' changes URL paths for ${affectedPageCount} non-${payload.code} pages`,
      );
    }
  }

  if (actionKind === "update_strategy" && payload.code) {
    const rows = (await tx.execute(sql`
      SELECT count(*)::int AS c FROM pages WHERE locale = ${payload.code} AND deleted_at IS NULL
    `)) as unknown as { c: number }[];
    affectedPageCount = rows[0]?.c ?? 0;
    redirectsToCreate = affectedPageCount;
    if (payload.urlStrategy === "subdomain" || payload.urlStrategy === "domain") {
      if (!payload.urlHost || payload.urlHost.trim().length === 0) {
        warnings.push(`url_host required for url_strategy='${payload.urlStrategy}'`);
      }
      warnings.push(
        `url_strategy='${payload.urlStrategy}' requires SSL + DNS + CDN configuration before publish`,
      );
    }
  }

  return { affectedPageCount, redirectsToCreate, warnings };
}

const proposeCreateInput = z
  .object({
    code: localeCodeSchema,
    displayName: z.string().min(1).max(120),
    urlStrategy: urlStrategySchema.default("subdirectory"),
    urlHost: z.string().min(1).max(253).nullable().optional(),
  })
  .strict();

export const proposeCreateLocaleOp = defineOperation({
  name: "locales.propose_create",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeCreateInput,
  output: z.object({ proposalId: z.string(), preview: z.unknown() }),
  handler: async (ctx, input, tx) => {
    const dup = (await tx.execute(sql`
      SELECT 1 AS exists FROM locales WHERE code = ${input.code} LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "locales.propose_create",
        input,
        succeeded: false,
        resultSummary: "locale-already-exists",
      });
      return err({
        kind: "HandlerError",
        operation: "locales.propose_create",
        message: `locale '${input.code}' already exists`,
      });
    }
    const preview = await computePreview(tx, "create", input);
    const rows = (await tx.execute(sql`
      INSERT INTO locale_pending_actions (action_kind, payload, preview, proposed_by)
      VALUES ('create', ${JSON.stringify(input)}::jsonb, ${JSON.stringify(preview)}::jsonb, ${ctx.actorId}::uuid)
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const proposalId = rows[0]?.id;
    if (!proposalId) {
      return err({
        kind: "HandlerError",
        operation: "locales.propose_create",
        message: "no id returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "locales.propose_create",
      input,
      succeeded: true,
      entityId: proposalId,
      resultSummary: `code=${input.code} strategy=${input.urlStrategy}`,
    });
    return ok({ proposalId, preview });
  },
});

const proposeDeleteInput = z.object({ code: localeCodeSchema }).strict();

export const proposeDeleteLocaleOp = defineOperation({
  name: "locales.propose_delete",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeDeleteInput,
  output: z.object({ proposalId: z.string(), preview: z.unknown() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT is_default FROM locales WHERE code = ${input.code} LIMIT 1
    `)) as unknown as { is_default: boolean }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "locales.propose_delete",
        message: `locale '${input.code}' not found`,
      });
    }
    if (target.is_default) {
      return err({
        kind: "HandlerError",
        operation: "locales.propose_delete",
        message: "cannot delete the default locale — set a different default first",
      });
    }
    const preview = await computePreview(tx, "delete", input);
    const insertRows = (await tx.execute(sql`
      INSERT INTO locale_pending_actions (action_kind, payload, preview, proposed_by)
      VALUES ('delete', ${JSON.stringify(input)}::jsonb, ${JSON.stringify(preview)}::jsonb, ${ctx.actorId}::uuid)
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const proposalId = insertRows[0]?.id;
    if (!proposalId) {
      return err({
        kind: "HandlerError",
        operation: "locales.propose_delete",
        message: "no id returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "locales.propose_delete",
      input,
      succeeded: true,
      entityId: proposalId,
      resultSummary: `code=${input.code}`,
    });
    return ok({ proposalId, preview });
  },
});

const proposeSetDefaultInput = z.object({ code: localeCodeSchema }).strict();

export const proposeSetDefaultLocaleOp = defineOperation({
  name: "locales.propose_set_default",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeSetDefaultInput,
  output: z.object({ proposalId: z.string(), preview: z.unknown() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT is_default FROM locales WHERE code = ${input.code} LIMIT 1
    `)) as unknown as { is_default: boolean }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "locales.propose_set_default",
        message: `locale '${input.code}' not found`,
      });
    }
    if (target.is_default) {
      return err({
        kind: "HandlerError",
        operation: "locales.propose_set_default",
        message: `'${input.code}' is already the default locale`,
      });
    }
    const preview = await computePreview(tx, "set_default", input);
    const insertRows = (await tx.execute(sql`
      INSERT INTO locale_pending_actions (action_kind, payload, preview, proposed_by)
      VALUES ('set_default', ${JSON.stringify(input)}::jsonb, ${JSON.stringify(preview)}::jsonb, ${ctx.actorId}::uuid)
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const proposalId = insertRows[0]?.id;
    if (!proposalId) {
      return err({
        kind: "HandlerError",
        operation: "locales.propose_set_default",
        message: "no id returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "locales.propose_set_default",
      input,
      succeeded: true,
      entityId: proposalId,
      resultSummary: `code=${input.code}`,
    });
    return ok({ proposalId, preview });
  },
});

const proposeUpdateStrategyInput = z
  .object({
    code: localeCodeSchema,
    urlStrategy: urlStrategySchema,
    urlHost: z.string().min(1).max(253).nullable().optional(),
  })
  .strict();

export const proposeUpdateStrategyOp = defineOperation({
  name: "locales.propose_update_strategy",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeUpdateStrategyInput,
  output: z.object({ proposalId: z.string(), preview: z.unknown() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT url_strategy, url_host FROM locales WHERE code = ${input.code} LIMIT 1
    `)) as unknown as { url_strategy: string; url_host: string | null }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "locales.propose_update_strategy",
        message: `locale '${input.code}' not found`,
      });
    }
    if (
      target.url_strategy === input.urlStrategy &&
      (target.url_host ?? null) === (input.urlHost ?? null)
    ) {
      return err({
        kind: "HandlerError",
        operation: "locales.propose_update_strategy",
        message: "no change requested — strategy and host already match",
      });
    }
    const preview = await computePreview(tx, "update_strategy", input);
    const insertRows = (await tx.execute(sql`
      INSERT INTO locale_pending_actions (action_kind, payload, preview, proposed_by)
      VALUES ('update_strategy', ${JSON.stringify(input)}::jsonb, ${JSON.stringify(preview)}::jsonb, ${ctx.actorId}::uuid)
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const proposalId = insertRows[0]?.id;
    if (!proposalId) {
      return err({
        kind: "HandlerError",
        operation: "locales.propose_update_strategy",
        message: "no id returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "locales.propose_update_strategy",
      input,
      succeeded: true,
      entityId: proposalId,
      resultSummary: `code=${input.code} strategy=${input.urlStrategy}`,
    });
    return ok({ proposalId, preview });
  },
});

export const listPendingLocaleProposalsOp = defineOperation({
  name: "locales.list_pending",
  // CLAUDE.md §11.A: AI checks its own pending proposals when planning
  // — avoids re-proposing the same locale change the Owner is reviewing.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      status: z.enum([...PROPOSAL_STATUSES, "all"] as const).default("pending"),
    })
    .strict(),
  output: z.object({ proposals: z.array(proposalRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(
      input.status === "all"
        ? sql`
            SELECT id::text AS id, action_kind, payload, preview,
                   proposed_by::text AS proposed_by, proposed_at,
                   status, decided_by::text AS decided_by, decided_at, decision_note
            FROM locale_pending_actions
            ORDER BY proposed_at DESC
            LIMIT 200
          `
        : sql`
            SELECT id::text AS id, action_kind, payload, preview,
                   proposed_by::text AS proposed_by, proposed_at,
                   status, decided_by::text AS decided_by, decided_at, decision_note
            FROM locale_pending_actions
            WHERE status = ${input.status}
            ORDER BY proposed_at DESC
            LIMIT 200
          `,
    )) as unknown as ProposalDbRow[];
    return ok({ proposals: rows.map(proposalToOut) });
  },
});

// ---------------------------------------------------------------------
// Execute / Reject — the human-clicks-Approve path. AI is rejected at
// the Validator (actorScope = human + system).
// ---------------------------------------------------------------------

const executeProposalInput = z.object({ proposalId: z.string().uuid() }).strict();

interface LocaleConfigRow {
  code: string;
  display_name: string;
  url_strategy: "none" | "subdirectory" | "subdomain" | "domain";
  url_host: string | null;
  is_default: boolean;
}

async function loadLocaleConfig(tx: TransactionRunner, code: string): Promise<LocaleConfig | null> {
  const rows = (await tx.execute(sql`
    SELECT code, display_name, url_strategy, url_host, is_default
    FROM locales WHERE code = ${code} LIMIT 1
  `)) as unknown as LocaleConfigRow[];
  const r = rows[0];
  if (!r) return null;
  return {
    code: r.code,
    displayName: r.display_name,
    urlStrategy: r.url_strategy,
    urlHost: r.url_host,
    isDefault: r.is_default,
  };
}

async function readSiteBaseUrl(tx: TransactionRunner): Promise<string> {
  const rows = (await tx.execute(sql`
    SELECT site_base_url FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as { site_base_url: string }[];
  return rows[0]?.site_base_url ?? "http://localhost:8082";
}

/**
 * Extract the path portion of an absolute URL. Used to convert
 * resolveLocaleUrl output into the relative paths the redirects table
 * stores. Returns null when the URL parse fails (defensive — caller
 * skips that redirect rather than corrupting the table).
 */
function pathOf(absoluteUrl: string): string | null {
  try {
    const u = new URL(absoluteUrl);
    return u.pathname || "/";
  } catch {
    return null;
  }
}

/**
 * Returns true when both URLs are on the same host (so a path-only
 * redirect row is sufficient). Cross-host transitions need per-provider
 * edge rules and ride out under a FIXME(p15) until cloud adapters land.
 */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

export const executeLocaleProposalOp = defineOperation({
  name: "locales.execute_proposal",
  // Why human-only: §11.A — the Approve button. AI calls hit
  // ActorScopeRejected; the AI surface message says
  // "click Approve at /security/locales/pending".
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: executeProposalInput,
  output: z.object({
    applied: z.literal(true),
    /** P9 review pass — number of `redirects` rows inserted as a side-effect. */
    redirectsCreated: z.number().int().nonnegative(),
    /** Pages whose URL changed cross-host (subdomain/domain) — per-provider rules apply at deploy. */
    crossHostShifts: z.number().int().nonnegative(),
  }),
  handler: async (ctx, input, tx) => {
    let redirectsCreated = 0;
    let crossHostShifts = 0;
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, action_kind, payload, status
      FROM locale_pending_actions
      WHERE id = ${input.proposalId}::uuid LIMIT 1
      FOR UPDATE
    `)) as unknown as {
      id: string;
      action_kind: "create" | "delete" | "set_default" | "update_strategy";
      payload: unknown;
      status: ProposalStatus;
    }[];
    const proposal = rows[0];
    if (!proposal) {
      return err({
        kind: "HandlerError",
        operation: "locales.execute_proposal",
        message: "proposal not found",
      });
    }
    if (proposal.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "locales.execute_proposal",
        message: `proposal already ${proposal.status}`,
      });
    }
    const payload = (
      typeof proposal.payload === "string" ? JSON.parse(proposal.payload) : proposal.payload
    ) as Record<string, unknown>;

    if (proposal.action_kind === "create") {
      const code = String(payload.code);
      const displayName = String(payload.displayName);
      const urlStrategy = String(payload.urlStrategy ?? "subdirectory");
      const urlHost = (payload.urlHost as string | null | undefined) ?? null;
      await tx.execute(sql`
        INSERT INTO locales (code, display_name, url_strategy, url_host, is_default)
        VALUES (${code}, ${displayName}, ${urlStrategy}, ${urlHost}, false)
      `);
    } else if (proposal.action_kind === "delete") {
      const code = String(payload.code);
      const oldLocale = await loadLocaleConfig(tx, code);
      if (!oldLocale) {
        return err({
          kind: "HandlerError",
          operation: "locales.execute_proposal",
          message: `locale '${code}' no longer exists`,
        });
      }
      if (oldLocale.isDefault) {
        return err({
          kind: "HandlerError",
          operation: "locales.execute_proposal",
          message: "cannot delete the default locale — set a different default first",
        });
      }
      // P9 review pass — soft-delete the locale's pages AND insert a
      // 301 from each page's old URL → '/' so external link equity
      // still routes somewhere (Owner clicked Approve, this is the
      // CLAUDE.md §11.A explicit-consent moment). Cross-host source
      // URLs (subdomain/domain) get logged but no redirect row is
      // inserted — those need per-provider edge rules.
      const baseUrl = await readSiteBaseUrl(tx);
      const livePages = (await tx.execute(sql`
        SELECT id::text AS id, slug FROM pages
        WHERE locale = ${code} AND deleted_at IS NULL
      `)) as unknown as { id: string; slug: string }[];
      for (const p of livePages) {
        let oldUrl: string;
        try {
          oldUrl = resolveLocaleUrl(oldLocale, p.slug, baseUrl);
        } catch {
          continue;
        }
        const fromPath = pathOf(oldUrl);
        const oldOnSameHost = sameHost(oldUrl, baseUrl);
        if (fromPath && oldOnSameHost) {
          const ins = (await tx.execute(sql`
            INSERT INTO redirects (from_path, to_path, status_code, created_by)
            VALUES (${fromPath}, '/', 301, ${ctx.actorId}::uuid)
            ON CONFLICT (from_path) DO NOTHING
            RETURNING id
          `)) as unknown as { id: string }[];
          if (ins.length > 0) redirectsCreated += 1;
        } else {
          crossHostShifts += 1;
        }
        await tx.execute(sql`
          UPDATE pages SET deleted_at = now() WHERE id = ${p.id}::uuid
        `);
      }
      await tx.execute(sql`DELETE FROM locales WHERE code = ${code}`);
    } else if (proposal.action_kind === "set_default") {
      const code = String(payload.code);
      // Atomic flip: clear all is_default, set the new one.
      await tx.execute(sql`UPDATE locales SET is_default = false, updated_at = now()`);
      const updated = (await tx.execute(sql`
        UPDATE locales SET is_default = true, updated_at = now()
        WHERE code = ${code}
        RETURNING code
      `)) as unknown as { code: string }[];
      if (updated.length === 0) {
        return err({
          kind: "HandlerError",
          operation: "locales.execute_proposal",
          message: `locale '${code}' no longer exists`,
        });
      }
    } else if (proposal.action_kind === "update_strategy") {
      const code = String(payload.code);
      const urlStrategy = String(payload.urlStrategy) as LocaleConfig["urlStrategy"];
      const urlHost = (payload.urlHost as string | null | undefined) ?? null;
      const oldLocale = await loadLocaleConfig(tx, code);
      if (!oldLocale) {
        return err({
          kind: "HandlerError",
          operation: "locales.execute_proposal",
          message: `locale '${code}' no longer exists`,
        });
      }
      const updated = (await tx.execute(sql`
        UPDATE locales
        SET url_strategy = ${urlStrategy},
            url_host = ${urlHost},
            updated_at = now()
        WHERE code = ${code}
        RETURNING code
      `)) as unknown as { code: string }[];
      if (updated.length === 0) {
        return err({
          kind: "HandlerError",
          operation: "locales.execute_proposal",
          message: `locale '${code}' no longer exists`,
        });
      }
      // P9 review pass — emit one 301 per published page from the old
      // URL path → the new URL path. Same-host transitions land in the
      // redirects table; cross-host transitions need per-provider edge
      // rules and ride out under FIXME(p15) for cloud adapters.
      const newLocale: LocaleConfig = { ...oldLocale, urlStrategy, urlHost };
      const baseUrl = await readSiteBaseUrl(tx);
      const livePages = (await tx.execute(sql`
        SELECT slug FROM pages
        WHERE locale = ${code} AND deleted_at IS NULL AND status = 'published'
      `)) as unknown as { slug: string }[];
      for (const p of livePages) {
        let oldUrl: string;
        let newUrl: string;
        try {
          oldUrl = resolveLocaleUrl(oldLocale, p.slug, baseUrl);
          newUrl = resolveLocaleUrl(newLocale, p.slug, baseUrl);
        } catch {
          continue;
        }
        if (oldUrl === newUrl) continue;
        const fromPath = pathOf(oldUrl);
        const toPath = pathOf(newUrl);
        const sameHostFromOld = sameHost(oldUrl, baseUrl);
        const sameHostToNew = sameHost(newUrl, baseUrl);
        if (fromPath && toPath && sameHostFromOld && sameHostToNew && fromPath !== toPath) {
          const ins = (await tx.execute(sql`
            INSERT INTO redirects (from_path, to_path, status_code, created_by)
            VALUES (${fromPath}, ${toPath}, 301, ${ctx.actorId}::uuid)
            ON CONFLICT (from_path) DO NOTHING
            RETURNING id
          `)) as unknown as { id: string }[];
          if (ins.length > 0) redirectsCreated += 1;
        } else {
          // FIXME(p15): cross-host swap (subdomain/domain). Per-provider
          // edge rules emit the redirect at deploy time; the redirects
          // table only stores path-only entries.
          crossHostShifts += 1;
        }
      }
    }

    await tx.execute(sql`
      UPDATE locale_pending_actions
      SET status = 'applied', decided_by = ${ctx.actorId}::uuid, decided_at = now()
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "locales.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary:
        redirectsCreated > 0 || crossHostShifts > 0
          ? `${proposal.action_kind} applied redirects=${redirectsCreated} cross_host=${crossHostShifts}`
          : `${proposal.action_kind} applied`,
    });
    return ok({ applied: true as const, redirectsCreated, crossHostShifts });
  },
});

const rejectProposalInput = z
  .object({
    proposalId: z.string().uuid(),
    note: z.string().max(500).optional(),
  })
  .strict();

export const rejectLocaleProposalOp = defineOperation({
  name: "locales.reject_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: rejectProposalInput,
  output: z.object({ rejected: z.literal(true) }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT status FROM locale_pending_actions
      WHERE id = ${input.proposalId}::uuid LIMIT 1
    `)) as unknown as { status: ProposalStatus }[];
    const proposal = rows[0];
    if (!proposal) {
      return err({
        kind: "HandlerError",
        operation: "locales.reject_proposal",
        message: "proposal not found",
      });
    }
    if (proposal.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "locales.reject_proposal",
        message: `proposal already ${proposal.status}`,
      });
    }
    await tx.execute(sql`
      UPDATE locale_pending_actions
      SET status = 'rejected',
          decided_by = ${ctx.actorId}::uuid,
          decided_at = now(),
          decision_note = ${input.note ?? null}
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "locales.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.note ? `note=${input.note.slice(0, 80)}` : "rejected",
    });
    return ok({ rejected: true as const });
  },
});
