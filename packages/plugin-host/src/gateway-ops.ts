// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/gateway-ops — the core Query API operations the
 * public API gateway runs (issue #634).
 *
 * The gateway's OperationRegistry is its allowlist into cms_admin: it holds
 * exactly the operations a visitor-facing path needs, nothing else. Each
 * one runs as `gateway_role`, whose grants (migrations 0248 + 0252) cover
 * precisely the columns and rows these handlers touch — the registry and
 * the database agree on the surface, and the database is the bound:
 *
 *   experiments.get_active         /api/variant/assign — one active
 *                                  experiment's variant weights by slug
 *   experiments.record_assignment  /api/variant/assign — the per-visitor
 *                                  impression counter
 *   comment_archive.list_for_page  the comments plugin's `list_approved`
 *                                  (via `ctx.cms.call`) — approved comments
 *                                  only, enforced by a gateway_role policy
 *
 * They live here, not in admin-core, because the gateway must not import
 * admin-core (it would pull the whole authoring stack into the public
 * image); the admin registers the same definitions, so the two processes
 * can never drift on an operation's shape.
 */

import { defineOperation, type OperationRegistry } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const assignmentVariant = z.object({ label: z.string(), weight: z.number() });

/**
 * One active experiment by slug, reduced to what variant assignment needs.
 * Deliberately narrower than `experiments.list` (no page, timestamps,
 * winner or drafts) so the gateway's grant can be just as narrow.
 */
export const getActiveExperimentOp = defineOperation({
  name: "experiments.get_active",
  // Why system-only: the gateway's /api/variant/assign lookup. Authoring
  // surfaces read experiments through experiments.list.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      slug: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-z][a-z0-9-]*$/),
    })
    .strict(),
  output: z.object({
    experiment: z.object({ id: z.string(), variants: z.array(assignmentVariant) }).nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, variants
      FROM experiments
      WHERE slug = ${input.slug} AND status = 'active'
      LIMIT 1
    `)) as unknown as Array<{ id: string; variants: Array<{ label: string; weight: number }> }>;
    const row = rows[0];
    return ok({
      experiment: row
        ? { id: row.id, variants: row.variants.map((v) => ({ label: v.label, weight: v.weight })) }
        : null,
    });
  },
});

export const recordAssignmentOp = defineOperation({
  name: "experiments.record_assignment",
  // Why system-only: the gateway's /api/variant/assign endpoint records visitor assignments —
  // traffic data, not an authoring action.
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

const listForPageInput = z
  .object({
    pageId: z.string().uuid(),
    status: z.enum(["approved", "rejected", "spam"]).optional(),
    since: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

const archiveRowSchema = z.object({
  id: z.string(),
  publicRowId: z.string(),
  pageId: z.string(),
  parentId: z.string().nullable(),
  authorName: z.string(),
  content: z.string(),
  status: z.string(),
  submittedAt: z.string(),
  archivedAt: z.string(),
});

/**
 * Read archived comments for one page (approved by default). The static
 * bake and the comments plugin's visitor `list_approved` both read here
 * (v0.2.18 Fix D: cms_public only holds the pending inbox). In the gateway
 * a `gateway_role` policy limits the rows to approved ones whatever
 * `status` the caller passes.
 */
export const commentArchiveListForPageOp = defineOperation({
  name: "comment_archive.list_for_page",
  actorScope: ["human", "ai", "system", "plugin"],
  database: "cms_admin",
  input: listForPageInput,
  output: z.object({ comments: z.array(archiveRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const status = input.status ?? "approved";
    const limit = input.limit ?? 200;
    const since = input.since ?? "1970-01-01T00:00:00Z";
    const rows = (await tx.execute(sql`
      SELECT
        id::text             AS id,
        public_row_id::text  AS public_row_id,
        page_id::text        AS page_id,
        parent_id::text      AS parent_id,
        author_name,
        content,
        status,
        submitted_at,
        archived_at
      FROM comment_archive
      WHERE page_id = ${input.pageId}::uuid
        AND status = ${status}
        AND archived_at > ${since}::timestamptz
      ORDER BY submitted_at ASC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      public_row_id: string;
      page_id: string;
      parent_id: string | null;
      author_name: string;
      content: string;
      status: string;
      submitted_at: string | Date;
      archived_at: string | Date;
    }>;
    return ok({
      comments: rows.map((r) => ({
        id: r.id,
        publicRowId: r.public_row_id,
        pageId: r.page_id,
        parentId: r.parent_id,
        authorName: r.author_name,
        content: r.content,
        status: r.status,
        submittedAt: r.submitted_at instanceof Date ? r.submitted_at.toISOString() : r.submitted_at,
        archivedAt: r.archived_at instanceof Date ? r.archived_at.toISOString() : r.archived_at,
      })),
    });
  },
});

/**
 * Register the gateway's whole core-operation surface on its registry.
 * Nothing else belongs there: an operation missing here answers
 * `UnknownOperation` to the gateway's plugins, and one added here needs a
 * matching `gateway_role` grant (migration 0252).
 */
export function registerGatewayOperations(registry: OperationRegistry): void {
  registry.register(getActiveExperimentOp);
  registry.register(recordAssignmentOp);
  registry.register(commentArchiveListForPageOp);
}
