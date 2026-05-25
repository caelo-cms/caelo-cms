// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — Themes primitive Query API ops (#45, Phase 2 routine).
 *
 * Routine (non-gated) surface: list / get / get_active / update_tokens
 * / set_asset / duplicate / import / export_dtcg. The hard-to-revert
 * ops (create / activate / delete) flow through the §11.A
 * propose/execute gate in `themes_pending.ts`.
 *
 * v0.11.1 (issue #76) — `import_dtcg` renamed to `import`; the op now
 * accepts pre-parsed `tokens: ThemeDocument` and the AI tool runs the
 * five-format auto-detect chain in TS-land before calling.
 *
 * Every write op:
 *   - normalizes loose AI inputs via theme-normalize.ts (where
 *     applicable),
 *   - validates the resulting DTCG document via themes.ts's Zod,
 *   - emits a `theme_snapshots` row in the same tx as the live write
 *     (so chat revert + site history can walk back the change),
 *   - records an audit event,
 *   - acquires the per-entity chat lock when ctx.chatBranchId is set
 *     so two concurrent chats can't clobber each other live.
 *
 * Branched-preview behaviour: when ctx.chatBranchId is set, the live
 * `themes.tokens` is NOT overwritten; instead a `theme_snapshots` row
 * is emitted carrying the new state. The preview path reads
 * branch-overlay snapshots on top of live so chat-scoped edits don't
 * leak across chats. Publishing the chat merges branched state into
 * live (handled by the chat.publish path's existing snapshot replay).
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  applyDtcgWrites,
  buildMediaUrl,
  err,
  exportDtcg,
  InvalidColorValue,
  normalizeTokens,
  ok,
  removeDtcgPath,
  type Theme,
  type ThemeDocument,
  TokenCategoryMismatch,
  themeDocument,
  UnknownTokenName,
  validateThemeTokens,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { checkAndAcquireEntityLock, lockedError } from "../locks.js";
import { emitSnapshot, type SnapshotOpKind } from "../snapshots/index.js";
import type { ThemeState } from "../snapshots/state.js";

// ────────────────────────────────────────────────────────────────────
// Zod row schemas
// ────────────────────────────────────────────────────────────────────

const themeAssetRefSchema = z
  .object({
    mediaId: z.string(),
    url: z.string(),
  })
  .nullable();

const themeAssetsSchema = z.object({
  logo: themeAssetRefSchema,
  logoDark: themeAssetRefSchema,
  favicon: themeAssetRefSchema,
  socialShare: themeAssetRefSchema,
});

const themeRow = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  // v0.11.4 (issue #76 follow-up) — provenance of current state. See
  // ThemeOrigin in @caelo-cms/shared/themes.ts.
  origin: z.enum(["seed", "ai", "operator"]),
  isActive: z.boolean(),
  tokens: z.unknown(),
  assets: themeAssetsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "lowercase letters/digits/hyphens, must start with letter or digit",
  );

// ────────────────────────────────────────────────────────────────────
// Row → Theme aggregate
// ────────────────────────────────────────────────────────────────────

interface ThemeDbRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  origin: "seed" | "ai" | "operator";
  is_active: boolean;
  tokens: unknown;
  logo_media_id: string | null;
  logo_dark_media_id: string | null;
  favicon_media_id: string | null;
  social_share_media_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function dbRowToTheme(r: ThemeDbRow): Theme {
  const tokensJson: ThemeDocument =
    typeof r.tokens === "string"
      ? (JSON.parse(r.tokens) as ThemeDocument)
      : (r.tokens as ThemeDocument);
  const asset = (id: string | null): { mediaId: string; url: string } | null =>
    id === null ? null : { mediaId: id, url: buildMediaUrl(id, "orig") };
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    description: r.description,
    origin: r.origin,
    isActive: r.is_active,
    tokens: tokensJson,
    assets: {
      logo: asset(r.logo_media_id),
      logoDark: asset(r.logo_dark_media_id),
      favicon: asset(r.favicon_media_id),
      socialShare: asset(r.social_share_media_id),
    },
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

const SELECT_THEME_COLUMNS = sql`
  SELECT
    id::text                       AS id,
    slug                            AS slug,
    display_name                    AS display_name,
    description                     AS description,
    origin                          AS origin,
    is_active                       AS is_active,
    tokens                          AS tokens,
    logo_media_id::text             AS logo_media_id,
    logo_dark_media_id::text        AS logo_dark_media_id,
    favicon_media_id::text          AS favicon_media_id,
    social_share_media_id::text     AS social_share_media_id,
    created_at                      AS created_at,
    updated_at                      AS updated_at
  FROM themes
`;

// ────────────────────────────────────────────────────────────────────
// Snapshot helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Fetch one themes row by id / slug / active flag, joined with the
 * derived asset URLs. Exported so the propose/execute path in
 * themes_pending.ts can hydrate the full Theme aggregate before
 * emitting activation snapshots (step-11 opt §2).
 */
export async function fetchThemeOrNull(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  by: { id?: string; slug?: string; active?: true },
): Promise<Theme | null> {
  let rows: ThemeDbRow[];
  if (by.id) {
    rows = (await tx.execute(
      sql`${SELECT_THEME_COLUMNS} WHERE id = ${by.id}::uuid LIMIT 1`,
    )) as unknown as ThemeDbRow[];
  } else if (by.slug) {
    rows = (await tx.execute(
      sql`${SELECT_THEME_COLUMNS} WHERE slug = ${by.slug} LIMIT 1`,
    )) as unknown as ThemeDbRow[];
  } else {
    rows = (await tx.execute(
      sql`${SELECT_THEME_COLUMNS} WHERE is_active = true LIMIT 1`,
    )) as unknown as ThemeDbRow[];
  }
  const row = rows[0];
  return row ? dbRowToTheme(row) : null;
}

/**
 * Thin wrapper around the shared emitSnapshot — keeps the per-call
 * boilerplate (opKind + description + state-from-theme) compact at
 * every theme-write site without duplicating the snapshot emission
 * itself. Step-11 opt §1: themes now ride the standard emitSnapshot
 * path so revert / lock / audit improvements apply uniformly.
 *
 * Exported so the propose/execute path in themes_pending.ts (which
 * emits a snapshot on the activation flip per step-11 opt §2) can
 * reuse the same boilerplate-compaction.
 */
export async function emitThemeWrite(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  args: {
    actorId: string;
    chatBranchId?: string | null;
    chatTaskId?: string | null;
    opKind: SnapshotOpKind;
    description: string;
    theme: Theme;
  },
): Promise<void> {
  await emitSnapshot(tx, {
    actorId: args.actorId,
    opKind: args.opKind,
    description: args.description,
    chatTaskId: args.chatTaskId ?? null,
    chatBranchId: args.chatBranchId ?? null,
    entities: [
      {
        kind: "theme",
        entityId: args.theme.id,
        state: buildSnapshotState(args.theme),
      },
    ],
  });
}

function buildSnapshotState(theme: Theme): ThemeState {
  return {
    schemaVersion: 1,
    slug: theme.slug,
    displayName: theme.displayName,
    description: theme.description,
    origin: theme.origin,
    isActive: theme.isActive,
    tokens: theme.tokens,
    assets: {
      logo: theme.assets.logo?.mediaId ?? null,
      logoDark: theme.assets.logoDark?.mediaId ?? null,
      favicon: theme.assets.favicon?.mediaId ?? null,
      socialShare: theme.assets.socialShare?.mediaId ?? null,
    },
    deletedAt: null,
  };
}

// ────────────────────────────────────────────────────────────────────
// Read ops
// ────────────────────────────────────────────────────────────────────

export const listThemesOp = defineOperation({
  name: "themes.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ themes: z.array(themeRow) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(
      sql`${SELECT_THEME_COLUMNS} ORDER BY is_active DESC, slug ASC`,
    )) as unknown as ThemeDbRow[];
    return ok({ themes: rows.map(dbRowToTheme) });
  },
});

