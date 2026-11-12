// SPDX-License-Identifier: MPL-2.0

/**
 * #1240 / #1604 — the content a build could not render, as a person and as
 * the AI read it.
 *
 * The generator hands render failures over as structure, so the operator's
 * text is built from titles, paths and places, and module slugs, UUIDs and
 * AI tool names stay in the text only the AI reads (CLAUDE.md §1A).
 *
 * Two outcomes:
 *   - A Stage never stops on the site's content (#1604): the full staging
 *     build ships the broken spot as the editor preview shows it and
 *     reports the failures. {@link stagedRenderReport} is what its run
 *     records (`deploy_runs.render_report`), what the Stage says, what the
 *     audit's `render` check reports per page and what Publish live refuses.
 *   - Every other build stops on one (`assertNoRenderFailures`), and so
 *     does a Stage whose failure no content edit can repair:
 *     {@link describeRenderFailures} is that stop's text.
 *
 * A production build's link failures cannot reach the generator: the check
 * every production build starts with (`buildReferenceGate`) reads the same
 * pages, statuses and language partition. When one does, the check and the
 * build disagreed, so it is a Caelo bug, said as one and filed into the bug
 * intake (#901). A Stage reports its links instead of refusing them, so
 * there they are content like any other failure.
 */

import {
  isCaeloFaultMarker,
  isLinkFailureMarker,
  renderFailureKind,
  renderFailureMarker,
} from "@caelo-cms/shared";
import { z } from "zod";
import { languageName } from "../links/link-notice.js";

/** One render failure (the generator's `RenderFailure`). */
export const renderFailureSchema = z
  .object({
    pageId: z.string(),
    pageTitle: z.string(),
    pagePath: z.string(),
    /** The layout or template block; null for the layout's own HTML. */
    blockName: z.string().nullable(),
    moduleSlug: z.string().nullable(),
    field: z.string().nullable(),
    /** The marker: `link-variant-missing:page/<id>:en`, `module-missing:…`. */
    reason: z.string(),
    /** The linked page, for a link failure on a page that still exists. */
    target: z
      .object({ pageId: z.string(), title: z.string(), path: z.string() })
      .strict()
      .nullable(),
    /** The failure in one line, with technical names: for the AI and the log. */
    line: z.string(),
  })
  .strict();
export type RenderFailure = z.infer<typeof renderFailureSchema>;

/**
 * #1604 — what a Stage's run records of the content its build could not
 * render. Publish live refuses a run with one, whatever its audit says.
 */
export const renderReportSchema = z
  .object({
    /** How many failures the build had in all. */
    total: z.number().int().positive(),
    /** The first of them, in build order (the generator bounds the list). */
    failures: z.array(renderFailureSchema),
    /** For the operator: titles, paths and places, no tool names or ids. */
    operatorText: z.string(),
    /** For the AI: the failures as the generator named them, and the tools that repair them. */
    aiText: z.string(),
  })
  .strict();
export type RenderReport = z.infer<typeof renderReportSchema>;

/** How many places the operator's sentence names before "and N more". */
const PLACES_LISTED = 10;
/** How many technical lines the AI's text names before "and N more". */
const LINES_LISTED = 25;

/** A failure's place in the operator's words. */
function placeOf(f: RenderFailure): string {
  return f.blockName === null ? "the site layout" : `the ${f.blockName}`;
}

/** What is wrong with a link failure's target, in the operator's words. */
function linkProblem(f: RenderFailure): string {
  const name = f.target ? `${f.target.title} (${f.target.path})` : "A link";
  const reason = renderFailureMarker(f.reason);
  const variant = /^link-variant-missing:.+:([^:]+)$/.exec(reason)?.[1];
  if (variant !== undefined) return `${name} has no ${languageName(variant)} version`;
  if (reason.startsWith("link-target-missing:")) return "A link points at something deleted";
  return "A link is written in a form that matches no page";
}

/**
 * The places that failed, in the operator's words: a link grouped by what is
 * wrong with it, any other failure once per place and page.
 */
