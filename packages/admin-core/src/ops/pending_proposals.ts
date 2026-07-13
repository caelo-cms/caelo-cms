// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.32 — cross-domain pending-proposals aggregator.
 *
 * The propose/execute sweep (v0.2.19 → v0.2.30) shipped 11 per-domain
 * `*_pending_actions` tables. Older subsystems use varying shapes
 * (`locale_pending_actions`, `plugin_rate_limit_proposals`,
 * `site_memory_proposals`, `skill_proposals`). Each domain has a
 * per-domain list_pending op for its Owner UI page; nothing aggregates
 * across them. Two consumers need the union:
 *
 *  1. The chat-runner's `## Pending proposals` system-prompt block
 *     (CLAUDE.md §11.A: "the AI doesn't re-propose what's already in
 *     the queue").
 *  2. The AppShell bell badge (`notifications.aggregate`) — counts a
 *     single integer for "things waiting on you".
 *
 * One UNION ALL across every table; Postgres plans this as N small
 * partial-index scans, then sort + limit. Cheap enough to call on
 * every chat turn.
 *
 * Schema reality: `media_alt_proposals` (no `status` column) stays
 * out — different shape, surfaced via the dedicated alt-proposals UI.
 * `import_runs` joined in 0124 (status='proposed' aliased into the
 * common shape): the chat's pending strip must carry the crawl
 * Approve button like every other §11.A domain.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const itemSchema = z.object({
  domain: z.string(),
  kind: z.string(),
  proposalId: z.string(),
  summary: z.string(),
  proposedBy: z.string(),
  proposedAt: z.string(),
  /** v0.2.35 + v0.2.36 — chat session that originated this proposal,
   *  if any. null for proposals from background workers / direct human
   *  Owner clicks. */
  chatSessionId: z.string().nullable(),
  chatSessionTitle: z.string().nullable(),
});

const byDomainSchema = z.record(z.string(), z.number().int().nonnegative());

export const listPendingProposalsAcrossDomainsOp = defineOperation({
  name: "pending_proposals.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  output: z.object({
    items: z.array(itemSchema),
    byDomain: byDomainSchema,
    total: z.number().int().nonnegative(),
  }),
  handler: async (_ctx, input, tx) => {
    const limit = input.limit ?? 50;
    // Common-shape stanzas use `created_at`. Older tables use
    // `proposed_at` — they're explicitly aliased so the outer ORDER BY
    // sees the same column name. The `kind` column normalizes
    // `action_kind` (locales) and inferred kinds (gateway, site_memory,
    // skills) into one discriminator.
    //
    // v0.2.36 — joins chat_sessions to project chatSessionId + title
    // per row (v0.2.35 schema added chat_session_id to all unified
    // tables; older locale/gateway/site_memory/skills already have
    // their own chat_session_id column).
    const rows = (await tx.execute(sql`
      WITH all_pending AS (
        -- v0.2.19 → v0.2.30 unified-shape *_pending_actions tables.
        SELECT 'deploy'::text AS domain, kind, id::text AS id,
               proposed_by::text AS proposed_by, created_at AS proposed_at,
               COALESCE(preview->>'fromTarget', preview->>'target', 'deploy') AS summary,
               chat_session_id::text AS chat_session_id
          FROM deploy_pending_actions WHERE status = 'pending'
        UNION ALL
        SELECT 'layouts', kind, id::text, proposed_by::text, created_at,
               COALESCE(preview->>'slug', preview->>'displayName', 'layout'),
               chat_session_id::text
          FROM layout_pending_actions WHERE status = 'pending'
        UNION ALL
        SELECT 'users', kind, id::text, proposed_by::text, created_at,
               COALESCE(preview->>'email', preview->>'displayName', 'user'),
               chat_session_id::text
          FROM user_pending_actions WHERE status = 'pending'
        UNION ALL
        SELECT 'roles', kind, id::text, proposed_by::text, created_at,
               COALESCE(preview->>'name', preview->>'roleName', 'role'),
               chat_session_id::text
          FROM role_pending_actions WHERE status = 'pending'
        UNION ALL
        SELECT 'snapshots', kind, id::text, proposed_by::text, created_at,
               COALESCE(preview->>'pageSlug', preview->>'templateSlug',
                        preview->>'moduleSlug', preview->>'snapshotCreatedAt', 'snapshot'),
               chat_session_id::text
          FROM snapshot_revert_pending_actions WHERE status = 'pending'
        UNION ALL
        SELECT 'experiments', kind, id::text, proposed_by::text, created_at,
               COALESCE(preview->>'experimentSlug', 'experiment'),
               chat_session_id::text
          FROM experiment_pending_actions WHERE status = 'pending'
        UNION ALL
        SELECT 'email_config', 'set', id::text, proposed_by::text, created_at,
               COALESCE(preview->>'transport', 'email'),
               chat_session_id::text
          FROM email_config_pending_actions WHERE status = 'pending'
        UNION ALL
        SELECT 'ai_providers', kind, id::text, proposed_by::text, created_at,
               COALESCE(preview->>'name', 'provider'),
               chat_session_id::text
          FROM ai_providers_pending_actions WHERE status = 'pending'
        UNION ALL
        SELECT 'mcp_tokens', kind, id::text, proposed_by::text, created_at,
               COALESCE(preview->>'displayName', 'token'),
               chat_session_id::text
          FROM mcp_token_pending_actions WHERE status = 'pending'
        UNION ALL
        SELECT 'templates', kind, id::text, proposed_by::text, created_at,
               COALESCE(preview->>'templateSlug', preview->>'currentDisplayName', 'template'),
               chat_session_id::text
          FROM template_pending_actions WHERE status = 'pending'
        UNION ALL
        SELECT 'domains', kind, id::text, proposed_by::text, created_at,
               COALESCE(preview->>'hostname', 'domain'),
               chat_session_id::text
          FROM domain_pending_actions WHERE status = 'pending'
        UNION ALL
        -- v0.11.0 (#45) — themes primitive.
        SELECT 'themes', kind, id::text, proposed_by::text, created_at,
               COALESCE(preview->>'slug', preview->>'targetSlug',
                        preview->>'displayName', 'theme'),
               chat_session_id::text
          FROM theme_pending_actions WHERE status = 'pending'
        -- Older proposal tables (varying shape; aliased into common columns).
        UNION ALL
        -- 0124 — import runs awaiting the crawl approval (status
        -- 'proposed' in its own lifecycle; aliased into the common
        -- shape so the chat strip + inbox count them).
        SELECT 'import', 'site_import', id::text, proposed_by::text, created_at,
               -- issue #229 — LIST mode names the exact page count; depth
               -- mode says "up to N".
               CASE
                 WHEN explicit_urls IS NOT NULL
                   THEN 'crawl ' || source_url || ' (' || jsonb_array_length(explicit_urls) || ' specific pages)'
                 ELSE 'crawl ' || source_url || ' (up to ' || max_pages || ' pages)'
               END,
               chat_session_id::text
          FROM import_runs WHERE status = 'proposed'
        UNION ALL
        SELECT 'locales', action_kind, id::text, proposed_by::text, proposed_at,
               COALESCE(payload->>'code', 'locale'),
               chat_session_id::text
          FROM locale_pending_actions WHERE status = 'pending'
        UNION ALL
        SELECT 'gateway', 'rate_limit', id::text, proposed_by::text, created_at,
               plugin_slug || '.' || operation,
               chat_session_id::text
          FROM plugin_rate_limit_proposals WHERE status = 'pending'
        UNION ALL
        SELECT 'site_memory', slot, id::text, proposed_by::text, created_at,
               COALESCE(LEFT(body, 60), slot),
               chat_session_id::text
          FROM site_memory_proposals WHERE status = 'pending'
        UNION ALL
        SELECT 'skills', 'create', id::text, proposed_by::text, created_at,
               slug, chat_session_id::text
          FROM skill_proposals WHERE status = 'pending'
      )
      SELECT p.domain, p.kind, p.id, p.proposed_by, p.proposed_at, p.summary,
             p.chat_session_id, c.title AS chat_session_title
      FROM all_pending p
      LEFT JOIN chat_sessions c ON c.id::text = p.chat_session_id
      ORDER BY p.proposed_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      domain: string;
      kind: string;
      id: string;
      proposed_by: string;
      proposed_at: string | Date;
      summary: string;
      chat_session_id: string | null;
      chat_session_title: string | null;
    }>;

    // Per-domain counts (separate query so the items-list LIMIT
    // doesn't truncate the totals).
    const counts = (await tx.execute(sql`
      WITH all_pending AS (
        SELECT 'deploy'::text AS domain FROM deploy_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'layouts' FROM layout_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'users' FROM user_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'roles' FROM role_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'snapshots' FROM snapshot_revert_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'experiments' FROM experiment_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'email_config' FROM email_config_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'ai_providers' FROM ai_providers_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'mcp_tokens' FROM mcp_token_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'templates' FROM template_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'domains' FROM domain_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'themes' FROM theme_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'locales' FROM locale_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 'gateway' FROM plugin_rate_limit_proposals WHERE status = 'pending'
        UNION ALL SELECT 'site_memory' FROM site_memory_proposals WHERE status = 'pending'
        UNION ALL SELECT 'skills' FROM skill_proposals WHERE status = 'pending'
        UNION ALL SELECT 'import' FROM import_runs WHERE status = 'proposed'
      )
      SELECT domain, count(*)::int AS c FROM all_pending GROUP BY domain
    `)) as unknown as Array<{ domain: string; c: number }>;

    const byDomain: Record<string, number> = {};
    let total = 0;
    for (const row of counts) {
      byDomain[row.domain] = row.c;
      total += row.c;
    }

    return ok({
      items: rows.map((r) => ({
        domain: r.domain,
        kind: r.kind,
        proposalId: r.id,
        summary: r.summary,
        proposedBy: r.proposed_by,
        proposedAt:
          r.proposed_at instanceof Date ? r.proposed_at.toISOString() : String(r.proposed_at),
        chatSessionId: r.chat_session_id,
        chatSessionTitle: r.chat_session_title,
      })),
      byDomain,
      total,
    });
  },
});
