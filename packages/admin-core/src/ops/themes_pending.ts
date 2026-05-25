// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — Themes propose/execute gate per CLAUDE.md §11.A (#45 Phase 2 gated).
 *
 * Three gated kinds:
 *
 *   - `create`   — minting a new theme variant. Optional `preset` +
 *                  brand `overrides` (loose names normalized server-side
 *                  at propose time so the preview reflects the resolved
 *                  tokens, not the operator's loose input).
 *   - `activate` — flipping `is_active=true` to a different row. The
 *                  execute uses one tx + the `themes_one_active` partial
 *                  unique index to make the flip atomic. **DB flip only**
 *                  — the production static build keeps serving the old
 *                  theme's CSS until the Owner separately approves
 *                  `propose_deploy_promote` (CMS_REQUIREMENTS §6).
 *   - `delete`   — removing a theme. Execute rejects on the active row.
 *
 * Shape mirrors layout_pending_actions (v0.2.20) so the cross-domain
 * inbox + GC worker treat themes like every other gated domain.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  applyDtcgWrites,
  deriveOklchPrimaryRamp,
  err,
  extractPrimaryColorSeed,
  getPreset,
  InvalidColorValue,
  InvalidSeedColor,
  mergeRampIntoTokens,
  normalizeTokens,
  ok,
  type PresetName,
  PresetNotFound,
  type ThemeDocument,
  TokenCategoryMismatch,
  UnknownTokenName,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "./_propose-helpers.js";
import { emitThemeWrite, fetchThemeOrNull } from "./themes.js";

const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

// ────────────────────────────────────────────────────────────────────
// propose_create
// ────────────────────────────────────────────────────────────────────

const proposeCreateInput = z
  .object({
    slug: slugSchema,
    displayName: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    /**
     * Required — every new theme starts from a preset. Operators that
     * want a blank slate pass "minimal" and overwrite. Forcing a
     * preset keeps the dogfood install from accumulating half-themed
     * variants.
     */
    preset: z.enum(["shadcn-default", "minimal", "warm", "playful"]),
    /**
     * Loose-name brand overrides applied on top of the preset. Server
     * normalizes via theme-normalize.ts; ambiguous inputs surface as
     * `UnknownTokenName` so the AI's retry lands.
     */
    overrides: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const proposeCreateThemeOp = defineOperation({
  name: "themes.propose_create",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeCreateInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    // Slug must be unique.
    const dup = (await tx.execute(sql`
      SELECT 1 FROM themes WHERE slug = ${input.slug} LIMIT 1
    `)) as unknown as Array<{ exists: number }>;
    if (dup.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "themes.propose_create",
        message: `theme slug '${input.slug}' already in use — pick a different slug or update the existing theme via update_theme_tokens.`,
      });
    }

    // Resolve preset + overrides at propose time so the preview
    // carries the realised tokens (operator sees what they'd be
    // approving). Throws → AI-actionable error.
    let presetTokens: ThemeDocument;
    try {
      presetTokens = getPreset(input.preset);
    } catch (e) {
      if (e instanceof PresetNotFound) {
        return err({
          kind: "HandlerError",
          operation: "themes.propose_create",
          message: e.message,
        });
      }
      throw e;
    }

    let overridesNormalized: { wrote: readonly string[]; types: Record<string, string> } = {
      wrote: [],
      types: {},
    };
    // v0.11.1 (issue #76) — split `primaryColor` off the loose
    // overrides as a sentinel; if present, derive an OKLCh ramp now so
    // the preview reflects every stop the operator will see post-approve.
    //
    // v0.11.1 (issue #76 round-2 opt #3) — surface a structured error
    // when `overrides.primaryColor` is present but not a CSS-color
    // string. Pre-fix, a non-string seed (e.g. `42` from a malformed
    // AI tool call) was silently dropped: the operator got the preset
    // verbatim without the ramp, no warning. Now we look at the raw
    // value BEFORE extractPrimaryColorSeed's typeof narrowing and
    // throw an AI-actionable error per CLAUDE.md §11.
    const rawPrimaryColor = (input.overrides ?? {})["primaryColor"];
    if (rawPrimaryColor !== undefined && typeof rawPrimaryColor !== "string") {
      return err({
        kind: "HandlerError",
        operation: "themes.propose_create",
        message: `overrides.primaryColor must be a CSS color string (got ${typeof rawPrimaryColor}). Pass a value like '#ff6600' or 'oklch(0.7 0.18 30)'.`,
      });
    }
    const { primaryColor: rampSeed, rest: nonRampOverrides } = extractPrimaryColorSeed(
      input.overrides,
    );
    let derivedRampPaths: readonly string[] = [];
    if (rampSeed !== undefined) {
      try {
        const ramp = deriveOklchPrimaryRamp(rampSeed);
        derivedRampPaths = ramp.derivedPaths;
      } catch (e) {
        if (e instanceof InvalidSeedColor) {
          return err({
            kind: "HandlerError",
            operation: "themes.propose_create",
            message: e.message,
          });
        }
        throw e;
      }
    }
    if (nonRampOverrides && Object.keys(nonRampOverrides).length > 0) {
      try {
        const normalized = normalizeTokens(nonRampOverrides);
        overridesNormalized = {
          wrote: normalized.canonicalPaths,
          types: normalized.types,
        };
      } catch (e) {
        // AI-actionable error surface (#45 AC #7). Surface every typed
        // override-validation error so the AI's retry can land
        // without a round-trip through generic Zod messaging.
        if (
          e instanceof UnknownTokenName ||
          e instanceof InvalidColorValue ||
          e instanceof TokenCategoryMismatch
        ) {
          return err({
            kind: "HandlerError",
            operation: "themes.propose_create",
            message: e.message,
          });
        }
        throw e;
      }
    }

    const preview: Record<string, unknown> = {
      slug: input.slug,
      displayName: input.displayName,
      preset: input.preset,
      presetTokenCount: Object.keys(presetTokens).length,
      overrideCount: overridesNormalized.wrote.length + (rampSeed !== undefined ? 1 : 0),
      overridePaths: [
        ...overridesNormalized.wrote,
        ...(rampSeed !== undefined ? ["primaryColor"] : []),
      ],
      // v0.11.1 (issue #76) — reflect the OKLCh ramp in the preview so
      // the Owner sees what they're approving. derivedRampPaths is empty
      // when overrides.primaryColor is unset.
      derivedRampPaths,
      primaryColorSeed: rampSeed ?? null,
    };

    return queueProposal(tx, ctx, "create", null, input, preview, "themes.propose_create");
  },
});

