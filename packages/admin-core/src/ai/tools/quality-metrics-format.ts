// SPDX-License-Identifier: MPL-2.0

/**
 * How `get_quality_audit` and `check_stage_audit` show a page's Lighthouse
 * Performance metrics to the AI: each metric's median with Lighthouse's
 * rating, the runs behind it, the LCP element and breakdown, and the
 * layout shifts with their causes — enough to pick the module to fix
 * without running Lighthouse again.
 */

import type { z } from "zod";
import type { performanceMetricsSchema } from "../../quality/lighthouse-protocol.js";

type Metrics = z.infer<typeof performanceMetricsSchema>;
type Element = NonNullable<Metrics["lcpElement"]>;

/** Markdown inline code that survives backticks inside the text. */
export function inlineCode(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Lighthouse's metric rating bands (report-utils: >= 0.9 good, >= 0.5 average). */
function rating(score: number): string {
  if (score >= 0.9) return "good";
  if (score >= 0.5) return "needs improvement";
  return "POOR";
}

/** An element as code: selector and snippet, never live HTML (see formatPage). */
function element(el: Element): string {
  const parts = [
    el.selector ? inlineCode(el.selector) : null,
    el.snippet ? inlineCode(el.snippet) : null,
  ]
    .filter((x) => x !== null)
    .join(" ");
  const label = el.label ? ` (${el.label})` : "";
  return `${parts || "(no selector)"}${label}`;
}

/**
 * The metric lines of one page.
 *
 * @returns lines starting with a header; the caller joins them
 */
export function formatMetrics(m: Metrics): string[] {
  const lines = [
    `Performance metrics (median of ${m.runs} Lighthouse run(s) on the staged build; data behind the Performance score, not problems):`,
  ];
  for (const metric of m.metrics) {
    if (metric.numericValue === null) {
      lines.push(`- ${metric.label} (${metric.title}) not measured: ${metric.unavailableReason}`);
      continue;
    }
    const unit = metric.numericUnit === "millisecond" ? " ms" : "";
    const runs =
      metric.runValues.length > 1
        ? `; runs ${metric.runValues.map((v) => (v === null ? "—" : String(v))).join(" / ")}${unit}`
        : "";
    const score = metric.score === null ? "" : ` — score ${metric.score}, ${rating(metric.score)}`;
    lines.push(`- ${metric.label} ${metric.displayValue} (${metric.title})${score}${runs}`);
  }
  if (m.lcpElement) lines.push(`- LCP element: ${element(m.lcpElement)}`);
  if (m.lcpBreakdown.length > 0) {
    lines.push(
      `- LCP breakdown: ${m.lcpBreakdown.map((p) => `${p.label} ${p.durationMs} ms`).join(", ")}`,
    );
  }
  for (const shift of m.layoutShifts) {
    lines.push(
      `- layout shift ${shift.score}: ${element(shift.element)}${shift.causes.length > 0 ? ` — causes: ${shift.causes.join("; ")}` : ""}`,
    );
  }
  return lines;
}
