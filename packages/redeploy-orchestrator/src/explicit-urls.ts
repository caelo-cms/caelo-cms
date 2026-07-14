// SPDX-License-Identifier: MPL-2.0

/**
 * issue #229 — decode the `import_runs.explicit_urls` jsonb into the
 * LIST-mode URL set. Pure so the malformed-input contract is unit-testable
 * without booting the orchestrator.
 */

/**
 * Thrown when `explicit_urls` is present but not a non-empty array of
 * strings. LIST mode is an "exact Owner-approved URL set" contract —
 * silently falling back to depth/BFS could crawl a different set than the
 * Owner clicked Approve on, so a malformed value fails the run loudly
 * (CLAUDE.md §2 no-fallbacks) instead of degrading.
 */
export class ExplicitUrlsMalformedError extends Error {
  constructor(reason: string, badValue: unknown) {
    let rendered: string;
    try {
      rendered = JSON.stringify(badValue) ?? String(badValue);
    } catch {
      rendered = String(badValue);
    }
    super(
      `import_runs.explicit_urls is malformed (${reason}): got ${rendered.slice(0, 200)}. ` +
        `LIST mode requires the exact Owner-approved URL set — refusing to fall back to depth/BFS. ` +
        `Fix or clear explicit_urls (SQL NULL = depth mode) and re-approve the run.`,
    );
    this.name = "ExplicitUrlsMalformedError";
  }
}

/**
 * Decode `explicit_urls` (jsonb — may arrive as a decoded value or a JSON
 * string depending on the client) into the LIST-mode URL set.
 *
 * @returns `null` ONLY when the column is absent (SQL NULL / undefined /
 *   jsonb null), meaning depth/BFS mode. Any present-but-wrong shape —
 *   unparseable JSON, non-array, empty array, non-string entries — throws
 *   {@link ExplicitUrlsMalformedError} so the run fails loudly.
 */
export function parseExplicitUrls(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      throw new ExplicitUrlsMalformedError("unparseable JSON string", raw);
    }
    // A jsonb `null` serialised by the client — same as SQL NULL.
    if (v === null) return null;
  }
  if (!Array.isArray(v)) {
    throw new ExplicitUrlsMalformedError("expected a JSON array of strings", v);
  }
  if (v.length === 0) {
    throw new ExplicitUrlsMalformedError("array is empty — no URLs to fetch", v);
  }
  const nonStringIdx = v.findIndex((u) => typeof u !== "string");
  if (nonStringIdx !== -1) {
    throw new ExplicitUrlsMalformedError(
      `array entry at index ${nonStringIdx} is not a string`,
      v[nonStringIdx],
    );
  }
  return v as string[];
}
