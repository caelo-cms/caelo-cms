// SPDX-License-Identifier: MPL-2.0

/**
 * Current-page + all-pages system-prompt context blocks. Extracted verbatim
 * from the pre-split `chat-runner.ts` (P6.7.3 / P6.7.5).
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

import { sanitizeMarkerDisplayName } from "../../marker-text.js";

/**
 * P6.7.3 — Current-page volatile chunk. When the live-edit surface sends
 * `activePageId`, load the page + its modules + the template's blocks and
 * surface that as a per-call context block so the AI knows what's on the
 * page and which tool to use.
 */
export async function buildPageContext(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtxWithBranch: ExecutionContext,
  activePageId: string | undefined,
): Promise<{
  pageContextBlock: string | undefined;
}> {
  let pageContextBlock: string | undefined;
  if (activePageId) {
    const pageR = await execute(registry, adapter, humanCtxWithBranch, "pages.get_with_modules", {
      pageId: activePageId,
    });
    if (pageR.ok) {
      const v = pageR.value as {
        page: {
          id: string;
          slug: string;
          locale: string;
          title: string;
          status: string;
          templateId: string;
          blocks: {
            blockName: string;
            modules: { moduleId: string; slug: string; displayName: string; html: string }[];
          }[];
        };
      };
      // P6.7.4 — render the page like a visitor would see it, with each
      // module's full HTML wrapped in BEGIN/END markers carrying the
      // module id + slug + block + position. The AI gets both the
      // visual structure ("make the headline more meaningful for this
      // landing page" works) and the module boundaries (so edit_module
      // / add_module_to_page calls reference a real id).
      const lines: string[] = [
        "# Current page",
        `Page: ${v.page.slug} (locale=${v.page.locale}, status=${v.page.status}, id=${v.page.id})`,
        `Template id: ${v.page.templateId}`,
        // v0.12.3 (issue #106) — this list is AUTHORITATIVE + EXHAUSTIVE.
        // `blockName` for add_module_to_page / move_module MUST be one of
        // these exact strings — do not invent others. A block name is NOT
        // the same thing as a module `kind` (chrome/hero/content/cta/
        // utility): `kind` classifies a module, a block name is a slot on
        // THIS page's template. e.g. a "hero" module goes INTO whichever
        // block exists below, often `content` — there is usually no block
        // literally named "hero".
        `Blocks on this page's template (the ONLY valid blockName values — exhaustive): ${
          v.page.blocks.map((b) => `\`${b.blockName}\``).join(", ") || "(none)"
        }`,
        "",
        "## Page content (rendered with module boundaries)",
        "",
      ];
      for (const b of v.page.blocks) {
        if (b.modules.length === 0) {
          lines.push(`<!-- block=${b.blockName} (empty) -->`);
          continue;
        }
        for (let i = 0; i < b.modules.length; i++) {
          const m = b.modules[i];
          if (!m) continue;
          const safeName = sanitizeMarkerDisplayName(m.displayName);
          lines.push(
            `<!-- BEGIN module=${m.moduleId} slug=${m.slug} block=${b.blockName} position=${i} displayName="${safeName}" -->`,
          );
          lines.push(m.html);
          lines.push(`<!-- END module=${m.moduleId} -->`);
        }
      }
      lines.push("");
      lines.push(
        "Tool guidance (module / page level):",
        "- edit_module — change an existing module's content (always reference a real module id from a BEGIN marker above).",
        "- add_module (target='page', targetRef = this page's slug or id) — insert a NEW module into a block on THIS page only. Use for one-off content (a CTA on the homepage, an FAQ on /about). Position is 'top', 'bottom', or a 0-based index.",
        '- add_module (target=\'template\', targetRef = the Template id above) — create a NEW module and fan it out to EVERY page using this template at the same block + position. Use only when the user explicitly asks for site-wide content ("add a footer to every page", "a header banner across the site").',
        "- remove_module_from (target='page', targetRef = this page's slug or id) — drop a module's reference from this page (the module row stays for re-use elsewhere). Use target='layout' to detach site-wide chrome.",
        "",
        "Tool guidance (page lifecycle — three independent identifiers):",
        "- A page has THREE separately-editable identifiers. Never silently substitute one for another:",
        "  * `name`  — the editor's friendly label (page picker, breadcrumbs). Internal-only.",
        "  * `title` — the HTML <title> tag (browser tab, search-engine SERP). Public.",
        "  * `slug`  — the URL path component. Public, indexed, every link points at it.",
        "- build_page({page:{name, title, slug, templateId, ...}, modules:[]}) — make a new page (empty shell; add modules in the same call for a full page).",
        "- update_pages_many({updates:[{pageId, …}]}) — the ONE tool for page metadata, for 1 page or many (single-item array for one page). Set exactly the identifier the user meant:",
        '  * `name` — internal label only. Use when the user says "rename" without mentioning URL or tab.',
        '  * `title` — HTML <title> only. Use when the user mentions "browser tab", "<title>", or "SERP".',
        "  * `slug` — URL only. Auto-creates a 301 from the old URL and rewrites links pointing at it. Use only when the user explicitly mentions changing the URL / slug / path. `redirectFromOld:'skip'` suppresses the 301 — only on explicit request.",
        "- delete_pages_many({deletions:[{pageId, disposition:'404'|'redirect', redirectTo?}]}) — the ONE delete tool, for 1 page or many (single-item array for one page). ALWAYS confirm the dead-URL disposition per page; suggest a redirect target (parent section, sibling, or /) when proposing 'redirect'. 5+ pages needs one Owner click.",
        '- When a request is ambiguous (e.g. just "rename to About"), ASK: "Should I update only the internal name, the <title> tag, or the URL too?"',
        "",
        "Tool guidance (content ops, P6.7.7):",
        "- duplicate_page(sourcePageId, newSlug, newName?, newTitle?, targetTemplateId?) — clone a page including its module layout. Modules carry by reference (edits propagate to both pages). If targetTemplateId differs from the source's template, block names must align — otherwise modules in unmatched blocks orphan and you should follow with `repoint_page_template` to migrate or drop them.",
        "- repoint_page_template(pageId, newTemplateId, orphanDisposition) — re-point a page to a different template (page-type). Modules in matching block names migrate; orphans drop or relocate per `orphanDisposition` (`{kind:'drop'}` or `{kind:'preserve-as-block', blockName}`). CONFIRM with the user before passing `{kind:'drop'}` if it would lose modules. The response carries `migratedBlocks` and `droppedModules` — surface both back in your reply.",
        "- move_module(pageId, moduleId, toBlockName, position) — move an EXISTING module across blocks (e.g. content → header). Use this, NOT `add_module`, when the module already exists on the page.",
        "- reorder_module(pageId, moduleId, direction) — change a module's position WITHIN its current block. Direction is 'up' / 'down' / a 0-based absolute index. Use this, NOT `move_module`, when the destination is the same block.",
        "- set_structured_set(kind, slug, displayName, items) — upsert a structured-data set (nav-menu, tags, taxonomy, theme, link-list, language-selector). Pass the FULL desired item list — op REPLACES, not appends. For partial updates (one theme token, one link rename), call `get_structured_set` first to read current items, mutate in JS, then `set_structured_set` with the merged array. The system-prompt block above already inlines nav-menu items (up to 30/menu) at session start; copy them and modify, don't re-invent.",
        "",
        'When the user asks for a copy change like "make the headline more meaningful" or "rewrite the welcome paragraph", read the surrounding modules in this block to keep the new copy coherent across the whole page.',
      );
      pageContextBlock = lines.join("\n");
    }
  }
  return { pageContextBlock };
}

/**
 * djb2 signature (base36) of a note's seed. Used to decide whether to re-inject
 * a message-flow note (current page, cold-start status). These notes ride on
 * the message flow, NOT the system prompt (the operator's rule: nothing dynamic
 * in the system prompt), injected on the first turn and again only when the
 * seed changed — so any edit that changes the rendered block re-triggers it.
 */
export function noteSignature(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * The signature of the most recently injected note carrying `marker` in the
 * history (each note ends with a `<!--marker:SIG-->` comment), or null if none.
 * Lets the change-check survive across turns without extra per-chat state.
 */
export function lastNoteSignature(
  messages: readonly { content: string }[],
  marker: string,
): string | null {
  const re = new RegExp(`<!--${marker}:([^>]+)-->`);
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]?.content;
    const m = typeof c === "string" ? c.match(re) : null;
    if (m) return m[1] ?? null;
  }
  return null;
}
