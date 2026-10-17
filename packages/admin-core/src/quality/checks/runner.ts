// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — run the findings checks over the pages of a staged build.
 *
 * Every check's output is validated at this boundary (CLAUDE.md §4: Zod at
 * every boundary — plugin-contributed checks are untrusted). A check
 * that throws, hangs, or returns something malformed is NOT skipped: it is
 * reported as a check error, which fails the audit loudly (no fallbacks,
 * CLAUDE.md §2) — a silently missing check would read as "no findings".
 */

import type { StagedBuild, StagedPage } from "./check.js";
import { checkIdOfRule, type Finding, findingSchema } from "./findings.js";
import type { RegisteredCheck } from "./registry.js";

type FindingsEntry = Extract<RegisteredCheck, { kind: "findings" }>;

/** Most findings one call of a check may return before it counts as broken. */
export const MAX_FINDINGS_PER_CALL = 500;

/** A check call slower than this is treated as hung (unless it sets its own `timeoutMs`). */
export const CHECK_CALL_TIMEOUT_MS = 30_000;

/** The most any check may ask for with `timeoutMs` (#849). */
export const MAX_CHECK_CALL_TIMEOUT_MS = 300_000;

/** A check that could not produce a valid result. */
export interface CheckRunError {
  readonly checkId: string;
  /** The page it failed on (page-scope checks). */
  readonly pageId?: string;
  readonly message: string;
}

export interface FindingRunResult {
  /** Every valid finding; page-scope findings always carry their pageId. */
  readonly findings: readonly Finding[];
  readonly errors: readonly CheckRunError[];
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate one call's output. Returns the findings (page scope: stamped
 * with the page) or the reason the output is unusable.
 */
function validateOutput(
  entry: FindingsEntry,
  output: unknown,
  scopePage: StagedPage | null,
  pageIds: ReadonlySet<string>,
): { ok: true; findings: Finding[] } | { ok: false; message: string } {
  if (!Array.isArray(output)) return { ok: false, message: "run() did not return an array" };
  if (output.length > MAX_FINDINGS_PER_CALL) {
    return {
      ok: false,
      message: `run() returned ${output.length} findings (at most ${MAX_FINDINGS_PER_CALL} per call)`,
    };
  }
  const findings: Finding[] = [];
  for (const raw of output) {
    const parsed = findingSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        message: `invalid finding (${issue?.path.join(".") || "finding"}: ${issue?.message ?? "invalid"})`,
      };
    }
    const f = parsed.data;
    if (checkIdOfRule(f.ruleId) !== entry.id) {
      return {
        ok: false,
        message: `finding rule '${f.ruleId}' does not belong to check '${entry.id}' (rule ids start with '${entry.id}/')`,
      };
    }
    if (scopePage) {
      if (f.pageId !== undefined && f.pageId !== scopePage.pageId) {
        return {
          ok: false,
          message: `a page check reported a finding for page ${f.pageId} while checking ${scopePage.path}`,
        };
      }
      findings.push({ ...f, pageId: scopePage.pageId });
      continue;
    }
    if (f.pageId !== undefined && !pageIds.has(f.pageId)) {
      return {
        ok: false,
        message: `finding names page ${f.pageId}, which is not a page of the staged build`,
      };
    }
    findings.push(f);
  }
  return { ok: true, findings };
}

/**
 * Run every findings check: page checks once per page, site checks once.
 *
 * @param checks - the registry's findings entries, in run order.
 * @param pages - every page of the staged build that was fetched.
 * @param build - the staged build, handed to site checks (#849).
 */
export async function runFindingChecks(
  checks: readonly FindingsEntry[],
  pages: readonly StagedPage[],
  build: StagedBuild,
): Promise<FindingRunResult> {
  const findings: Finding[] = [];
  const errors: CheckRunError[] = [];
  const pageIds = new Set(pages.map((p) => p.pageId));
  for (const entry of checks) {
    const check = entry.check;
    const calls: { page: StagedPage | null; invoke: () => unknown }[] =
      check.scope === "page"
        ? pages.map((page) => ({ page, invoke: () => check.run({ page }) }))
        : [{ page: null, invoke: () => check.run({ pages, build }) }];
    const timeoutMs = Math.min(check.timeoutMs ?? CHECK_CALL_TIMEOUT_MS, MAX_CHECK_CALL_TIMEOUT_MS);
    for (const call of calls) {
      const where = call.page ? ` on ${call.page.path}` : "";
      try {
        const output = await withTimeout(
          Promise.resolve().then(call.invoke),
          timeoutMs,
          `check '${entry.id}'${where}`,
        );
        const valid = validateOutput(entry, output, call.page, pageIds);
        if (!valid.ok) {
          errors.push({
            checkId: entry.id,
            ...(call.page ? { pageId: call.page.pageId } : {}),
            message: `check '${entry.id}'${where}: ${valid.message}`,
          });
          continue;
        }
        findings.push(...valid.findings);
      } catch (e) {
        errors.push({
          checkId: entry.id,
          ...(call.page ? { pageId: call.page.pageId } : {}),
          message: `check '${entry.id}'${where} failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }
  return { findings, errors };
}
