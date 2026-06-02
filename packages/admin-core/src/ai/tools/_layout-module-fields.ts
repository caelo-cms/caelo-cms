// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (step-13 round-5 deviation) — guard for layout/template chrome
 * module content.
 *
 * Layout + template chrome modules are site-wide / template-wide singletons.
 * Unlike page modules, their placements carry NO content_instance binding
 * (`layout_modules` has no `content_instance_id` column), so the ONLY content
 * path that renders is the authored field `default`s — the preview op + static
 * generator interpolate those defaults via the shared template engine (see
 * `ops/content/preview.ts` "layout module ... content lives in the authored
 * field defaults").
 *
 * The step-13 walk-through caught the AI authoring a footer whose `nav_links` /
 * `copyright` fields had NO defaults, then routing the real values through
 * `create_content_instance` + (intended) `set_placement_content` — which bind
 * PAGE placements only. The values never reached the layout placement, so the
 * footer shipped raw `{{copyright}}` + an empty nav site-wide while the AI
 * reported success. That is the issue-#106 class: a valid-looking AI path that
 * silently produces a broken render because the AI-facing surface didn't make
 * the layout-content contract explicit (CLAUDE.md §1A).
 *
 * This helper finds the fields on a layout/template module that cannot render
 * from defaults, so the tool can reject loudly + actionably BEFORE creating the
 * module (recover-don't-punt) and the AI re-authors with defaults.
 */

import type { ModuleField } from "@caelo-cms/shared";

export interface UnrenderableLayoutField {
  readonly name: string;
  /** AI-facing explanation of why this field can't render on chrome + the fix. */
  readonly reason: string;
}

/**
 * Return the declared fields that would NOT render on a layout/template
 * placement (which has no content_instance binding):
 *
 *  - `module` / `module-list` fields — these reference nested modules filled
 *    via a content_instance, which chrome placements don't have. There is no
 *    `default` to fall back to either, so they can never render here.
 *  - any other field kind authored WITHOUT a `default` — chrome renders from
 *    defaults, so a missing default ships a raw `{{name}}` placeholder.
 *
 * A module with no fields (fully static HTML) or fields that all carry
 * defaults returns `[]`. Reserved theme placeholders (`{{theme_logo_url}}` …)
 * are resolved by the template engine, not declared as fields, so they are
 * unaffected.
 */
export function findUnrenderableLayoutFields(
  fields: readonly ModuleField[] | undefined,
): UnrenderableLayoutField[] {
  if (!fields || fields.length === 0) return [];
  const problems: UnrenderableLayoutField[] = [];
  for (const field of fields) {
    if (field.kind === "module" || field.kind === "module-list") {
      problems.push({
        name: field.name,
        reason: `\`${field.name}\` (kind \`${field.kind}\`) needs a content_instance to fill it, and layout/template placements have NO content binding — model the sub-content as a \`link-list\`/\`text-list\` with a \`default\`, or inline it directly in the HTML`,
      });
      continue;
    }
    // Every other kind supports a `default`. On chrome it is REQUIRED, because
    // the default is the only content path that renders.
    const hasDefault = "default" in field && (field as { default?: unknown }).default !== undefined;
    if (!hasDefault) {
      problems.push({
        name: field.name,
        reason: `\`${field.name}\` (kind \`${field.kind}\`) has no \`default\` — chrome renders from field defaults, so it would ship a raw \`{{${field.name}}}\` placeholder on every page`,
      });
    }
  }
  return problems;
}

/**
 * Build the AI-actionable rejection body for a chrome module whose fields
 * can't render. Shared by `add_module_to_layout` + `add_module_to_template`
 * so the two surfaces stay identical (CLAUDE.md §1A).
 */
export function unrenderableLayoutFieldsError(
  toolName: string,
  surface: "layout" | "template",
  problems: readonly UnrenderableLayoutField[],
): string {
  const where = surface === "layout" ? "every page" : "every page using this template";
  return (
    `${toolName}: ${surface} chrome renders from field DEFAULTS — ${surface} placements have NO content_instance binding, ` +
    `so content_instances / set_placement_content do NOT apply here (those bind PAGE placements only). ` +
    `These fields would render as raw placeholders on ${where}:\n` +
    problems.map((p) => `- ${p.reason}`).join("\n") +
    `\n\nRe-call \`${toolName}\` with each field carrying a \`default\` holding the real content, e.g. ` +
    `\`{name:"copyright",kind:"text",label:"Copyright",default:"© 2026 Acme. All rights reserved."}\` and ` +
    `\`{name:"nav_links",kind:"link-list",label:"Footer navigation",default:[{label:"Home",href:"/"},{label:"About",href:"/about"}]}\`. ` +
    `Do NOT call create_content_instance / set_placement_content for ${surface} chrome.`
  );
}