export const getThemeOp = defineOperation({
  name: "themes.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ slug: slugSchema }).strict(),
  output: z.object({ theme: themeRow.nullable() }),
  handler: async (_ctx, input, tx) => {
    const t = await fetchThemeOrNull(tx, { slug: input.slug });
    return ok({ theme: t });
  },
});

export const getActiveThemeOp = defineOperation({
  name: "themes.get_active",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ theme: themeRow.nullable() }),
  handler: async (_ctx, _input, tx) => {
    const t = await fetchThemeOrNull(tx, { active: true });
    return ok({ theme: t });
  },
});

// ────────────────────────────────────────────────────────────────────
// update_tokens (loose-name patch)
// ────────────────────────────────────────────────────────────────────

const updateTokensInput = z
  .object({
    /**
     * Optional — defaults to the currently-active theme. Passing a
     * slug targets a specific (possibly inactive) theme. The op never
     * silently switches the active theme; activation goes through
     * propose/execute.
     */
    themeSlug: slugSchema.optional(),
    /**
     * Map of loose name → value. Server normalizes via
     * theme-normalize.ts to canonical DTCG paths and writes them as
     * `{$value, $type}` leaves.
     */
    set: z.record(z.string(), z.unknown()).optional(),
    /**
     * Canonical DTCG paths to drop. No normalization — caller must
     * know the path (looked up via get_theme first if needed).
     */
    remove: z.array(z.string()).optional(),
  })
  .strict()
  .refine((v) => (v.set && Object.keys(v.set).length > 0) || (v.remove && v.remove.length > 0), {
    message: "pass at least one of `set` or `remove`",
  });

