// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — Themes primitive Query API ops (#45, Phase 2 routine).
 *
 * Routine (non-gated) surface: list / get / get_active / update_tokens
 * / set_asset / duplicate / import_dtcg / export_dtcg. The hard-to-
 * revert ops (create / activate / delete) flow through the §11.A
 * propose/execute gate in `themes_pending.ts`.
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
  buildMediaUrl,
  err,
  exportDtcg,
  importDtcg,
  normalizeTokens,
  ok,
  type Theme,
  type ThemeDocument,
  UnknownTokenName,
  validateThemeTokens,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { checkAndAcquireEntityLock, lockedError } from "../locks.js";

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
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters/digits/hyphens, must start with letter or digit");

// ────────────────────────────────────────────────────────────────────
// Row → Theme aggregate
// ────────────────────────────────────────────────────────────────────

interface ThemeDbRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
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
    typeof r.tokens === "string" ? (JSON.parse(r.tokens) as ThemeDocument) : (r.tokens as ThemeDocument);
  const asset = (id: string | null): { mediaId: string; url: string } | null =>
    id === null ? null : { mediaId: id, url: buildMediaUrl(id, "orig") };
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    description: r.description,
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

interface ThemeSnapshotState {
  schemaVersion: 1;
  slug: string;
  displayName: string;
  description: string | null;
  isActive: boolean;
  tokens: ThemeDocument;
  assets: {
    logo: string | null;
    logoDark: string | null;
    favicon: string | null;
    socialShare: string | null;
  };
  deletedAt: string | null;
}

async function emitThemeSnapshot(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  args: {
    actorId: string;
    chatBranchId?: string | null;
    chatTaskId?: string | null;
    siteSnapshotId: string;
    themeId: string;
    state: ThemeSnapshotState;
  },
): Promise<void> {
  const stateJson = JSON.stringify(args.state);
  await tx.execute(sql`
    INSERT INTO theme_snapshots (site_snapshot_id, theme_id, state)
    VALUES (
      ${args.siteSnapshotId}::uuid,
      ${args.themeId}::uuid,
      ${stateJson}::jsonb
    )
  `);
}

