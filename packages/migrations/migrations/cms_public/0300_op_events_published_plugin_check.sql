-- SPDX-License-Identifier: MPL-2.0
--
-- 0300 — the gateway may record a plugin op event only for a plugin the
-- admin published as active, under that plugin's own slug (issue #856,
-- follow-up of #844; CLAUDE.md §2: per-plugin scoping lives in RLS).
--
-- Until now `gateway_plugin_op_events_gateway` was `WITH CHECK (true)`: the
-- CHECKs on the table are format-only, so a compromised public side could
-- insert well-formed events for a plugin that is not installed, not active,
-- or not the plugin that ran the op. The honest writer
-- (plugin-host `emitPublicPluginOpEvent`) only ever writes
-- `<plugin.slug>.<operation>` with the id and slug of a plugin it loaded
-- from `published_plugins`, so it is unaffected.
--
-- What "active" means: `published_plugins` IS the active-plugin registry.
-- The admin's publisher (packages/migrations/src/public-projection.ts)
-- republishes it whole, in one transaction, from
-- `plugins WHERE status = 'active'`; a plugin that is disabled, failed or
-- awaiting activation has no row. So "an active published plugin" is
-- "a row of published_plugins", and the check needs no status column.
--
-- Why a policy with an EXISTS subquery, not a trigger: public_role already
-- holds SELECT on `published_plugins` under the FORCEd RLS policy
-- `published_plugins_gateway_read` (USING (true), migration 0280), so the
-- subquery runs with the writer's own privileges and RLS stays in force.
-- No SECURITY DEFINER function, no new grant, nothing on cms_admin: the
-- check reads only the one-way projection that already lives in
-- cms_public (two-database split, CLAUDE.md §2). A trigger would need
-- either the same SELECT (so it adds nothing) or SECURITY DEFINER (which
-- would bypass RLS).
--
-- The slug is `split_part(operation, '.', 1)`: the table's CHECK already
-- pins `operation` to exactly one `.` with a slug-shaped prefix, so the
-- prefix is the whole slug and `ratings-x.submit` does not match `ratings`.
--
-- Not added: a per-plugin op allowlist. The projection carries a plugin's
-- operations only in Tier 2's `manifest_json`; Tier 1 plugins (every shipped
-- one) publish no manifest, and their `publicOperations` live in code. A
-- check that covers Tier 2 alone would be a half rule, and the dispatcher's
-- default-deny `publicOperations` gate plus the redeploy orchestrator's own
-- op-kind allowlist (#844) already bound which ops matter downstream.
--
-- The orchestrator keeps validating every row it reads (#844): this is
-- defense in depth, not a reason to trust the table.

DROP POLICY IF EXISTS gateway_plugin_op_events_gateway ON gateway_plugin_op_events;
CREATE POLICY gateway_plugin_op_events_gateway ON gateway_plugin_op_events
  FOR INSERT TO public_role
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM published_plugins p
      WHERE p.id = gateway_plugin_op_events.plugin_id
        AND p.slug = split_part(gateway_plugin_op_events.operation, '.', 1)
    )
  );