export const updateThemeTokensOp = defineOperation({
  name: "themes.update_tokens",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: updateTokensInput,
  output: z.object({
    themeId: z.string(),
    canonicalPathsWritten: z.array(z.string()),
    canonicalPathsRemoved: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
    const target = input.themeSlug
      ? await fetchThemeOrNull(tx, { slug: input.themeSlug })
      : await fetchThemeOrNull(tx, { active: true });
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "themes.update_tokens",
        message: input.themeSlug
          ? `theme '${input.themeSlug}' not found — call list_themes to see what's available`
          : "no active theme — call list_themes; an Owner must activate one via propose_activate_theme",
      });
    }

    // Lock the entity when running under a chat branch.
    if (ctx.chatBranchId) {
      const lock = await checkAndAcquireEntityLock(tx, {
        kind: "theme",
        entityId: target.id,
        chatBranchId: ctx.chatBranchId,
      });
      if (!lock.permitted && lock.holder) {
        return err(await lockedError(tx, "themes.update_tokens", "theme", target.id, lock.holder));
      }
    }

    // Normalize loose names (throws UnknownTokenName on ambiguity).
    let canonicalPathsWritten: readonly string[] = [];
    let nextTokens = target.tokens;
    if (input.set && Object.keys(input.set).length > 0) {
      try {
        const normalized = normalizeTokens(input.set);
        nextTokens = applyDtcgWrites(nextTokens, normalized.set, normalized.types);
        canonicalPathsWritten = normalized.canonicalPaths;
      } catch (e) {
        // AI-actionable error surface (#45 AC #7). Every typed error
        // already carries the next step the AI should try inside its
        // .message; surface it verbatim so the AI doesn't lose context.
        if (
          e instanceof UnknownTokenName ||
          e instanceof InvalidColorValue ||
          e instanceof TokenCategoryMismatch
        ) {
          return err({
            kind: "HandlerError",
            operation: "themes.update_tokens",
            message: e.message,
          });
        }
        throw e;
      }
    }

    // Remove tokens by canonical path.
    const removed: string[] = [];
    if (input.remove && input.remove.length > 0) {
      for (const path of input.remove) {
        const result = removeDtcgPath(nextTokens, path);
        if (result.removed) {
          nextTokens = result.tokens;
          removed.push(path);
        }
      }
    }

    // Validate the resulting document (catches removes that orphan
    // aliases, set-writes that bypass the normalizer's category check).
    try {
      nextTokens = validateThemeTokens(nextTokens);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err({
        kind: "HandlerError",
        operation: "themes.update_tokens",
        message: `theme document invalid after edit: ${msg}`,
      });
    }

    // v0.11.4 (issue #76 follow-up) — flip origin to reflect this
    // actor. 'seed' → 'ai'|'operator' on first edit; 'ai' ↔ 'operator'
    // afterwards. Plugin actors are treated as 'system'-equivalent and
    // do not flip the column (keeps an AI-flavoured theme labelled 'ai'
    // when a plugin runs maintenance).
    const nextOrigin: "seed" | "ai" | "operator" =
      ctx.actorKind === "ai" ? "ai" : ctx.actorKind === "human" ? "operator" : target.origin;

    // Live write (skipped under a chat branch — the snapshot carries
    // the new state for the preview overlay).
    const branched = !!ctx.chatBranchId;
    if (!branched) {
      await tx.execute(sql`
        UPDATE themes
        SET tokens = ${JSON.stringify(nextTokens)}::text::jsonb,
            origin = ${nextOrigin},
            updated_at = now(),
            updated_by = ${ctx.actorId}::uuid
        WHERE id = ${target.id}::uuid
      `);
    }

    const nextTheme: Theme = { ...target, tokens: nextTokens, origin: nextOrigin };
    await emitThemeWrite(tx, {
      actorId: ctx.actorId,
      chatBranchId: ctx.chatBranchId,
      chatTaskId: ctx.chatTaskId ?? null,
      opKind: "themes.update_tokens",
      description: `themes.update_tokens ${target.slug} written=${canonicalPathsWritten.length} removed=${removed.length}${branched ? " (branched)" : ""}`,
      theme: nextTheme,
    });

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "themes.update_tokens",
      input,
      succeeded: true,
      entityId: target.id,
      resultSummary: `wrote=${canonicalPathsWritten.length} removed=${removed.length}${branched ? " (branched)" : ""}`,
    });

    return ok({
      themeId: target.id,
      canonicalPathsWritten: [...canonicalPathsWritten],
      canonicalPathsRemoved: removed,
    });
  },
});