async function fetchThemeOrNull(
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

async function emitThemeWrite(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  args: {
    actorId: string;
    requestId: string;
    chatBranchId?: string | null;
    chatTaskId?: string | null;
    opKind: "themes.update_tokens" | "themes.set_asset" | "themes.duplicate" | "themes.import_dtcg";
    description: string;
    themeId: string;
    state: ThemeSnapshotState;
  },
): Promise<void> {
  // The snapshot emitter dispatches per entity-kind; themes get a
  // dedicated table not yet handled by SnapshotEntity. Emit the
  // site_snapshots header via emitSnapshot with an empty entities
  // list, then write the theme_snapshots row pointing at it.
  // v0.11.x will fold "theme" into the SnapshotEntity union once the
  // revert walker grows the matching branch; for v0.11.0 we keep the
  // surface narrow and write the snapshot row directly.
  const headerRows = (await tx.execute(sql`
    INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id, revert_of)
    VALUES (
      ${args.actorId}::uuid,
      ${args.opKind},
      ${args.description},
      ${args.chatTaskId ?? null},
      ${args.chatBranchId ?? null},
      ${null}
    )
    RETURNING id::text AS id
  `)) as unknown as { id: string }[];
  const siteSnapshotId = headerRows[0]?.id;
  if (!siteSnapshotId) throw new Error("emitThemeWrite: site_snapshots returned no row");
  await emitThemeSnapshot(tx, {
    actorId: args.actorId,
    chatBranchId: args.chatBranchId,
    chatTaskId: args.chatTaskId,
    siteSnapshotId,
    themeId: args.themeId,
    state: args.state,
  });
}

function buildSnapshotState(theme: Theme): ThemeSnapshotState {
  return {
    schemaVersion: 1,
    slug: theme.slug,
    displayName: theme.displayName,
    description: theme.description,
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
        nextTokens = applyTokenWrites(nextTokens, normalized.set, normalized.types);
        canonicalPathsWritten = normalized.canonicalPaths;
      } catch (e) {
        if (e instanceof UnknownTokenName) {
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
        const result = removeTokenAtPath(nextTokens, path);
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

    // Live write (skipped under a chat branch — the snapshot carries
    // the new state for the preview overlay).
    const branched = !!ctx.chatBranchId;
    if (!branched) {
      await tx.execute(sql`
        UPDATE themes
        SET tokens = ${JSON.stringify(nextTokens)}::text::jsonb,
            updated_at = now(),
            updated_by = ${ctx.actorId}::uuid
        WHERE id = ${target.id}::uuid
      `);
    }

    const nextTheme: Theme = { ...target, tokens: nextTokens };
    await emitThemeWrite(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      chatBranchId: ctx.chatBranchId,
      chatTaskId: ctx.chatTaskId ?? null,
      opKind: "themes.update_tokens",
      description: `themes.update_tokens ${target.slug} written=${canonicalPathsWritten.length} removed=${removed.length}${branched ? " (branched)" : ""}`,
      themeId: target.id,
      state: buildSnapshotState(nextTheme),
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

function applyTokenWrites(
  current: ThemeDocument,
  writes: Record<string, unknown>,
  types: Record<string, "color" | "dimension" | "typography" | "shadow" | "duration" | "cubicBezier">,
): ThemeDocument {
  const out: ThemeDocument = JSON.parse(JSON.stringify(current));
  for (const [path, value] of Object.entries(writes)) {
    const inferredType = types[path];
    setAtPath(out, path, {
      $value: value,
      ...(inferredType ? { $type: inferredType } : {}),
    });
  }
  return out;
}

function setAtPath(doc: Record<string, unknown>, path: string, leaf: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!k) continue;
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== "object") {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last) cur[last] = leaf;
}

function removeTokenAtPath(
  doc: ThemeDocument,
  path: string,
): { tokens: ThemeDocument; removed: boolean } {
  const out: ThemeDocument = JSON.parse(JSON.stringify(doc));
  const parts = path.split(".");
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!k) continue;
    const next = cur[k];
    if (!next || typeof next !== "object") return { tokens: doc, removed: false };
    cur = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (!last) return { tokens: doc, removed: false };
  if (!(last in cur)) return { tokens: doc, removed: false };
  delete cur[last];
  return { tokens: out, removed: true };
}

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
    await tx.execute(sql`
      UPDATE themes
      SET ${sql.raw(column)} = ${input.mediaId === null ? null : sql`${input.mediaId}::uuid`},
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
      requestId: ctx.requestId,
      chatBranchId: ctx.chatBranchId,
      chatTaskId: ctx.chatTaskId ?? null,
      opKind: "themes.set_asset",
      description: `themes.set_asset ${refreshed.slug} slot=${input.slot}`,
      themeId: refreshed.id,
      state: buildSnapshotState(refreshed),
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
    const rows = (await tx.execute(sql`
      INSERT INTO themes (
        slug, display_name, description, is_active, tokens,
        logo_media_id, logo_dark_media_id, favicon_media_id, social_share_media_id,
        updated_by
      )
      VALUES (
        ${input.newSlug},
        ${input.newDisplayName},
        ${input.description ?? null},
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
      requestId: ctx.requestId,
      chatBranchId: ctx.chatBranchId,
      chatTaskId: ctx.chatTaskId ?? null,
      opKind: "themes.duplicate",
      description: `themes.duplicate ${input.sourceSlug} → ${input.newSlug}`,
      themeId: newId,
      state: buildSnapshotState(newTheme),
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
// import_dtcg / export_dtcg
// ────────────────────────────────────────────────────────────────────

const importDtcgInput = z
  .object({
    /**
     * DTCG JSON body. v0.11.0 ships DTCG-only; format auto-detection
     * across Style Dictionary / Tailwind / shadcn / loose lands in
     * v0.11.2 per the #45 follow-up comment.
     */
    body: z.string().min(1).max(1_000_000),
    /**
     * Target theme slug. If it exists, the import REPLACES its tokens
     * (asset FKs are untouched). If it doesn't exist, the import
     * rejects — minting a new theme goes through `propose_create_theme`
     * so the §11.A gate isn't bypassed.
     */
    themeSlug: slugSchema,
  })
  .strict();

export const importThemeDtcgOp = defineOperation({
  name: "themes.import_dtcg",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: importDtcgInput,
  output: z.object({ themeId: z.string(), format: z.literal("dtcg") }),
  handler: async (ctx, input, tx) => {
    let parsed: ThemeDocument;
    try {
      parsed = importDtcg(input.body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err({
        kind: "HandlerError",
        operation: "themes.import_dtcg",
        message: `DTCG import failed: ${msg} — verify the JSON validates against the W3C Design Tokens Format spec.`,
      });
    }

    const target = await fetchThemeOrNull(tx, { slug: input.themeSlug });
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "themes.import_dtcg",
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
        return err(await lockedError(tx, "themes.import_dtcg", "theme", target.id, lock.holder));
      }
    }

    const branched = !!ctx.chatBranchId;
    if (!branched) {
      await tx.execute(sql`
        UPDATE themes
        SET tokens = ${JSON.stringify(parsed)}::text::jsonb,
            updated_at = now(),
            updated_by = ${ctx.actorId}::uuid
        WHERE id = ${target.id}::uuid
      `);
    }
    const nextTheme: Theme = { ...target, tokens: parsed };
    await emitThemeWrite(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      chatBranchId: ctx.chatBranchId,
      chatTaskId: ctx.chatTaskId ?? null,
      opKind: "themes.import_dtcg",
      description: `themes.import_dtcg ${target.slug}${branched ? " (branched)" : ""}`,
      themeId: target.id,
      state: buildSnapshotState(nextTheme),
    });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "themes.import_dtcg",
      input: { themeSlug: input.themeSlug, bytes: input.body.length },
      succeeded: true,
      entityId: target.id,
      resultSummary: `imported DTCG bytes=${input.body.length}`,
    });
    return ok({ themeId: target.id, format: "dtcg" as const });
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