function operatorPlaces(failures: readonly RenderFailure[]): string[] {
  const lines: string[] = [];
  const byProblem = new Map<string, { places: Set<string>; pages: Set<string> }>();
  const others = new Set<string>();
  for (const f of failures) {
    if (isLinkFailureMarker(renderFailureMarker(f.reason))) {
      const problem = linkProblem(f);
      const g = byProblem.get(problem) ?? { places: new Set(), pages: new Set() };
      g.places.add(placeOf(f));
      g.pages.add(f.pagePath);
      byProblem.set(problem, g);
    } else {
      others.add(`${placeOf(f)} of ${f.pageTitle} (${f.pagePath})`);
    }
  }
  for (const [problem, g] of byProblem) {
    lines.push(
      `${problem} — linked from ${[...g.places].join(", ")} of ${[...g.pages].join(", ")}`,
    );
  }
  const listed = [...others];
  for (const place of listed.slice(0, PLACES_LISTED)) lines.push(`${place} could not be rendered`);
  if (listed.length > PLACES_LISTED) lines.push(`and ${listed.length - PLACES_LISTED} more`);
  return lines;
}

/** The tool that repairs a failure and what to do with it, in the tool's terms. */
export interface RenderRepair {
  readonly tool: string;
  readonly hint: string;
}

const REFERENCE_REPAIR =
  "get_content_instance on the module's content, then set_content_instance_values_many with a valid { moduleId, contentInstanceId } reference or without the broken item";

/**
 * How the AI repairs one failure. The markers are the engine's (shared
 * template-engine.ts names them); a kind without its own entry gets the
 * content repair, which shows the stored value first.
 */
export function renderRepairOf(f: Pick<RenderFailure, "reason" | "moduleSlug">): RenderRepair {
  const marker = renderFailureMarker(f.reason);
  const kind = renderFailureKind(f.reason);
  const path = marker.slice(kind.length + 1);
  const mod = f.moduleSlug ? `module "${f.moduleSlug}"` : "the module";
  if (isLinkFailureMarker(marker)) {
    return {
      tool: "check_links",
      hint: "check_links names the place of this link and the tool that repairs it: point it at an existing page or file, or remove it.",
    };
  }
  switch (kind) {
    case "plugin-list-unavailable":
    case "list-source-unavailable":
      return {
        tool: "list_plugins",
        hint: `${mod} iterates a list a plugin offers, and that plugin is not running: the operator activates it again at Settings → Plugins, or remove the module from the page (remove_module_from).`,
      };
    case "field-path-unknown":
      return {
        tool: "update_modules_many",
        hint: `{{${path}}} in ${mod} is a path its field cannot answer: a link field has {{f}}, {{f.href}}, {{f.target}} and {{f.title}}, and a link's text is a text field of its own. Declare one, use it in the HTML instead, and set its value on each placement (get_content_instance shows the stored one).`,
      };
    case "field-value-empty":
      return {
        tool: "set_content_instance_values_many",
        hint: `The link field behind {{${path}}} in ${mod} has no value: set it, or wrap that markup in {{#field}}…{{/field}} with update_modules_many.`,
      };
    case "field-value-malformed":
      return {
        tool: "set_content_instance_values_many",
        hint: `The link field ${path} in ${mod} holds no link: set it to a URL or { href, target? } (get_content_instance shows what is stored).`,
      };
    default:
      return { tool: "set_content_instance_values_many", hint: `${REFERENCE_REPAIR}.` };
  }
}