// v0.11.0 (#45, step-11 opt §5) — `applyDtcgWrites` + `removeDtcgPath`
// moved to packages/shared/src/themes.ts so themes_pending.ts's execute
// branch can share the dotted-path merge logic with this file.

// ────────────────────────────────────────────────────────────────────
// update_meta (description / displayName)
// ────────────────────────────────────────────────────────────────────

const updateMetaInput = z
  .object({
    themeSlug: slugSchema.optional(),
    /**
     * Operator- or AI-written description of the design intent
     * ("Indigo primary for a SaaS B2B feel. Open Sans body."). Carried
     * into the `## Theme` system-prompt block so future AI turns stay
     * consistent with the established intent. Nullable to clear.
     */
    description: z.string().max(1000).nullable().optional(),
    /** Human-readable name shown in the admin UI + system prompt. */
    displayName: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => v.description !== undefined || v.displayName !== undefined, {
    message: "pass at least one of `description` or `displayName`",
  });

export const updateThemeMetaOp = defineOperation({
  name: "themes.update_meta",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: updateMetaInput,
  output: z.object({ themeId: z.string() }),
  handler: async (ctx, input, tx) => {
    const target = input.themeSlug
      ? await fetchThemeOrNull(tx, { slug: input.themeSlug })
      : await fetchThemeOrNull(tx, { active: true });
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "themes.update_meta",
        message: input.themeSlug
          ? `theme '${input.themeSlug}' not found — call list_themes to see what's available`
          : "no active theme — an Owner must activate one via propose_activate_theme",
      });
    }

    if (ctx.chatBranchId) {
      const lock = await checkAndAcquireEntityLock(tx, {
        kind: "theme",
        entityId: target.id,
        chatBranchId: ctx.chatBranchId,
      });
      if (!lock.permitted && lock.holder) {
        return err(await lockedError(tx, "themes.update_meta", "theme", target.id, lock.holder));
      }
    }

    const nextDescription =
      input.description === undefined ? target.description : input.description;
    const nextDisplayName = input.displayName ?? target.displayName;
    // v0.11.4 — same actor-based origin flip as token edits.
    const nextOrigin: "seed" | "ai" | "operator" =
      ctx.actorKind === "ai" ? "ai" : ctx.actorKind === "human" ? "operator" : target.origin;

    const branched = !!ctx.chatBranchId;
    if (!branched) {
      await tx.execute(sql`
        UPDATE themes
        SET description = ${nextDescription},
            display_name = ${nextDisplayName},
            origin = ${nextOrigin},
            updated_at = now(),
            updated_by = ${ctx.actorId}::uuid
        WHERE id = ${target.id}::uuid
      `);
    }

    const nextTheme: Theme = {
      ...target,
      description: nextDescription,
      displayName: nextDisplayName,
      origin: nextOrigin,
    };
    await emitThemeWrite(tx, {
      actorId: ctx.actorId,
      chatBranchId: ctx.chatBranchId,
      chatTaskId: ctx.chatTaskId ?? null,
      opKind: "themes.update_meta",
      description: `themes.update_meta ${target.slug}${branched ? " (branched)" : ""}`,
      theme: nextTheme,
    });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "themes.update_meta",
      input,
      succeeded: true,
      entityId: target.id,
      resultSummary: `description=${input.description !== undefined} displayName=${input.displayName !== undefined}${branched ? " (branched)" : ""}`,
    });
    return ok({ themeId: target.id });
  },
});