// ────────────────────────────────────────────────────────────────────
// propose_activate
// ────────────────────────────────────────────────────────────────────

const proposeActivateInput = z.object({ themeId: z.string().uuid() }).strict();

export const proposeActivateThemeOp = defineOperation({
  name: "themes.propose_activate",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeActivateInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name, is_active
      FROM themes WHERE id = ${input.themeId}::uuid LIMIT 1
    `)) as unknown as Array<{ id: string; slug: string; display_name: string; is_active: boolean }>;
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "themes.propose_activate",
        message: `theme ${input.themeId} not found`,
      });
    }
    if (target.is_active) {
      return err({
        kind: "HandlerError",
        operation: "themes.propose_activate",
        message: `theme '${target.slug}' is already active — nothing to do.`,
      });
    }
    const currentActive = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name
      FROM themes WHERE is_active = true LIMIT 1
    `)) as unknown as Array<{ id: string; slug: string; display_name: string }>;
    const preview: Record<string, unknown> = {
      targetSlug: target.slug,
      targetDisplayName: target.display_name,
      currentActiveSlug: currentActive[0]?.slug ?? null,
      currentActiveDisplayName: currentActive[0]?.display_name ?? null,
      note: "Approving this flips the DB row only — the live site still serves the previously-active theme's CSS until a deploy lands. After approval, queue a deploy via propose_deploy_promote.",
    };
    return queueProposal(tx, ctx, "activate", target.id, input, preview, "themes.propose_activate");
  },
});

// ────────────────────────────────────────────────────────────────────
// propose_delete
// ────────────────────────────────────────────────────────────────────

const proposeDeleteInput = z.object({ themeId: z.string().uuid() }).strict();

