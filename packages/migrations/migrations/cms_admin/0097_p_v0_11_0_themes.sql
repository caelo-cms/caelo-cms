-- SPDX-License-Identifier: MPL-2.0
--
-- v0.11.0 — Theme as a first-class primitive (closes #45 v0.11.0 slice).
--
-- Moves theme out of the generic `structured_sets` primitive (where it
-- lived as `kind='theme', slug='site'` since v0.10.22) into a dedicated
-- `themes` table with:
--   - DTCG-shaped jsonb `tokens` (the W3C Design Tokens Format),
--   - four asset FKs (logo / logo_dark / favicon / social_share) into
--     `media`,
--   - exactly-one-active enforcement via a partial unique index.
--
-- Why a dedicated table: a theme is a *bundle of design tokens* —
-- colors, typography composites, shadow composites, motion, plus
-- brand-asset references. The structured_sets flat-array shape couldn't
-- carry composites or multiple themes per install. See #45 for the full
-- rationale.
--
-- Also introduces:
--   - `theme_pending_actions` for the §11.A propose/execute gate on
--     create / activate / delete (hard-to-revert ops),
--   - `theme_snapshots` for chat-revert and site-history (whole-blob;
--     themes are small, no per-token op rows at this slice),
--   - extends `chat_entity_locks.entity_kind` CHECK with `'theme'`,
--   - one-shot, idempotent back-fill from any legacy
--     `structured_sets WHERE kind='theme' AND slug='site'` row into a
--     new `slug='site-default', is_active=true` row.
--
-- Legacy snapshot cleanup: once theme leaves `structuredSetKind`'s Zod
-- enum (next commit), historical `structured_set_snapshots` /
-- `structured_set_operations` rows pointing at the legacy theme row
-- would throw on read. The migration deletes them in the same tx as
-- the legacy `structured_sets` row, accepting the one-time loss of
-- pre-cutover theme revert history. The new `theme_snapshots` table
-- carries history forward from cutover.

------------------------------------------------------------------------
-- themes
------------------------------------------------------------------------
CREATE TABLE themes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- "site-default", "brand-dark", ... — single-source slug, no
  -- per-theme namespacing because there's only ever one active theme.
  slug                   text NOT NULL UNIQUE,
  display_name           text NOT NULL,
  description            text,
  -- Exactly one active theme per install. The partial unique index
  -- below makes a concurrent flip impossible without a tx around
  -- both UPDATEs.
  is_active              boolean NOT NULL DEFAULT false,
  -- DTCG-compatible bundle. Validated at the Query API layer against
  -- `packages/shared/src/themes.ts` (color, dimension, typography
  -- composite, shadow composite, duration, cubicBezier, alias).
  tokens                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Asset references. Kept out of `tokens` so they don't fight the
  -- DTCG schema for primitives. Each is optional (operator uploads).
  logo_media_id          uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  logo_dark_media_id     uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  favicon_media_id       uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  social_share_media_id  uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES actors(id)
);

-- At most one is_active row, enforced at the index layer.
CREATE UNIQUE INDEX themes_one_active ON themes (is_active) WHERE is_active;

ALTER TABLE themes ENABLE ROW LEVEL SECURITY;
ALTER TABLE themes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS themes_authenticated_scope ON themes;
CREATE POLICY themes_authenticated_scope ON themes
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

------------------------------------------------------------------------
-- theme_snapshots
------------------------------------------------------------------------
-- Whole-blob per theme write — themes are small (one jsonb document +
-- four media FKs), so we don't need per-token op rows at this slice.
-- Branched preview reads `theme_snapshots WHERE chat_branch_id = …` on
-- top of live so chat-scoped edits don't leak across chats; publish
-- merges branched state into live.
CREATE TABLE theme_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  theme_id          uuid NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  -- state shape: { schemaVersion, slug, displayName, description,
  --                isActive, tokens, assets, deletedAt }
  state             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX theme_snapshots_theme_idx
  ON theme_snapshots (theme_id, site_snapshot_id);
CREATE INDEX theme_snapshots_site_idx
  ON theme_snapshots (site_snapshot_id);

ALTER TABLE theme_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE theme_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS theme_snapshots_authenticated_scope ON theme_snapshots;
CREATE POLICY theme_snapshots_authenticated_scope ON theme_snapshots
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

