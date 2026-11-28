// SPDX-License-Identifier: MPL-2.0

/**
 * #1748 — the `value-breaks-markup` render failure of a core value that
 * changes the markup around its placeholder (the rule:
 * `core-value-structure.ts`), and the texts a write's refusal, a Stage's
 * report, the audit's finding and the preview's next steps give for it:
 * what the spelling does there, and what to write instead.
 */

import { type CoreValueProblem, VALUE_BREAKS_MARKUP } from "./core-value-structure.js";

/**
 * The render failure marker of a core value that breaks the markup around
 * it: `value-breaks-markup:<field>:<rule>`. `field` names where the value
 * comes from: a module field (`title`), a list entry (`ui_texts[<item
 * id>].text`), the page (`page.title`) or a site text (`site_text.<key>`).
 */
export function valueBreaksMarkupMarker(field: string, rule: string): string {
  return `${VALUE_BREAKS_MARKUP}:${field}:${rule}`;
}

/** The parts of a {@link VALUE_BREAKS_MARKUP} marker's body (what follows the kind). */
export function parseValueBreaksMarkup(body: string): {
  readonly field: string;
  readonly rule: string;
} {
  const at = body.lastIndexOf(":");
  return at < 0
    ? { field: body, rule: "" }
    : { field: body.slice(0, at), rule: body.slice(at + 1) };
}

/** True for a {@link VALUE_BREAKS_MARKUP} marker. */
export function isValueBreaksMarkupMarker(marker: string): boolean {
  return marker.startsWith(`${VALUE_BREAKS_MARKUP}:`);
}

/** What a rule's spelling does, in the AI's words. */
export function valueBreaksMarkupEffect(rule: string, spelling: string): string {
  const s = spelling.length > 0 ? `\`${spelling}\`` : "it";
  if (rule === "comment")
    return `${s} starts a comment that hides what follows up to the next \`-->\``;
  if (
    rule === "processing-instruction" ||
    rule === "markup-declaration" ||
    rule === "bogus-end-tag"
  ) {
    return `${s} starts a bogus comment that hides what follows up to the next \`>\` (the module's own markup included)`;
  }
  if (rule === "doctype") return `${s} is a doctype`;
  if (rule.startsWith("end-tag-")) return `${s} closes an element the value did not open`;
  if (rule.startsWith("unclosed-"))
    return `${s} is never closed, so the module's markup after the value lands inside it`;
  if (rule.startsWith("closes-")) {
    return `${s} closes the <${rule.slice("closes-".length)}> the module places the value in`;
  }
  if (rule === "unfinished-tag")
    return `${s} leaves a tag unfinished, which takes in the module's markup after it`;
  if (rule === "script-comment")
    return `${s} in a script can keep the module's \`</script>\` from ending it`;
  if (
    rule.startsWith("ends-") &&
    rule !== "ends-comment" &&
    rule !== "ends-tag" &&
    rule !== "ends-tag-name"
  ) {
    return `${s} ends the module's <${rule.slice("ends-".length)}> early`;
  }
  if (rule === "ends-comment") return `${s} ends the module's comment early`;
  if (rule === "attribute-quote" || rule === "attribute-apostrophe") {
    return `${s} ends the attribute value early`;
  }
  if (rule === "attribute-space" || rule === "attribute-end")
    return "it ends the unquoted attribute value early";
  if (rule === "ends-tag" || rule === "ends-tag-name") return `${s} ends the tag early`;
  if (rule === "tag-self-closing") {
    return "its last unquoted value takes in the `/` of the module's self-closing tag, so the element stays open";
  }
  return `${s} changes the markup around the value`;
}