export const proposeDeleteThemeOp = defineOperation({
  name: "themes.propose_delete",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeDeleteInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name, is_active
      FROM themes WHERE id = ${input.themeId}::uuid LIMIT 1
    `)) as unknown as Array<{ id: string; slug: string; display_name: string; is_active: boolean }>;
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "themes.propose_delete",
        message: `theme ${input.themeId} not found`,
      });
    }
    if (target.is_active) {
      return err({
        kind: "HandlerError",
        operation: "themes.propose_delete",
        message: `cannot delete the active theme '${target.slug}' — activate a different theme first via propose_activate_theme.`,
      });
    }
    const preview: Record<string, unknown> = {
      slug: target.slug,
      displayName: target.display_name,
    };
    return queueProposal(tx, ctx, "delete", target.id, input, preview, "themes.propose_delete");
  },
});

// ────────────────────────────────────────────────────────────────────
// execute / reject / list_pending
// ────────────────────────────────────────────────────────────────────

export const executeThemeProposalOp = defineOperation({
  name: "themes.execute_proposal",
  // Human-only by design — this is the "Go button" half of §11.A.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({ themeId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, theme_id::text AS theme_id, payload, status
      FROM theme_pending_actions
      WHERE id = ${input.proposalId}::uuid
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      kind: "create" | "activate" | "delete";
      theme_id: string | null;
      payload: unknown;
      status: string;
    }>;
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "themes.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "themes.execute_proposal",
        message: `proposal is already ${row.status}`,
      });
    }
    const payload = (
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
    ) as Record<string, unknown>;

    let resultThemeId: string | null = row.theme_id;

    if (row.kind === "create") {
      const slug = String(payload.slug);
      const displayName = String(payload.displayName);
      const description = (payload.description as string | undefined) ?? null;
      const presetName = String(payload.preset) as PresetName;
      const overrides = (payload.overrides as Record<string, unknown> | undefined) ?? {};

      let tokens = getPreset(presetName);
      // v0.11.1 (issue #76) — same primaryColor-then-rest split as
      // propose-time, applied to the actual write. If the operator
      // also supplied explicit `color.primary.<stop>` paths in
      // overrides, mergeRampIntoTokens layers them over the derived
      // ramp (explicit-wins).
      const { primaryColor: rampSeed, rest: nonRampOverrides } = extractPrimaryColorSeed(overrides);
      if (rampSeed !== undefined) {
        const ramp = deriveOklchPrimaryRamp(rampSeed);
        // Convert nonRamp overrides to canonical paths so any
        // `color.primary.<stop>` keys are recognized in mergeRampIntoTokens.
        const normalizedForRamp = normalizeTokens(nonRampOverrides);
        tokens = mergeRampIntoTokens(tokens, ramp, normalizedForRamp.set);
        // After merging the ramp, run the remaining (non-color.primary.*)
        // writes through applyDtcgWrites so e.g. typography / spacing
        // overrides land too. Filter out the color.primary.* paths
        // already applied by mergeRampIntoTokens.
        const nonPrimarySet: Record<string, unknown> = {};
        const nonPrimaryTypes: Record<string, string> = {};
        for (const [path, value] of Object.entries(normalizedForRamp.set)) {
          if (!path.startsWith("color.primary.")) {
            nonPrimarySet[path] = value;
            nonPrimaryTypes[path] = normalizedForRamp.types[path] ?? "color";
          }
        }
        if (Object.keys(nonPrimarySet).length > 0) {
          tokens = applyDtcgWrites(tokens, nonPrimarySet, nonPrimaryTypes);
        }
      } else if (Object.keys(overrides).length > 0) {
        // Re-normalize at execute time so the value-shape errors from
        // propose time stay consistent and so we don't trust the
        // payload jsonb that was persisted between propose and execute.
        const normalized = normalizeTokens(overrides);
        tokens = applyDtcgWrites(tokens, normalized.set, normalized.types);
      }

      const ins = (await tx.execute(sql`
        INSERT INTO themes (slug, display_name, description, is_active, tokens, updated_by)
        VALUES (
          ${slug},
          ${displayName},
          ${description},
          false,
          ${JSON.stringify(tokens)}::text::jsonb,
          ${ctx.actorId}::uuid
        )
        RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      const newId = ins[0]?.id;
      if (!newId) {
        return err({
          kind: "HandlerError",
          operation: "themes.execute_proposal",
          message: "create returned no id",
        });
      }
      resultThemeId = newId;
    } else if (row.kind === "activate") {
      if (!row.theme_id) {
        return err({
          kind: "HandlerError",
          operation: "themes.execute_proposal",
          message: "activate proposal has no theme_id",
        });
      }
      // Capture the previously-active theme's id (if any) BEFORE the
      // flip so we can emit a snapshot row for it with its new
      // is_active=false state — without this the activation is
      // unrecoverable via site-history (step-11 opt §2).
      const previouslyActive = await fetchThemeOrNull(tx, { active: true });
      // Atomic flip in one tx — partial-unique themes_one_active
      // index enforces "only one active row".
      await tx.execute(sql`UPDATE themes SET is_active = false WHERE is_active = true`);
      await tx.execute(sql`
        UPDATE themes
        SET is_active = true, updated_at = now(), updated_by = ${ctx.actorId}::uuid
        WHERE id = ${row.theme_id}::uuid
      `);
      // Emit snapshots for BOTH themes carrying their new is_active
      // state so an Owner can revert a misclicked activation via
      // revert_site / chat-revert.
      const newlyActive = await fetchThemeOrNull(tx, { id: row.theme_id });
      if (previouslyActive && previouslyActive.id !== row.theme_id) {
        await emitThemeWrite(tx, {
          actorId: ctx.actorId,
          chatBranchId: ctx.chatBranchId,
          chatTaskId: ctx.chatTaskId ?? null,
          opKind: "themes.activate",
          description: `themes.activate deactivated ${previouslyActive.slug}`,
          theme: { ...previouslyActive, isActive: false },
        });
      }
      if (newlyActive) {
        await emitThemeWrite(tx, {
          actorId: ctx.actorId,
          chatBranchId: ctx.chatBranchId,
          chatTaskId: ctx.chatTaskId ?? null,
          opKind: "themes.activate",
          description: `themes.activate activated ${newlyActive.slug}`,
          theme: newlyActive,
        });
      }
    } else if (row.kind === "delete") {
      if (!row.theme_id) {
        return err({
          kind: "HandlerError",
          operation: "themes.execute_proposal",
          message: "delete proposal has no theme_id",
        });
      }
      // Defence-in-depth: refuse if the row turned active between
      // propose and execute (operator changed their mind via UI).
      const active = (await tx.execute(sql`
        SELECT is_active FROM themes WHERE id = ${row.theme_id}::uuid LIMIT 1
      `)) as unknown as Array<{ is_active: boolean }>;
      if (active[0]?.is_active) {
        return err({
          kind: "HandlerError",
          operation: "themes.execute_proposal",
          message: "cannot delete active theme — activate another first via propose_activate_theme",
        });
      }
      await tx.execute(sql`DELETE FROM themes WHERE id = ${row.theme_id}::uuid`);
      resultThemeId = null;
    }

    await tx.execute(sql`
      UPDATE theme_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          applied_theme_id = ${resultThemeId === null ? null : sql`${resultThemeId}::uuid`}
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "themes.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `${row.kind} applied (themeId=${resultThemeId ?? "(deleted)"})`,
    });
    return ok({ themeId: resultThemeId });
  },
});

export const rejectThemeProposalOp = defineOperation({
  name: "themes.reject_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE theme_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "themes.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});

const proposalRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["create", "activate", "delete"]),
  proposedBy: z.string(),
  themeId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "applied", "rejected", "superseded", "cancelled"]),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const listPendingThemeProposalsOp = defineOperation({
  name: "themes.list_pending",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  output: z.object({ proposals: z.array(proposalRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const limit = input.limit ?? 50;
    const rows = (await tx.execute(sql`
      SELECT
        id::text                  AS id,
        kind,
        proposed_by::text         AS proposed_by,
        theme_id::text            AS theme_id,
        payload,
        preview,
        status,
        created_at,
        decided_at,
        decided_by::text          AS decided_by,
        decision_reason
      FROM theme_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      kind: "create" | "activate" | "delete";
      proposed_by: string;
      theme_id: string | null;
      payload: unknown;
      preview: unknown;
      status: "pending" | "applied" | "rejected" | "superseded" | "cancelled";
      created_at: string | Date;
      decided_at: string | Date | null;
      decided_by: string | null;
      decision_reason: string | null;
    }>;
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        proposedBy: r.proposed_by,
        themeId: r.theme_id,
        payload: r.payload as Record<string, unknown>,
        preview: r.preview as Record<string, unknown>,
        status: r.status,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        decidedAt: r.decided_at
          ? r.decided_at instanceof Date
            ? r.decided_at.toISOString()
            : String(r.decided_at)
          : null,
        decidedBy: r.decided_by,
        decisionReason: r.decision_reason,
      })),
    });
  },
});

