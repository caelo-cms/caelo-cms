-- SPDX-License-Identifier: MPL-2.0
--
-- 0350 — epic #1107 (lists, list types, page types), part B: the tables.
-- Contract and shapes: docs/lists.md.
--
--   list_types   the shape of a list (nodes, fields, children, sources).
--                `definition` is the whole ListTypeDef (shared
--                `lists/list-type.ts`), slug included.
--   lists        a shared list: an entry tree (`items`, shared
--                `lists/items.ts`) of one list type.
--   page_types   what a page IS (News, Product, Doc): properties,
--                vocabularies, allowed templates. `definition` is the
--                whole PageTypeDef (shared `lists/page-type.ts`).
--   page_terms   the live terms of a page (vocabulary entries). No FK to
--                the entry: entries live inside `lists.items` (jsonb), so
--                reference integrity is a check, not a constraint
--                (docs/lists.md §11).
--
-- All three entities follow the content_instances pattern exactly (0093):
-- a chat that CREATES one inserts the row tagged with `chat_branch_id`
-- (invisible to main until a merge clears the tag); every later change in
-- a chat lands only in the entity's snapshot table, and the live row
-- changes at Stage. `version` is the optimistic-write token, soft delete
-- keeps history revertable. Slugs are unique per branch namespace among
-- live rows, like content_instances / templates.
--
-- `content.structure` — writing list types and page types (the structure,
-- not the content) — is granted to every role that holds content.write
-- (docs/lists.md §11).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE list_types (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  -- ListTypeDef; its `slug` always equals the column (the ops write both).
  definition     jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  version        bigint NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES actors(id),
  deleted_at     timestamptz,
  chat_branch_id uuid
);
CREATE UNIQUE INDEX list_types_slug_branch_uidx
  ON list_types (slug, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;
CREATE INDEX list_types_chat_branch_idx ON list_types (chat_branch_id)
  WHERE chat_branch_id IS NOT NULL;

CREATE TABLE lists (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  name           text NOT NULL,
  -- Why this list exists (CLAUDE.md §1A): what it is for, where it shows.
  purpose        text NOT NULL,
  list_type_id   uuid NOT NULL REFERENCES list_types(id),
  items          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'),
  version        bigint NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES actors(id),
  deleted_at     timestamptz,
  chat_branch_id uuid
);
CREATE UNIQUE INDEX lists_slug_branch_uidx
  ON lists (slug, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;
CREATE INDEX lists_list_type_idx ON lists (list_type_id) WHERE deleted_at IS NULL;
CREATE INDEX lists_chat_branch_idx ON lists (chat_branch_id) WHERE chat_branch_id IS NOT NULL;

CREATE TABLE page_types (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  -- PageTypeDef; its `slug` always equals the column.
  definition     jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  version        bigint NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES actors(id),
  deleted_at     timestamptz,
  chat_branch_id uuid
);
CREATE UNIQUE INDEX page_types_slug_branch_uidx
  ON page_types (slug, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;
CREATE INDEX page_types_chat_branch_idx ON page_types (chat_branch_id)
  WHERE chat_branch_id IS NOT NULL;

-- Snapshot tables — state = ListTypeState / ListState / PageTypeState
-- (packages/admin-core/src/snapshots/state.ts).
CREATE TABLE list_type_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  list_type_id      uuid NOT NULL REFERENCES list_types(id) ON DELETE CASCADE,
  state             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX list_type_snapshots_entity_idx ON list_type_snapshots (list_type_id, site_snapshot_id);
CREATE INDEX list_type_snapshots_site_idx ON list_type_snapshots (site_snapshot_id);

CREATE TABLE list_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  list_id           uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  state             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX list_snapshots_entity_idx ON list_snapshots (list_id, site_snapshot_id);
CREATE INDEX list_snapshots_site_idx ON list_snapshots (site_snapshot_id);

CREATE TABLE page_type_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  page_type_id      uuid NOT NULL REFERENCES page_types(id) ON DELETE CASCADE,
  state             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX page_type_snapshots_entity_idx ON page_type_snapshots (page_type_id, site_snapshot_id);
CREATE INDEX page_type_snapshots_site_idx ON page_type_snapshots (site_snapshot_id);

-- Live terms of a page. Branch state lives in the page snapshot
-- (PageState.terms) and is materialised here at merge.
CREATE TABLE page_terms (
  page_id    uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  list_id    uuid NOT NULL,
  item_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, list_id, item_id)
);
CREATE INDEX page_terms_term_idx ON page_terms (list_id, item_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'list_types', 'lists', 'page_types',
    'list_type_snapshots', 'list_snapshots', 'page_type_snapshots', 'page_terms'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_authenticated_scope', t);
    -- Same scope as content_instances: any authenticated actor session;
    -- who may write what is decided at the op.
    EXECUTE format(
      'CREATE POLICY %I ON %I '
      'USING (NULLIF(current_setting(''caelo.actor_kind'', true), '''') IS NOT NULL) '
      'WITH CHECK (NULLIF(current_setting(''caelo.actor_kind'', true), '''') IS NOT NULL)',
      t || '_authenticated_scope', t);
  END LOOP;
END $$;

INSERT INTO permissions (name, description) VALUES
  ('content.structure',
   'Define list types and page types: the shape of menus, categories, tags and page properties')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, s.id
FROM role_permissions rp
JOIN permissions w ON w.id = rp.permission_id AND w.name = 'content.write'
CROSS JOIN permissions s
WHERE s.name = 'content.structure'
ON CONFLICT DO NOTHING;

COMMIT;