/** How to write the value instead, for a rule. */
export function valueBreaksMarkupFix(rule: string, spelling: string): string {
  const asText = spelling.replaceAll("<", "&lt;");
  if (rule === "attribute-apostrophe") return "Write the ' as &#39;.";
  if (rule === "attribute-quote") return 'Write the " as &quot;.';
  if (rule === "attribute-space" || rule === "attribute-end") {
    return 'Quote the attribute in the module HTML (attr="{{field}}"), or write a space as &#32; and > as &gt;.';
  }
  if (rule === "ends-script" || rule === "ends-style" || rule === "script-comment") {
    return "In script or CSS text write `<\\/` for `</` and `<\\!--` for `<!--`.";
  }
  if (
    rule.startsWith("ends-") &&
    rule !== "ends-comment" &&
    rule !== "ends-tag" &&
    rule !== "ends-tag-name"
  ) {
    return "Write the `<` of it as &lt;.";
  }
  if (rule === "ends-comment") return "Write the > of it as &gt;.";
  if (rule === "tag-self-closing")
    return "Quote the last attribute value, or end the value with a space.";
  if (rule === "ends-tag" || rule === "ends-tag-name") {
    return "Write the > as &gt; and keep quotes paired.";
  }
  if (rule.startsWith("unclosed-")) {
    return `Close it inside the value, or write ${asText.length > 0 ? `\`${asText}\`` : "its <"} if it is text (a < meant as text is &lt;).`;
  }
  if (rule.startsWith("closes-")) {
    return `Leave that tag out of the value (the module already places it in a <${rule.slice("closes-".length)}>), or write \`${asText}\` if it is text.`;
  }
  return `Write a < meant as text as &lt;${asText.length > 0 ? ` (here \`${asText}\`)` : ""}.`;
}

/**
 * The refusal of one breaking value, for a write's error (CLAUDE.md §11):
 * what it holds, why it breaks where the module places it, what to write.
 *
 * @param where the value in the caller's terms (`field "text" of list entry <id>`).
 * @param module the module whose HTML places it (its slug), when the caller knows it.
 */
export function describeValueBreaksMarkup(
  where: string,
  problem: CoreValueProblem,
  module?: string,
): string {
  const html = module === undefined ? "the module HTML" : `module "${module}"`;
  return `${where} holds \`${problem.spelling}\`: in ${problem.place} of ${html} ${valueBreaksMarkupEffect(problem.rule, problem.spelling)}. ${valueBreaksMarkupFix(problem.rule, problem.spelling)}`;
}

/** The spelling a rule names, for a marker that does not carry it (a Stage's report). */
function ruleSpelling(rule: string): string {
  if (rule === "processing-instruction") return "<?";
  if (rule === "comment" || rule === "script-comment") return "<!--";
  if (rule === "markup-declaration") return "<!";
  if (rule === "bogus-end-tag") return "</";
  if (rule === "doctype") return "<!DOCTYPE";
  if (rule === "ends-comment") return "-->";
  if (rule === "attribute-quote") return '"';
  if (rule === "attribute-apostrophe") return "'";
  if (rule === "attribute-end" || rule === "ends-tag" || rule === "ends-tag-name") return ">";
  if (rule === "unfinished-tag") return "<";
  if (rule.startsWith("end-tag-")) return `</${rule.slice("end-tag-".length)}>`;
  if (rule.startsWith("unclosed-")) return `<${rule.slice("unclosed-".length)}>`;
  if (rule.startsWith("ends-")) return `</${rule.slice("ends-".length)}`;
  return "";
}

/**
 * #1748 — how the AI repairs a {@link VALUE_BREAKS_MARKUP} failure, by
 * where the value comes from: the tool, and the hint the Stage's report,
 * the audit's finding and the preview's next steps all give.
 *
 * @param body the marker without its kind (`<field>:<rule>`).
 * @param mod the place in the AI's terms (`module "hero"`).
 */
export function valueBreaksMarkupRepair(
  body: string,
  mod: string,
): { readonly tool: string; readonly hint: string } {
  const { field, rule } = parseValueBreaksMarkup(body);
  const spelling = ruleSpelling(rule);
  const effect = valueBreaksMarkupEffect(rule, spelling);
  const fix = valueBreaksMarkupFix(rule, spelling);
  const entry = /^([a-z0-9_]+)\[([^\]]+)\]\.(.+)$/.exec(field);
  let what: string;
  let tool: string;
  if (field.startsWith("site_text.")) {
    tool = "patch_list_items_many";
    what = `the site text "${field.slice("site_text.".length)}" (site-texts list)`;
  } else if (field.startsWith("page.")) {
    tool = "update_pages_many";
    what = `the page's ${field.slice("page.".length)}`;
  } else if (entry) {
    tool = "patch_list_items_many";
    what = `"${entry[3]}" of entry ${entry[2]} of list field "${entry[1]}" (shared list: patch_list_items_many; local: set_content_instance_values_many)`;
  } else {
    tool = "set_content_instance_values_many";
    what = `field "${field}" (its default: update_modules_many)`;
  }
  // The fix first: a finding's hint is cut at 500 characters.
  return {
    tool,
    hint: `${fix} Value: ${what} in ${mod}, where ${effect} (${rule}); it renders as written until fixed. Then Stage again.`,
  };
}
