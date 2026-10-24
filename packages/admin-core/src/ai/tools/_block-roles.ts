// SPDX-License-Identifier: MPL-2.0

/**
 * Which blocks a page places into and which are site chrome, in the words
 * every layout/template read uses (#1076 real-AI gate).
 *
 * A layout's blocks (`header|content|footer`) and a template's blocks
 * (usually just `content`) are different namespaces: build_page and
 * add_module target='page' accept only TEMPLATE blocks, while header /
 * footer live on the LAYOUT (add_module target='layout', placed once for
 * every page). The layout's `content` block is where the template renders,
 * not chrome. When the only block list the AI had read was the layout's,
 * it took `header` for a page block and build_page refused the call — so
 * every surface that lists blocks says which kind they are.
 */

/** The layout block the bound template renders into (never chrome). */
export const TEMPLATE_RENDER_BLOCK = "content";

/** A layout's chrome blocks: every block except the template's render target. */
export function chromeBlockNames(layoutBlocks: readonly { name: string }[]): string[] {
  return layoutBlocks.map((b) => b.name).filter((n) => n !== TEMPLATE_RENDER_BLOCK);
}

/**
 * One sentence naming the page blocks of a template and the chrome blocks
 * of its layout, with the tool for each — for tool results that hand the
 * AI a template/layout pair (bootstrap_site_scaffold).
 */
export function blockPlacementGuide(
  template: { slug: string; blocks: readonly { name: string }[] },
  layout: { slug: string; blocks: readonly { name: string }[] },
): string {
  const pageBlocks = template.blocks.map((b) => b.name);
  const chrome = chromeBlockNames(layout.blocks);
  const pagePart =
    pageBlocks.length > 0
      ? `Pages on template ${template.slug} place modules into its block(s) ${pageBlocks.map((n) => `'${n}'`).join(", ")} — the ONLY valid build_page blockName values.`
      : `Template ${template.slug} has no blocks, so build_page cannot place modules on its pages.`;
  const chromePart =
    chrome.length > 0
      ? ` ${chrome.map((n) => `'${n}'`).join(", ")} ${chrome.length === 1 ? "is" : "are"} site chrome on layout ${layout.slug}: put a header/footer there ONCE for every page with add_module({target:'layout', targetRef:'${layout.slug}', blockName:'${chrome[0]}', …}) — never as a build_page entry.`
      : "";
  return pagePart + chromePart;
}
