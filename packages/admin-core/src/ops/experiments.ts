// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — A/B experiments ops.
 *  - experiments.create / activate / complete / list / get / get_results
 *  - experiments.record_assignment — system-only; called by the gateway's
 *    /api/variant/assign endpoint to bump per-(variant, visitor) counts.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";

/**
 * P13 ideas-pass — `htmlPatches` lets a variant carry per-string
 * find/replace operations applied to the composed page HTML before
 * the variant file lands on disk. Lightweight model that ships
 * today; richer per-module overrides land with P12A typed-content.
 *
 * Example: `[{ find: "Sign up free", replace: "Try it free" }]`
 * swaps a CTA in the hero. The static generator applies patches
 * verbatim — no escaping, no regex.
 */
const variantSpec = z.object({
  label: z.string().min(1).max(120),
  weight: z.number().min(0).max(1),
  htmlPatches: z
    .array(
      z.object({
        find: z.string().min(1).max(2000),
        replace: z.string().max(10_000),
      }),
    )
    .max(20)
    .optional(),
});

const experimentRow = z.object({
  id: z.string(),
  slug: z.string(),
  pageId: z.string(),
  variants: z.array(variantSpec),
  status: z.enum(["draft", "active", "completed"]),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  winningVariant: z.string().nullable(),
  createdAt: z.string(),
});

export const createExperimentOp = defineOperation({
  name: "experiments.create",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      slug: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-z][a-z0-9-]*$/),
      pageId: z.string().uuid(),
      variants: z.array(variantSpec).min(2).max(10),
    })
    .strict(),
  output: z.object({ experimentId: z.string() }),
  handler: async (ctx, input, tx) => {
    const totalWeight = input.variants.reduce((acc, v) => acc + v.weight, 0);
    if (Math.abs(totalWeight - 1) > 1e-6) {
      return err({
        kind: "HandlerError",
        operation: "experiments.create",
        message: `variant weights must sum to 1 (got ${totalWeight})`,
      });
    }
    const rows = (await tx.execute(sql`
      INSERT INTO experiments (slug, page_id, variants, status, created_by)
      VALUES (
        ${input.slug}, ${input.pageId}::uuid,
        ${JSON.stringify(input.variants)}::jsonb,
        'draft', ${ctx.actorId}::uuid
      )
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "experiments.create",
        message: "no row returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "experiments.create",
      input,
      succeeded: true,
      resultSummary: `experiment ${id}: ${input.slug} on page ${input.pageId}`,
    });
    return ok({ experimentId: id });
  },
});

export const activateExperimentOp = defineOperation({
  name: "experiments.activate",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ experimentId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE experiments
         SET status = 'active', started_at = COALESCE(started_at, now())
       WHERE id = ${input.experimentId}::uuid AND status = 'draft'
       RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    if (rows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "experiments.activate",
        message: "experiment not found or not in draft status",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "experiments.activate",
      input,
      succeeded: true,
      resultSummary: `activated ${input.experimentId}`,
    });
    return ok({});
  },
});

export const completeExperimentOp = defineOperation({
  name: "experiments.complete",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      experimentId: z.string().uuid(),
      winningVariant: z.string().min(1).max(120).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE experiments
         SET status = 'completed',
             completed_at = now(),
             winning_variant = ${input.winningVariant ?? null}
       WHERE id = ${input.experimentId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "experiments.complete",
      input,
      succeeded: true,
      resultSummary: `completed ${input.experimentId}`,
    });
    return ok({});
  },
});

export const listExperimentsOp = defineOperation({
  name: "experiments.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      status: z.enum(["draft", "active", "completed"]).optional(),
    })
    .strict(),
  output: z.object({ experiments: z.array(experimentRow) }),
  handler: async (_ctx, input, tx) => {
    const filter = input.status ? sql`WHERE status = ${input.status}` : sql.raw("");
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, page_id::text AS page_id, variants, status,
             started_at, completed_at, winning_variant, created_at
      FROM experiments
      ${filter}
      ORDER BY created_at DESC
      LIMIT 200
    `)) as unknown as Array<{
      id: string;
      slug: string;
      page_id: string;
      variants: Array<{ label: string; weight: number }>;
      status: "draft" | "active" | "completed";
      started_at: string | Date | null;
      completed_at: string | Date | null;
      winning_variant: string | null;
      created_at: string | Date;
    }>;
    return ok({
      experiments: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        pageId: r.page_id,
        variants: r.variants,
        status: r.status,
        startedAt: r.started_at
          ? r.started_at instanceof Date
            ? r.started_at.toISOString()
            : String(r.started_at)
          : null,
        completedAt: r.completed_at
          ? r.completed_at instanceof Date
            ? r.completed_at.toISOString()
            : String(r.completed_at)
          : null,
        winningVariant: r.winning_variant,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});

export const getExperimentResultsOp = defineOperation({
  name: "experiments.get_results",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ experimentId: z.string().uuid() }).strict(),
  output: z.object({
    counts: z.array(
      z.object({
        variantLabel: z.string(),
        uniqueVisitors: z.number(),
        totalImpressions: z.number(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT variant_label,
             COUNT(*)::int        AS unique_visitors,
             SUM(impressions)::int AS total_impressions
      FROM experiment_assignments
      WHERE experiment_id = ${input.experimentId}::uuid
      GROUP BY variant_label
      ORDER BY variant_label ASC
    `)) as unknown as Array<{
      variant_label: string;
      unique_visitors: number;
      total_impressions: number;
    }>;
    return ok({
      counts: rows.map((r) => ({
        variantLabel: r.variant_label,
        uniqueVisitors: r.unique_visitors,
        totalImpressions: r.total_impressions,
      })),
    });
  },
});

export const recordAssignmentOp = defineOperation({
  name: "experiments.record_assignment",
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      experimentId: z.string().uuid(),
      variantLabel: z.string().min(1).max(120),
      visitorIdHash: z.string().min(1).max(64),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      INSERT INTO experiment_assignments (experiment_id, variant_label, visitor_id_hash, impressions, first_seen_at, last_seen_at)
      VALUES (${input.experimentId}::uuid, ${input.variantLabel}, ${input.visitorIdHash}, 1, now(), now())
      ON CONFLICT (experiment_id, variant_label, visitor_id_hash) DO UPDATE SET
        impressions  = experiment_assignments.impressions + 1,
        last_seen_at = now()
    `);
    return ok({});
  },
});