// ────────────────────────────────────────────────────────────────────
// set_asset
// ────────────────────────────────────────────────────────────────────

const ASSET_SLOTS = ["logo", "logoDark", "favicon", "socialShare"] as const;
type AssetSlot = (typeof ASSET_SLOTS)[number];

const SLOT_COLUMN: Record<AssetSlot, string> = {
  logo: "logo_media_id",
  logoDark: "logo_dark_media_id",
  favicon: "favicon_media_id",
  socialShare: "social_share_media_id",
};

const setAssetInput = z
  .object({
    themeSlug: slugSchema.optional(),
    slot: z.enum(ASSET_SLOTS),
    mediaId: z.string().uuid().nullable(),
  })
  .strict();

export const setThemeAssetOp = defineOperation({
  name: "themes.set_asset",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: setAssetInput,
  output: z.object({ themeId: z.string(), asset: themeAssetRefSchema }),
  handler: async (ctx, input, tx) => {
    const target = input.themeSlug
      ? await fetchThemeOrNull(tx, { slug: input.themeSlug })
      : await fetchThemeOrNull(tx, { active: true });
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "themes.set_asset",
        message: "target theme not found",
      });
    }
    if (ctx.chatBranchId) {
      const lock = await checkAndAcquireEntityLock(tx, {
        kind: "theme",
        entityId: target.id,
        chatBranchId: ctx.chatBranchId,
      });
      if (!lock.permitted && lock.holder) {
        return err(await lockedError(tx, "themes.set_asset", "theme", target.id, lock.holder));
      }
    }

    // Verify the media row exists before binding (no-fallbacks: a
    // dangling FK would silently render a broken image).
    if (input.mediaId) {
      const exists = (await tx.execute(sql`
        SELECT 1 FROM media_assets WHERE id = ${input.mediaId}::uuid AND deleted_at IS NULL LIMIT 1
      `)) as unknown as Array<{ exists: number }>;
      if (exists.length === 0) {
        return err({
          kind: "HandlerError",
          operation: "themes.set_asset",
          message: `media asset ${input.mediaId} not found — upload one via /api/media/upload first`,
        });
      }
    }

    const column = SLOT_COLUMN[input.slot];
    // v0.11.4 (issue #76 follow-up) — asset binding is a deliberate
    // edit; flip origin same as token edits.
    const nextOrigin: "seed" | "ai" | "operator" =
      ctx.actorKind === "ai" ? "ai" : ctx.actorKind === "human" ? "operator" : target.origin;
    await tx.execute(sql`
      UPDATE themes
      SET ${sql.raw(column)} = ${input.mediaId === null ? null : sql`${input.mediaId}::uuid`},
          origin = ${nextOrigin},
          updated_at = now(),
          updated_by = ${ctx.actorId}::uuid
      WHERE id = ${target.id}::uuid
    `);

    const refreshed = await fetchThemeOrNull(tx, { id: target.id });
    if (!refreshed) {
      return err({
        kind: "HandlerError",
        operation: "themes.set_asset",
        message: "refresh-after-write returned no row",
      });
    }
    await emitThemeWrite(tx, {
      actorId: ctx.actorId,
      chatBranchId: ctx.chatBranchId,
      chatTaskId: ctx.chatTaskId ?? null,
      opKind: "themes.set_asset",
      description: `themes.set_asset ${refreshed.slug} slot=${input.slot}`,
      theme: refreshed,
    });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "themes.set_asset",
      input,
      succeeded: true,
      entityId: refreshed.id,
      resultSummary: `slot=${input.slot} mediaId=${input.mediaId ?? "(cleared)"}`,
    });
    return ok({ themeId: refreshed.id, asset: refreshed.assets[input.slot] });
  },
});

