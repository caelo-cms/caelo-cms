// SPDX-License-Identifier: MPL-2.0

/**
 * #1240 — the generator's last line of defence, as a person reads it.
 *
 * A render failure stops a build (`assertNoRenderFailures`). The generator
 * hands them over as structure, so the operator's text is built from titles,
 * paths and places, and module slugs, UUIDs and AI tool names stay in the
 * text only the AI reads (CLAUDE.md §1A).
 *
 * Link failures cannot reach this point: the check every build starts with
 * (`buildReferenceGate`) reads the same pages, statuses and language
 * partition. When one does, the check and the build disagreed, so it is a
 * Caelo bug, said as one and filed into the bug intake (#901).
 */

import { isLinkFailureMarker } from "@caelo-cms/shared";
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

/** A failure's place in the operator's words. */
function placeOf(f: RenderFailure): string {
  return f.blockName === null ? "the site layout" : `the ${f.blockName}`;
}

/** What is wrong with a link failure's target, in the operator's words. */
function linkProblem(f: RenderFailure): string {
  const name = f.target ? `${f.target.title} (${f.target.path})` : "A link";
  const variant = /^link-variant-missing:.+:([^:]+)$/.exec(f.reason)?.[1];
  if (variant !== undefined) return `${name} has no ${languageName(variant)} version`;
  if (f.reason.startsWith("link-target-missing:")) return "A link points at something deleted";
  return "A link is written in a form that matches no page";
}

/**
 * The text of a stopped build.
 *
 * @returns `operator`: titles, paths and places only; `ai`: the failures as
 *   the generator named them, with the tools that repair them; `caeloFault`:
 *   a link failure is among them, which the gate before the build should
 *   have caught.
 */
export function describeRenderFailures(failures: readonly RenderFailure[]): {
  readonly operator: string;
  readonly ai: string;
  readonly caeloFault: boolean;
} {
  const links = failures.filter((f) => isLinkFailureMarker(f.reason));
  const others = failures.filter((f) => !isLinkFailureMarker(f.reason));
  const lines: string[] = [];
  const byProblem = new Map<string, { places: Set<string>; pages: Set<string> }>();
  for (const f of links) {
    const problem = linkProblem(f);
    const g = byProblem.get(problem) ?? { places: new Set(), pages: new Set() };
    g.places.add(placeOf(f));
    g.pages.add(f.pagePath);
    byProblem.set(problem, g);
  }
  for (const [problem, g] of byProblem) {
    lines.push(
      `${problem} — linked from ${[...g.places].join(", ")} of ${[...g.pages].join(", ")}`,
    );
  }
  for (const f of others.slice(0, 10)) {
    lines.push(`${placeOf(f)} of ${f.pageTitle} (${f.pagePath}) could not be rendered`);
  }
  if (others.length > 10) lines.push(`and ${others.length - 10} more`);
  const caeloFault = links.length > 0;
  const next = caeloFault
    ? "This is a Caelo bug: the check before the build should have caught this, and it has been reported."
    : "The editor preview flags the same spots; ask the AI to repair them, then Stage again.";
  return {
    operator: `The build stopped: ${lines.join("; ")}. ${next}`,
    ai:
      `The generator refused the build: ${failures
        .slice(0, 25)
        .map((f) => f.line)
        .join("; ")}. ` +
      "Repair each field: get_content_instance on the module's content, then set_content_instance_values_many with a valid { moduleId, contentInstanceId } reference or without the broken item. A link: check_links names the place and the tool. Then stage_changes." +
      (caeloFault ? " File it with bug_report: the check before the build missed this link." : ""),
    caeloFault,
  };
}
