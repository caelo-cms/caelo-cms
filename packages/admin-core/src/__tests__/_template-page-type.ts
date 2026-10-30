// SPDX-License-Identifier: MPL-2.0

/**
 * Test seeds that insert a template by raw SQL bypass `templates.create`,
 * which puts every template into a page type (epic #1107). A page needs a
 * page type that allows its template (migration 0351's INSERT trigger
 * derives it), so such a seed hands its template to the `home` page type
 * here — the type 0351 made for the migration-seeded `home-template`
 * (#1276: there is no stored default type to fall into).
 */

/** The transaction surface the seeds use (Bun SQL). */
interface UnsafeRunner {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

/** Add `templateId` to the `home` page type's templates (idempotent). */
export async function adoptTemplateIntoHomePageType(
  tx: UnsafeRunner,
  templateId: string,
): Promise<void> {
  await tx.unsafe(
    `UPDATE page_types
        SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb($1::text))
      WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL
        AND NOT (definition->'templates' ? $1::text)`,
    [templateId],
  );
}