------------------------------------------------------------------------
-- theme_pending_actions  (§11.A propose/execute)
------------------------------------------------------------------------
-- Hard-to-revert theme ops (create / activate / delete) flow through
-- the standard propose/execute gate. AI calls propose_*, Owner clicks
-- Approve at /security/themes/pending. Shape mirrors
-- layout_pending_actions (v0.2.20) so the cross-domain inbox and GC
-- worker slot it in with copy-paste plumbing.
CREATE TABLE theme_pending_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('create', 'activate', 'delete')),
  proposed_by       uuid NOT NULL REFERENCES actors(id),
  -- Target theme id (NULL for create — there's no row yet).
  theme_id          uuid NULL REFERENCES themes(id) ON DELETE CASCADE,
  payload           jsonb NOT NULL,
  preview           jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'cancelled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz NULL,
  decided_by        uuid NULL REFERENCES actors(id),
  decision_reason   text NULL,
  -- After apply: the resulting theme id (for create) or unchanged
  -- target (for activate/delete).
  applied_theme_id  uuid NULL REFERENCES themes(id) ON DELETE SET NULL,
  -- v0.2.35 unified shape — chat origin + payload-hash dedup.
  chat_session_id   uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  payload_hash      text NULL
);

CREATE INDEX theme_pending_actions_status_idx
  ON theme_pending_actions (status, created_at DESC);

-- Block AI from re-proposing the same payload while one is still pending.
CREATE UNIQUE INDEX theme_pending_actions_payload_hash_pending_uniq
  ON theme_pending_actions (payload_hash)
  WHERE status = 'pending' AND payload_hash IS NOT NULL;

ALTER TABLE theme_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE theme_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS theme_pending_actions_authenticated_scope ON theme_pending_actions;
CREATE POLICY theme_pending_actions_authenticated_scope ON theme_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

------------------------------------------------------------------------
-- site_snapshots.op_kind: add the 5 themes.* values
------------------------------------------------------------------------
-- emitSnapshot writes site_snapshots.op_kind from the SnapshotOpKind
-- TS union; the matching CHECK constraint must list every value or
-- the INSERT fails. Append the v0.11.0 theme write kinds.
ALTER TABLE site_snapshots
  DROP CONSTRAINT IF EXISTS site_snapshots_op_kind_check;
