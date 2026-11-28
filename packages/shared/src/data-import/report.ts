// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: the report a run hands back. It is small on purpose: the
 * rows themselves never pass through the model (docs/data-imports.md), so
 * the report counts outcomes and gives a few examples per problem. The AI
 * fixes a problem at its cause (the conversion script, the mapping) and
 * runs the import again; rows already imported are skipped.
 */

/** Why a row was not imported. */
export const IMPORT_PROBLEM_REASONS = [
  "unreadable-row",
  "missing-value",
  "invalid-value",
  "duplicate-source-key",
  "page-not-found",
  "parent-not-found",
  "refused",
] as const;
export type ImportProblemReason = (typeof IMPORT_PROBLEM_REASONS)[number];

/** Most examples a report lists per problem. */
export const MAX_PROBLEM_EXAMPLES = 20;

/** Longest example detail in a report. */
const MAX_DETAIL_LENGTH = 200;

/** One example of a problem: which row, where in the input, what is wrong. */
export interface ImportProblemExample {
  readonly sourceKey: string | null;
  readonly at: string;
  readonly detail: string;
}

/** All rows with one problem: how many, and the first few. */
export interface ImportProblemGroup {
  readonly reason: ImportProblemReason;
  readonly count: number;
  readonly examples: readonly ImportProblemExample[];
}

/** What happened to the rows of one call. */
export interface ImportCounts {
  /** Rows read from the input. */
  readonly rows: number;
  /** New rows written. */
  readonly imported: number;
  /** Rows of an earlier import overwritten (`mode: "update"`). */
  readonly updated: number;
  /** Rows an earlier import already holds, left as they are. */
  readonly unchanged: number;
  /** Rows with a problem. */
  readonly invalid: number;
}

/** Collects problems per reason, keeping the count and the first examples. */
export class ImportProblems {
  readonly #groups = new Map<
    ImportProblemReason,
    { count: number; examples: ImportProblemExample[] }
  >();
  readonly #rows = new Set<string>();

  /** Records one problem; `rowId` counts each row once however many problems it has. */
  add(reason: ImportProblemReason, rowId: string, example: ImportProblemExample): void {
    this.#rows.add(rowId);
    const g = this.#groups.get(reason) ?? { count: 0, examples: [] };
    g.count += 1;
    if (g.examples.length < MAX_PROBLEM_EXAMPLES)
      g.examples.push({
        ...example,
        detail:
          example.detail.length > MAX_DETAIL_LENGTH
            ? `${example.detail.slice(0, MAX_DETAIL_LENGTH - 1)}…`
            : example.detail,
      });
    this.#groups.set(reason, g);
  }

  /** Whether the row (by the id given to {@link add}) has a problem. */
  has(rowId: string): boolean {
    return this.#rows.has(rowId);
  }

  /** How many distinct rows have a problem. */
  get rowCount(): number {
    return this.#rows.size;
  }

  /** The groups, in the order of {@link IMPORT_PROBLEM_REASONS}. */
  groups(): ImportProblemGroup[] {
    return IMPORT_PROBLEM_REASONS.flatMap((reason) => {
      const g = this.#groups.get(reason);
      return g ? [{ reason, count: g.count, examples: g.examples }] : [];
    });
  }
}
