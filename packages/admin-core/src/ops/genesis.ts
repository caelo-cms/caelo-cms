// SPDX-License-Identifier: MPL-2.0

/**
 * issue #163 — Site Genesis ops (epic #149, two-level architecture).
 *
 * Drafts are complete freeform single-file HTML pages, one per design
 * direction, produced by parallel draft subagents at design-time. The
 * operator compares them at /design/genesis (sandboxed iframes) or
 * verbally in chat; exactly one becomes `selected` — the design source
 * the compiler (#164) derives the CMS structure from.
 *
 * All three ops are routine (`human + ai + system`): drafts are
 * candidates with zero blast radius until the compiler materialises
 * the selected one through the existing gates (theme propose/execute,
 * draft pages). Selection itself is one-click revertable (select a
 * different draft), so per §11.A it stays ungated — but the AI's skill
 * instructs it to select only after the operator explicitly chose.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, genesisAddDraftInput, genesisDraftStatus, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { toIsoRequired } from "./_helpers.js";

const draftRow = z.object({
  id: z.string(),
  direction: z.string(),
  rationale: z.string(),
  status: genesisDraftStatus,
  createdAt: z.string(),
  /** Byte size instead of the body — listing is a decision surface. */
  htmlBytes: z.number().int().nonnegative(),
  /** Present only when `includeHtml: true` (the selection UI's iframes). */
  html: z.string().optional(),
});

export const addGenesisDraftOp = defineOperation({
  name: "genesis.add_draft",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: genesisAddDraftInput,
  output: z.object({ draftId: z.string(), candidateCount: z.number().int() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO genesis_drafts (direction, rationale, html)
      VALUES (${input.direction}, ${input.rationale}, ${input.html})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const draftId = rows[0]?.id;
    if (!draftId) {
      return err({
        kind: "HandlerError",
        operation: "genesis.add_draft",
        message: "insert returned no row",
      });
    }
    const count = (await tx.execute(
      sql`SELECT COUNT(*)::int AS n FROM genesis_drafts WHERE status = 'candidate'`,
    )) as unknown as { n: number | string }[];
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "genesis.add_draft",
      input: { direction: input.direction, htmlBytes: input.html.length },
      succeeded: true,
      resultSummary: `draft ${draftId} (${input.direction})`,
    });
    return ok({ draftId, candidateCount: Number(count[0]?.n ?? 0) });
  },
});

export const listGenesisDraftsOp = defineOperation({
  name: "genesis.list_drafts",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ includeHtml: z.boolean().default(false) }).strict(),
  output: z.object({ drafts: z.array(draftRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, direction, rationale, status,
             created_at, length(html)::int AS html_bytes
             ${input.includeHtml ? sql`, html` : sql``}
      FROM genesis_drafts
      WHERE status <> 'discarded'
      ORDER BY created_at ASC
    `)) as unknown as {
      id: string;
      direction: string;
      rationale: string;
      status: "candidate" | "selected" | "discarded";
      created_at: string | Date;
      html_bytes: number;
      html?: string;
    }[];
    return ok({
      drafts: rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        rationale: r.rationale,
        status: r.status,
        createdAt: toIsoRequired(r.created_at, "genesis_drafts.created_at"),
        htmlBytes: r.html_bytes,
        ...(r.html !== undefined ? { html: r.html } : {}),
      })),
    });
  },
});

export const selectGenesisDraftOp = defineOperation({
  name: "genesis.select_draft",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ draftId: z.string().uuid() }).strict(),
  output: z.object({ previousSelectedId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const target = (await tx.execute(sql`
      SELECT id::text AS id, status FROM genesis_drafts
      WHERE id = ${input.draftId}::uuid LIMIT 1
    `)) as unknown as { id: string; status: string }[];
    if (target.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "genesis.select_draft",
        message: "draft not found — call genesis.list_drafts for current draft ids",
      });
    }
    if (target[0]?.status === "discarded") {
      return err({
        kind: "HandlerError",
        operation: "genesis.select_draft",
        message: "draft was discarded — save a fresh draft or pick a candidate",
      });
    }
    // Demote-then-promote inside the op's transaction; the partial
    // unique index backs the single-selected invariant at the DB layer.
    const prev = (await tx.execute(sql`
      UPDATE genesis_drafts SET status = 'candidate'
      WHERE status = 'selected' AND id <> ${input.draftId}::uuid
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    await tx.execute(sql`
      UPDATE genesis_drafts SET status = 'selected' WHERE id = ${input.draftId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "genesis.select_draft",
      input,
      succeeded: true,
      resultSummary: `selected ${input.draftId}${prev[0] ? ` (was ${prev[0].id})` : ""}`,
    });
    return ok({ previousSelectedId: prev[0]?.id ?? null });
  },
});
