// SPDX-License-Identifier: MPL-2.0

/**
 * Test seeds that insert a template by raw SQL bypass `templates.create`,
 * which puts every template into a page type (epic #1107). A page needs a
 * page type that allows its template (migration 0351's INSERT trigger
 * derives it), so such a seed hands its template to the site's default
 * page type here — the same placement `templates.create` without
 * `pageType` makes.
 */

/** The transaction surface the seeds use (Bun SQL). */
interface UnsafeRunner {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

/** Add `templateId` to the site default page type's templates (idempotent). */
export async function adoptTemplateIntoDefaultPageType(
  tx: UnsafeRunner,
  templateId: string,
): Promise<void> {
  await tx.unsafe(
    `UPDATE page_types
        SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb($1::text))
      WHERE id = (SELECT default_page_type_id FROM site_defaults WHERE id = 1)
        AND NOT (definition->'templates' ? $1::text)`,
    [templateId],
  );
}