ALTER TABLE site_snapshots
  ADD CONSTRAINT site_snapshots_op_kind_check CHECK (op_kind IN (
    'modules.create',
    'modules.update',
    'modules.delete',
    'templates.create',
    'templates.update',
    'templates.delete',
    'template_blocks.set',
    'pages.create',
    'pages.update',
    'pages.set_modules',
    'pages.delete',
    'snapshots.revert_site',
    'snapshots.revert_module',
    'snapshots.revert_template',
    'snapshots.revert_page',
    'chat.publish',
    'chat.merge_to_main',
    'chat.stage',
    'chat.unstage',
    'layout_modules.set',
    'page_module_content.set',
    'structured_sets.set',
    'redirects.create',
    'redirects.update',
    'redirects.delete',
    'content_instances.create',
    'content_instances.set_values',
    'content_instances.delete',
    'placement.set_content',
    'placement.fork_content',
    'unknown',
    -- v0.11.0 (#45) — themes primitive.
    'themes.update_tokens',
    'themes.set_asset',
    'themes.duplicate',
    'themes.import_dtcg',
    'themes.activate'
  ));

------------------------------------------------------------------------
-- chat_entity_locks.entity_kind: add 'theme'
------------------------------------------------------------------------
-- Themes are global (one active row affects every page) so writes lock
-- the entity-id same as structured_sets / layouts / templates.
ALTER TABLE chat_entity_locks
  DROP CONSTRAINT IF EXISTS chat_entity_locks_entity_kind_check;
ALTER TABLE chat_entity_locks
  ADD CONSTRAINT chat_entity_locks_entity_kind_check
  CHECK (entity_kind IN (
    'module',
    'template',
    'pageLayout',
    'layout',
    'structuredSet',
    'redirect',
    'page',
    'siteSettings',
    'siteDefaults',
    'contentInstance',
    'theme'
  ));

------------------------------------------------------------------------
-- Back-fill from legacy structured_sets row + cleanup
------------------------------------------------------------------------
-- The legacy `theme/site` structured-set carries `items: [{token, value,
-- scope?}]`. We map each entry into the DTCG tree:
--
--   scope='color'  → tokens.color.<basename>.$value      ($type: color)
--   scope='font'   → tokens.typography.<basename>.$value  ($type: dimension)
--                    (legacy 'font' was kerning a single value, kept as
--                     a flat dimension entry — operators upgrade to
--                     typography composites via update_tokens later)
--   scope='space'  → tokens.spacing.<basename>.$value     ($type: dimension)
--   scope='radius' → tokens.radius.<basename>.$value      ($type: dimension)
--   scope='shadow' → tokens.shadow.<basename>.$value      ($type: shadow as raw string)
--   scope=null     → tokens.color.<basename> if value matches ^#  else tokens.spacing.*
--
-- `<basename>` strips the leading `color-` / `font-` / `space-` / `radius-`
-- / `shadow-` prefix the legacy keys carried, so `color-primary` becomes
-- `tokens.color.primary` (not `tokens.color.color-primary`).
--
-- Idempotent: ON CONFLICT (slug) DO NOTHING so a second run of this
-- migration leaves the existing themes row untouched.

DO $$
DECLARE
  legacy_id   uuid;
  legacy_items jsonb;
  built_tokens jsonb := '{}'::jsonb;
  item jsonb;
  raw_token text;
  raw_scope text;
  raw_value text;
  category text;
  basename text;
  inferred_type text;
BEGIN
  SELECT id, items::jsonb
    INTO legacy_id, legacy_items
    FROM structured_sets
    WHERE kind = 'theme' AND slug = 'site'
    LIMIT 1;

  IF legacy_items IS NOT NULL THEN
    FOR item IN SELECT * FROM jsonb_array_elements(legacy_items) LOOP
      raw_token := item->>'token';
      raw_scope := item->>'scope';
      raw_value := item->>'value';

      IF raw_token IS NULL OR raw_value IS NULL THEN
        CONTINUE;
      END IF;

      -- Pick category bucket from scope (or sniff from value shape).
      IF raw_scope = 'color' THEN
        category := 'color';
        inferred_type := 'color';
      ELSIF raw_scope = 'font' THEN
        category := 'typography';
        inferred_type := 'dimension';
      ELSIF raw_scope = 'space' THEN
        category := 'spacing';
        inferred_type := 'dimension';
      ELSIF raw_scope = 'radius' THEN
        category := 'radius';
        inferred_type := 'dimension';
      ELSIF raw_scope = 'shadow' THEN
        category := 'shadow';
        inferred_type := 'shadow';
      ELSE
        -- Unscoped: hex-like → color, else dimension.
        IF raw_value ~ '^#[0-9a-fA-F]{3,8}$' THEN
          category := 'color';
          inferred_type := 'color';
        ELSE
          category := 'spacing';
          inferred_type := 'dimension';
        END IF;
      END IF;

      -- Strip a leading <category>- prefix if present, so `color-primary`
      -- becomes `primary` (not `color-primary`).
      basename := raw_token;
      IF basename LIKE category || '-%' THEN
        basename := substring(basename FROM length(category) + 2);
      ELSIF category = 'typography' AND basename LIKE 'font-%' THEN
        basename := substring(basename FROM 6);
      ELSIF category = 'spacing' AND basename LIKE 'space-%' THEN
        basename := substring(basename FROM 7);
      END IF;

      built_tokens := jsonb_set(
        built_tokens,
        ARRAY[category, basename],
        jsonb_build_object('$value', raw_value, '$type', inferred_type),
        true
      );
    END LOOP;
  END IF;

  -- Always land one is_active=true row. ON CONFLICT keeps the migration
  -- idempotent + preserves any post-migration edits.
  INSERT INTO themes (slug, display_name, description, is_active, tokens)
  VALUES (
    'site-default',
    'Site default',
    'Migrated from structured_sets theme/site (or seeded empty on fresh install).',
    true,
    built_tokens
  )
  ON CONFLICT (slug) DO NOTHING;

  -- Delete the legacy row + its dependent snapshot / operation history.
  -- Without this, `structuredSetKind.parse(r.kind)` would throw on read
  -- once `theme` leaves the enum.
  IF legacy_id IS NOT NULL THEN
    DELETE FROM structured_set_operations
      WHERE structured_set_id = legacy_id;
    DELETE FROM structured_set_snapshots
      WHERE structured_set_id = legacy_id;
    DELETE FROM structured_sets
      WHERE id = legacy_id;
  END IF;
END $$;