// ────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────

async function queueProposal(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  ctx: { actorId: string; requestId: string; chatBranchId?: string },
  kind: "create" | "activate" | "delete",
  themeId: string | null,
  payload: unknown,
  preview: unknown,
  opName: string,
): Promise<
  | { ok: true; value: { proposalId: string; preview: Record<string, unknown> } }
  | { ok: false; error: { kind: "HandlerError"; operation: string; message: string } }
> {
  const payloadHash = await hashProposalPayload(payload);
  const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
  let rows: { id: string }[];
  try {
    rows = (await tx.execute(sql`
      INSERT INTO theme_pending_actions
        (kind, proposed_by, theme_id, payload, preview, status, chat_session_id, payload_hash)
      VALUES (
        ${kind},
        ${ctx.actorId}::uuid,
        ${themeId === null ? null : sql`${themeId}::uuid`},
        ${JSON.stringify(payload)}::jsonb,
        ${JSON.stringify(preview)}::jsonb,
        'pending',
        ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
        ${payloadHash}
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
  } catch (e) {
    if (isDuplicatePendingError(e)) {
      return err({ kind: "HandlerError", operation: opName, message: DUPLICATE_PROPOSAL_MESSAGE });
    }
    throw e;
  }
  const proposalId = rows[0]?.id;
  if (!proposalId) {
    return err({ kind: "HandlerError", operation: opName, message: "insert returned no id" });
  }
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: opName,
    input: payload,
    succeeded: true,
    entityId: proposalId,
    resultSummary: `kind=${kind}`,
  });
  return ok({ proposalId, preview: preview as Record<string, unknown> });
}
