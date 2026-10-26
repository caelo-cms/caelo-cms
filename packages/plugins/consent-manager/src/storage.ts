// SPDX-License-Identifier: MPL-2.0

/**
 * The plugin's handles and its own rows, shared by every operation.
 *
 * The read helpers never seed: render and visitor calls cannot write
 * private storage, so the create-time defaults come from `onActivate`
 * and a missing row is reported as the activation that did not run
 * (CMS_REQUIREMENTS §14.7).
 */

import type { PluginAdminQuery } from "@caelo-cms/plugin-sdk";
import type { CategoryRow } from "./categories.js";

export interface SettingsRow {
  id: string;
  policy_version: number;
  retention_days: number;
  /** Module rendered in place of anything withheld. */
  placeholder_module_slug: string;
  /** Last change to anything the cookie declaration shows (tags, policy). */
  declaration_updated_at: string | Date;
}

export interface GuardRow {
  id: string;
  module_id: string;
  category_key: string;
  detected_hosts: string[];
  status: "pending" | "gated" | "allowed";
  decided_by: string;
}

export interface CmsHandle {
  call: <O>(opName: string, input: unknown) => Promise<O>;
}

/** The core Query API handle (`cms_admin` grant). */
export function cmsOf(ctx: unknown): CmsHandle {
  const cms = (ctx as { cms?: CmsHandle }).cms;
  if (!cms) {
    throw new Error("consent-manager: ctx.cms missing — the cms_admin capability was not granted");
  }
  return cms;
}

/** The plugin's own cms_admin schema (`cms_admin_schema` grant). */
export function adminQueryOf(ctx: unknown): PluginAdminQuery {
  const q = (ctx as { adminQuery?: PluginAdminQuery }).adminQuery;
  if (!q) {
    throw new Error(
      "consent-manager: ctx.adminQuery missing — the cms_admin_schema capability was not granted",
    );
  }
  return q;
}

/** The settings row. Seeded by `onActivate`; missing means activation did not run. */
export async function settingsOf(q: PluginAdminQuery): Promise<SettingsRow> {
  const rows = (await q.list("settings", { limit: 1 })) as unknown as SettingsRow[];
  const row = rows[0];
  if (!row) {
    throw new Error("consent-manager: settings row missing — onActivate has not seeded it");
  }
  return row;
}

/** Categories in display order. Seeded by `onActivate`. */
export async function categoriesOf(q: PluginAdminQuery): Promise<CategoryRow[]> {
  const rows = (await q.list("categories", {
    limit: 100,
    orderBy: "position",
    orderDir: "asc",
  })) as unknown as CategoryRow[];
  if (rows.length === 0) {
    throw new Error("consent-manager: no categories — onActivate has not seeded them");
  }
  return rows;
}

/**
 * Re-ask every visitor: the next policy version. Also stamps the
 * declaration, because what changed is what the visitor is asked about.
 */
export async function bumpPolicyVersion(q: PluginAdminQuery): Promise<number> {
  const settings = await settingsOf(q);
  const next = settings.policy_version + 1;
  await q.update("settings", settings.id, {
    policy_version: next,
    declaration_updated_at: new Date().toISOString(),
  });
  return next;
}

/** Record that the cookie declaration changed without re-asking anyone (a tag removed). */
export async function touchDeclaration(q: PluginAdminQuery): Promise<void> {
  const settings = await settingsOf(q);
  await q.update("settings", settings.id, { declaration_updated_at: new Date().toISOString() });
}

/** An instant as `YYYY-MM-DD`, for dates visitors read. */
export function isoDate(at: string | Date): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) {
    throw new Error(`consent-manager: unreadable date ${String(at)}`);
  }
  return d.toISOString().slice(0, 10);
}
