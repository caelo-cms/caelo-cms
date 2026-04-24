// SPDX-License-Identifier: MPL-2.0

/**
 * Fixed permission catalog. Mirrors the seed in
 * packages/migrations/migrations/cms_admin/0002_p2_rls_and_seed.sql — when
 * adding a permission, land a row in that migration *and* a new member here.
 *
 * Routes check permissions by string (`has(user, 'deploy.trigger')`), never
 * by role name, so custom roles integrate uniformly.
 */

export const PERMISSIONS = [
  "content.read",
  "content.write",
  "translations.write",
  "deploy.trigger",
  "ops.view",
  "plugins.approve",
  "users.manage",
  "roles.manage",
  "settings.read",
  "settings.write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const BUILTIN_ROLE_NAMES = ["owner", "editor", "reviewer"] as const;
export type BuiltinRoleName = (typeof BUILTIN_ROLE_NAMES)[number];

export function hasPermission(grants: ReadonlySet<string>, required: Permission): boolean {
  return grants.has(required);
}

export function hasAllPermissions(
  grants: ReadonlySet<string>,
  required: readonly Permission[],
): boolean {
  for (const p of required) {
    if (!grants.has(p)) return false;
  }
  return true;
}

export function hasAnyPermission(
  grants: ReadonlySet<string>,
  required: readonly Permission[],
): boolean {
  for (const p of required) {
    if (grants.has(p)) return true;
  }
  return false;
}
