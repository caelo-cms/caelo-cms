// SPDX-License-Identifier: MPL-2.0
/**
 * Migration state for the deep health check (epic #696): which migration
 * files this admin image ships, and whether the database has them all.
 *
 * The admin image carries the migration files at
 * `<workspace>/packages/migrations/migrations/{cms_admin,cms_public}` (the
 * migration job runs them from the same image), so the "expected head" is
 * whatever this image ships — no version table to keep in sync.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
/**
 * The directory holding the shipped migration files, found by walking up
 * from the working directory (`/app` in the image, `apps/admin` in dev).
 * Throws when it is not there — the image is then broken, not healthy.
 */
export function shippedMigrationsRoot(cwd = process.cwd()) {
    let dir = cwd;
    for (let i = 0; i < 6; i++) {
        const candidate = resolvePath(dir, "packages", "migrations", "migrations");
        if (existsSync(candidate))
            return candidate;
        const parent = resolvePath(dir, "..");
        if (parent === dir)
            break;
        dir = parent;
    }
    throw new Error(`no packages/migrations/migrations above ${cwd}`);
}
/** The migration files shipped for `database`, sorted like the runner applies them. */
export function shippedMigrations(root, database) {
    return readdirSync(resolvePath(root, database))
        .filter((f) => f.endsWith(".sql"))
        .sort();
}
/** `9999_rls_policies.sql` is applied once and sorts last; it says nothing about the head. */
const CATCH_ALL = /^9999_/;
/** Compare shipped files with the ones the database recorded. */
export function migrationState(shipped, applied) {
    const recorded = new Set(applied);
    const pending = shipped.filter((f) => !recorded.has(f)).length;
    const head = shipped.filter((f) => recorded.has(f) && !CATCH_ALL.test(f)).at(-1) ?? null;
    return { head, pending };
}
