-- SPDX-License-Identifier: MPL-2.0
--
-- P4 follow-up: snapshot → entity FKs cascade on delete.
--
-- Production never hard-deletes content entities (P3 uses soft-delete via
-- deleted_at; the FK stays valid forever). The cascade exists for the test
-- path: integration test fixtures hard-delete their seed rows in afterAll
-- to keep the dev DB clean between runs, and the snapshot rows must follow
-- those deletions automatically.
--
-- Site_snapshots → entity-table cascade is already correct (the inverse
-- direction: dropping a site_snapshot drops its child rows).

ALTER TABLE module_snapshots
  DROP CONSTRAINT module_snapshots_module_id_fkey,
  ADD CONSTRAINT module_snapshots_module_id_fkey
    FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE;

ALTER TABLE template_snapshots
  DROP CONSTRAINT template_snapshots_template_id_fkey,
  ADD CONSTRAINT template_snapshots_template_id_fkey
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE;

ALTER TABLE page_snapshots
  DROP CONSTRAINT page_snapshots_page_id_fkey,
  ADD CONSTRAINT page_snapshots_page_id_fkey
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;

ALTER TABLE page_layout_snapshots
  DROP CONSTRAINT page_layout_snapshots_page_id_fkey,
  ADD CONSTRAINT page_layout_snapshots_page_id_fkey
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