/** Each distinct repair once, in the order the failures need them. */
function repairHints(failures: readonly RenderFailure[]): string {
  const seen = new Set<string>();
  const hints: string[] = [];
  for (const f of failures) {
    const r = renderRepairOf(f);
    const key = `${r.tool}|${renderFailureKind(f.reason)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push(`${renderFailureKind(f.reason)}: ${r.tool} — ${r.hint}`);
    if (hints.length >= 5) break;
  }
  return hints.join(" ");
}

/** The technical lines, bounded, with the rest counted. */
function technicalLines(failures: readonly RenderFailure[], total: number): string {
  const listed = failures
    .slice(0, LINES_LISTED)
    .map((f) => f.line)
    .join("; ");
  const more = total > LINES_LISTED ? `; …and ${total - LINES_LISTED} more` : "";
  return `${listed}${more}`;
}

/**
 * #1604 — what a Stage's run records of the content it could not render;
 * null when the build rendered everything.
 *
 * @param total how many failures the build had (the list may be cut).
 */
export function stagedRenderReport(
  failures: readonly RenderFailure[],
  total: number,
): RenderReport | null {
  if (total === 0 || failures.length === 0) return null;
  const spots = total === 1 ? "1 spot" : `${total} spots`;
  return {
    total,
    failures: [...failures],
    operatorText:
      `Staged, but ${spots} could not be rendered and show${total === 1 ? "s" : ""} on staging as the editor preview shows ${total === 1 ? "it" : "them"}: ${operatorPlaces(failures).join("; ")}. ` +
      "Publish live is blocked until they are repaired: ask the AI to repair them, then Stage again.",
    aiText:
      `The staging build could not render ${spots}; staging shows them as the editor preview does, and Publish live refuses this Stage until they are repaired: ${technicalLines(failures, total)}. ` +
      `Repair: ${repairHints(failures)} Then stage_changes again; get_quality_audit lists each as a render/* finding.`,
  };
}

/**
 * #1604 — why Publish live refuses a run with a render report, for the
 * operator: what could not be rendered and the next step. The AI reads the
 * report's `aiText` alongside it.
 */
export function publishBlockedByRender(report: RenderReport): string {
  const spots = report.total === 1 ? "1 spot" : `${report.total} spots`;
  return (
    `Publish live is blocked: the staged build has ${spots} it could not render, and Publish live would copy ${report.total === 1 ? "it" : "them"} live as ${report.total === 1 ? "it is" : "they are"} — ${operatorPlaces(report.failures).join("; ")}. ` +
    "Ask the AI to repair them, then Stage again. Accepting a quality finding or publishing anyway does not apply to these."
  );
}

/** A Caelo bug a stopped build names and files (#901). */
export interface RenderFault {
  readonly title: string;
  readonly expected: string;
}

/**
 * The text of a stopped build.
 *
 * @returns `operator`: titles, paths and places only; `ai`: the failures as
 *   the generator named them, with the tools that repair them; `caeloFault`:
 *   set when the failures include a Caelo bug — a production build's link
 *   the check before it should have refused, or a render without its context.
 */
export function describeRenderFailures(failures: readonly RenderFailure[]): {
  readonly operator: string;
  readonly ai: string;
  readonly caeloFault: RenderFault | null;
} {
  const lines = operatorPlaces(failures);
  const contextless = failures.some((f) => isCaeloFaultMarker(f.reason));
  const links = failures.some((f) => isLinkFailureMarker(renderFailureMarker(f.reason)));
  const caeloFault: RenderFault | null = contextless
    ? {
        title: "A build rendered content without what the renderer needs",
        expected:
          "Every render has its link resolver, nested renderer and list context; such a marker is never legitimate output.",
      }
    : links
      ? {
          title: "The link check and the build disagreed about a link",
          expected:
            "The reference check before a build reports every link the build cannot render, in the same language view.",
        }
      : null;
  const next = contextless
    ? "This is a Caelo bug, not something in the site: it has been reported."
    : links
      ? "This is a Caelo bug: the check before the build should have caught this, and it has been reported."
      : "The editor preview flags the same spots; ask the AI to repair them, then build again.";
  return {
    operator: `The build stopped: ${lines.join("; ")}. ${next}`,
    ai:
      `The generator refused the build: ${technicalLines(failures, failures.length)}. ` +
      `Repair: ${repairHints(failures)} Then build again.` +
      (caeloFault ? ` File it with bug_report: ${caeloFault.title.toLowerCase()}.` : ""),
    caeloFault,
  };
}
