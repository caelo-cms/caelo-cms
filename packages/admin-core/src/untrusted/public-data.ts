// SPDX-License-Identifier: MPL-2.0

/**
 * The public → admin boundary (issue #635, CLAUDE.md §2 "public → admin
 * data is untrusted"; docs/dev/public-admin-boundary.md).
 *
 * Everything the admin reads from cms_public was written — or could have
 * been rewritten — by the public side: the gateway, a visitor, or an
 * attacker who owns either. So every such read goes through
 * {@link parseUntrustedRows}: each row is checked against a strict, bounded
 * Zod schema at the moment it crosses, and a row that does not fit is
 * DROPPED (and counted), never coerced. Rendering then treats the values as
 * text, and an AI tool result carrying them is wrapped as untrusted data
 * (`untrustedToolResult`).
 */

import { z } from "zod";

/** A plugin slug as the gateway may legitimately log it. */
export const untrustedSlug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

/** An operation name as the gateway may legitimately log it. */
export const untrustedOperation = z.string().regex(/^[a-z_][a-z0-9_]{0,119}$/);

/** An error kind as the gateway may legitimately log it. */
export const untrustedErrorKind = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/);

/** A timestamp column (Bun returns Date; JSON paths return strings). */
export const untrustedTimestamp = z.union([z.date(), z.string().max(64)]).transform((v, ctx) => {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: "custom", message: "not a timestamp" });
    return z.NEVER;
  }
  return d.toISOString();
});

/** The rows that fit `schema`, and how many did not. */
export interface UntrustedRows<T> {
  readonly rows: T[];
  readonly dropped: number;
}

/**
 * Validate rows read from cms_public. A row that fails is dropped and
 * counted (and logged once per call with the boundary's name, never the
 * row's content — the content is what may be hostile).
 *
 * @param boundary names the read in the log, e.g. `gateway.list_recent_requests`.
 */
export function parseUntrustedRows<S extends z.ZodType>(
  boundary: string,
  schema: S,
  raw: readonly unknown[],
): UntrustedRows<z.infer<S>> {
  const rows: z.infer<S>[] = [];
  let dropped = 0;
  for (const r of raw) {
    const parsed = schema.safeParse(r);
    if (parsed.success) rows.push(parsed.data);
    else dropped += 1;
  }
  if (dropped > 0) {
    console.warn(
      `[public-boundary] ${boundary}: dropped ${dropped} cms_public row(s) that failed validation`,
    );
  }
  return { rows, dropped };
}