// ────────────────────────────────────────────────────────────────────
// duplicate
// ────────────────────────────────────────────────────────────────────

const duplicateInput = z
  .object({
    sourceSlug: slugSchema,
    newSlug: slugSchema,
    newDisplayName: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
  })
  .strict()
  .refine((v) => v.sourceSlug !== v.newSlug, {
    message: "newSlug must differ from sourceSlug",
    path: ["newSlug"],
  });

export const duplicateThemeOp = defineOperation({
  name: "themes.duplicate",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: duplicateInput,
  output: z.object({ themeId: z.string(), slug: z.string() }),
  handler: async (ctx, input, tx) => {
    const source = await fetchThemeOrNull(tx, { slug: input.sourceSlug });
    if (!source) {
      return err({
        kind: "HandlerError",
        operation: "themes.duplicate",
        message: `source theme '${input.sourceSlug}' not found`,
      });
    }
    // Slug uniqueness pre-check.
    const dup = (await tx.execute(sql`
      SELECT 1 FROM themes WHERE slug = ${input.newSlug} LIMIT 1
    `)) as unknown as Array<{ exists: number }>;
    if (dup.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "themes.duplicate",
        message: `theme slug '${input.newSlug}' already exists — pick a different slug or update the existing theme via update_theme_tokens`,
      });
    }
    // v0.11.4 (issue #76 follow-up) — origin reflects WHO duplicated.
    // Duplicate copies tokens but the row itself is a fresh creation,
    // so this isn't 'seed' — it's whichever actor wanted the variant.
    const newOrigin: "ai" | "operator" = ctx.actorKind === "ai" ? "ai" : "operator";
    const rows = (await tx.execute(sql`
      INSERT INTO themes (
        slug, display_name, description, origin, is_active, tokens,
        logo_media_id, logo_dark_media_id, favicon_media_id, social_share_media_id,
        updated_by
      )
      VALUES (
        ${input.newSlug},
        ${input.newDisplayName},
        ${input.description ?? null},
        ${newOrigin},
        false,
        ${JSON.stringify(source.tokens)}::text::jsonb,
        ${source.assets.logo?.mediaId === undefined || source.assets.logo === null ? null : sql`${source.assets.logo.mediaId}::uuid`},
        ${source.assets.logoDark === null ? null : sql`${source.assets.logoDark.mediaId}::uuid`},
        ${source.assets.favicon === null ? null : sql`${source.assets.favicon.mediaId}::uuid`},
        ${source.assets.socialShare === null ? null : sql`${source.assets.socialShare.mediaId}::uuid`},
        ${ctx.actorId}::uuid
      )
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    const newId = rows[0]?.id;
    if (!newId) {
      return err({
        kind: "HandlerError",
        operation: "themes.duplicate",
        message: "insert returned no id",
      });
    }
    const newTheme = await fetchThemeOrNull(tx, { id: newId });
    if (!newTheme) {
      return err({
        kind: "HandlerError",
        operation: "themes.duplicate",
        message: "fetch-after-insert returned no row",
      });
    }
    await emitThemeWrite(tx, {
      actorId: ctx.actorId,
      chatBranchId: ctx.chatBranchId,
      chatTaskId: ctx.chatTaskId ?? null,
      opKind: "themes.duplicate",
      description: `themes.duplicate ${input.sourceSlug} → ${input.newSlug}`,
      theme: newTheme,
    });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "themes.duplicate",
      input,
      succeeded: true,
      entityId: newId,
      resultSummary: `${input.sourceSlug} → ${input.newSlug}`,
    });
    return ok({ themeId: newId, slug: input.newSlug });
  },
});

// ────────────────────────────────────────────────────────────────────
// import / export_dtcg
// ────────────────────────────────────────────────────────────────────

const importInput = z
  .object({
    /**
     * v0.11.1 (issue #76) — pre-parsed DTCG document. Format detection
     * moved to the AI tool (`autoDetectAndImport` in
     * @caelo-cms/shared) so the op surface stays parser-free.
     *
     * Validated by the shared `themeDocument` schema at the Validator
     * boundary per CLAUDE.md §4 (Zod at every boundary) — the handler
     * trusts its input type and doesn't redo validation. Callers that
     * feed malformed tokens get a structured Zod error from the
     * Validator before the handler ever runs.
     */
    tokens: themeDocument,
    /**
     * Target theme slug. If it exists, the import REPLACES its tokens
     * (asset FKs are untouched). If it doesn't exist, the import
     * rejects — minting a new theme goes through `propose_create_theme`
     * so the §11.A gate isn't bypassed.
     */
    themeSlug: slugSchema,
  })
  .strict();

export const importThemeOp = defineOperation({
  // v0.11.1 (issue #76) — renamed from `themes.import_dtcg`. v0.11.0
  // had no external consumers; the op now accepts pre-parsed tokens
  // (caller runs autoDetectAndImport in TS-land).
  name: "themes.import",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: importInput,
  output: z.object({ themeId: z.string() }),
  handler: async (ctx, input, tx) => {
    // input.tokens is already a validated ThemeDocument — the
    // themeDocument Zod schema ran at the Validator boundary
    // (CLAUDE.md §4). No redundant try/catch + handler-side validation.
    const validated: ThemeDocument = input.tokens;

    const target = await fetchThemeOrNull(tx, { slug: input.themeSlug });
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "themes.import",
        message: `theme '${input.themeSlug}' not found — mint a new theme via propose_create_theme first, then import into it.`,
      });
    }

    if (ctx.chatBranchId) {
      const lock = await checkAndAcquireEntityLock(tx, {
        kind: "theme",
        entityId: target.id,
        chatBranchId: ctx.chatBranchId,
      });
      if (!lock.permitted && lock.holder) {
        return err(await lockedError(tx, "themes.import", "theme", target.id, lock.holder));
      }
    }

    // v0.11.4 (issue #76 follow-up) — import is a wholesale replacement;
    // flip origin same as update_tokens.
    const nextOrigin: "seed" | "ai" | "operator" =
      ctx.actorKind === "ai" ? "ai" : ctx.actorKind === "human" ? "operator" : target.origin;
    const branched = !!ctx.chatBranchId;
    if (!branched) {
      await tx.execute(sql`
        UPDATE themes
        SET tokens = ${JSON.stringify(validated)}::text::jsonb,
            origin = ${nextOrigin},
            updated_at = now(),
            updated_by = ${ctx.actorId}::uuid
        WHERE id = ${target.id}::uuid
      `);
    }
    const nextTheme: Theme = { ...target, tokens: validated, origin: nextOrigin };
    await emitThemeWrite(tx, {
      actorId: ctx.actorId,
      chatBranchId: ctx.chatBranchId,
      chatTaskId: ctx.chatTaskId ?? null,
      opKind: "themes.import",
      description: `themes.import ${target.slug}${branched ? " (branched)" : ""}`,
      theme: nextTheme,
    });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "themes.import",
      input: { themeSlug: input.themeSlug },
      succeeded: true,
      entityId: target.id,
      resultSummary: `imported tokens (categories=${Object.keys(validated).length})`,
    });
    return ok({ themeId: target.id });
  },
});

export const exportThemeDtcgOp = defineOperation({
  name: "themes.export_dtcg",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ themeSlug: slugSchema }).strict(),
  output: z.object({ body: z.string(), themeId: z.string() }),
  handler: async (_ctx, input, tx) => {
    const target = await fetchThemeOrNull(tx, { slug: input.themeSlug });
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "themes.export_dtcg",
        message: `theme '${input.themeSlug}' not found`,
      });
    }
    const body = exportDtcg({ tokens: target.tokens });
    return ok({ themeId: target.id, body });
  },
});

// ────────────────────────────────────────────────────────────────────
// list_history
// ────────────────────────────────────────────────────────────────────

/**
 * v0.11.4 (issue #76 follow-up) — surface theme_snapshots as a readable
 * changelog. The whole-blob `state` jsonb already carries displayName /
 * description / tokens / asset FKs at the time of each write; this op
 * joins to `site_snapshots` for op_kind + actor + chat-origin, returning
 * a per-write row the AI can scan to answer "how has this theme evolved?"
 * (and the operator can show in a "Theme history" panel later).
 *
 * Per CLAUDE.md §1A: every row carries decision-support context (who,
 * when, what changed at a glance) so the AI can reason without a second
 * tool call per entry.
 */
const historyEntrySchema = z.object({
  snapshotId: z.string(),
  createdAt: z.string(),
  opKind: z.string(),
  actorKind: z.enum(["human", "ai", "system", "plugin"]),
  actorName: z.string(),
  chatBranchId: z.string().nullable(),
  descriptionAtTime: z.string().nullable(),
  displayNameAtTime: z.string(),
  originAtTime: z.enum(["seed", "ai", "operator"]).nullable(),
  summary: z.string(),
});

export const listThemeHistoryOp = defineOperation({
  name: "themes.list_history",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      themeSlug: slugSchema.optional(),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  output: z.object({ entries: z.array(historyEntrySchema), themeId: z.string() }),
  handler: async (_ctx, input, tx) => {
    const target = input.themeSlug
      ? await fetchThemeOrNull(tx, { slug: input.themeSlug })
      : await fetchThemeOrNull(tx, { active: true });
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "themes.list_history",
        message: input.themeSlug
          ? `theme '${input.themeSlug}' not found`
          : "no active theme — call list_themes",
      });
    }
    const rows = (await tx.execute(sql`
      SELECT
        ts.id::text                        AS snapshot_id,
        ss.created_at                      AS created_at,
        ss.op_kind                         AS op_kind,
        ss.description                     AS site_description,
        ss.chat_branch_id::text            AS chat_branch_id,
        a.kind                             AS actor_kind,
        a.display_name                     AS actor_name,
        ts.state->>'description'           AS theme_description_at_time,
        ts.state->>'displayName'           AS theme_display_name_at_time,
        ts.state->>'origin'                AS theme_origin_at_time
      FROM theme_snapshots ts
        JOIN site_snapshots ss ON ss.id = ts.site_snapshot_id
        JOIN actors a ON a.id = ss.actor_id
      WHERE ts.theme_id = ${target.id}::uuid
      ORDER BY ss.created_at DESC
      LIMIT ${input.limit}
    `)) as unknown as Array<{
      snapshot_id: string;
      created_at: string | Date;
      op_kind: string;
      site_description: string;
      chat_branch_id: string | null;
      actor_kind: "human" | "ai" | "system" | "plugin";
      actor_name: string;
      theme_description_at_time: string | null;
      theme_display_name_at_time: string;
      theme_origin_at_time: "seed" | "ai" | "operator" | null;
    }>;
    const entries = rows.map((r) => ({
      snapshotId: r.snapshot_id,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      opKind: r.op_kind,
      actorKind: r.actor_kind,
      actorName: r.actor_name,
      chatBranchId: r.chat_branch_id,
      descriptionAtTime: r.theme_description_at_time,
      displayNameAtTime: r.theme_display_name_at_time,
      // Older snapshot rows (pre-0100) carry no origin key in state jsonb.
      originAtTime: r.theme_origin_at_time,
      summary: r.site_description,
    }));
    return ok({ entries, themeId: target.id });
  },
});
