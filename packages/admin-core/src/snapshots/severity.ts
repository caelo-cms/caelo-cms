// SPDX-License-Identifier: MPL-2.0

/**
 * Severity heuristic for the impact preview. Pure function — easy to
 * unit-test, easy for P6 to refine when the thumbnailer is available.
 *
 * Rules in P4:
 *   - high   when >=5 affected pages, OR any affected slot is a
 *            template "header" slot (proxy for above-the-fold).
 *   - medium when >=2 affected pages, OR the change spans >=2 templates.
 *   - low    otherwise.
 *
 * `templateBlockIsHeader` is injected so the caller (the impact op) can
 * supply its own rule — e.g. "block name starts with 'header' or 'nav'".
 */

export type Severity = "low" | "medium" | "high";

export interface SeverityInput {
  readonly affectedPages: readonly {
    readonly pageId: string;
    readonly templateId: string;
    readonly blockName: string;
  }[];
  /** Returns true if the slot is considered above-the-fold / chrome. */
  readonly templateBlockIsHeader: (templateId: string, blockName: string) => boolean;
}

export interface SeverityResult {
  readonly severity: Severity;
  readonly reasons: readonly string[];
}

const HEADER_HINTS = new Set(["header", "nav", "navigation", "topbar", "hero"]);

/** Default block-name based heuristic — usable when the caller has no template knowledge. */
export function defaultTemplateBlockIsHeader(_templateId: string, blockName: string): boolean {
  const lower = blockName.toLowerCase();
  if (HEADER_HINTS.has(lower)) return true;
  for (const hint of HEADER_HINTS) {
    if (lower.startsWith(`${hint}-`) || lower.startsWith(`${hint}_`)) return true;
  }
  return false;
}

export function classifySeverity(input: SeverityInput): SeverityResult {
  const pageCount = input.affectedPages.length;
  const distinctTemplates = new Set(input.affectedPages.map((p) => p.templateId)).size;
  const touchesHeader = input.affectedPages.some((p) =>
    input.templateBlockIsHeader(p.templateId, p.blockName),
  );

  const reasons: string[] = [];
  if (touchesHeader) reasons.push("touches a header / nav slot");
  if (pageCount >= 5) reasons.push(`affects ${pageCount} pages`);
  else if (pageCount >= 2) reasons.push(`affects ${pageCount} pages`);
  if (distinctTemplates >= 2) reasons.push(`spans ${distinctTemplates} templates`);

  if (touchesHeader || pageCount >= 5) {
    return { severity: "high", reasons };
  }
  if (pageCount >= 2 || distinctTemplates >= 2) {
    return { severity: "medium", reasons };
  }
  if (pageCount === 1) reasons.push("affects 1 page");
  if (pageCount === 0) reasons.push("affects no published pages");
  return { severity: "low", reasons };
}
