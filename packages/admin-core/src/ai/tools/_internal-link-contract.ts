// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 — the internal-link contract, appended verbatim to every tool
 * whose input can carry a link (CLAUDE.md §11: the tool description says
 * what the op will refuse, so the AI gets it right on the first call
 * instead of learning it from an error). Write ops store an internal link
 * as a reference to the page it names, so the page must already exist.
 */
export const INTERNAL_LINK_CONTRACT =
  " **Internal links** (`href`s in HTML, `url`/`link` fields, link-list and nav items): write the page's path, e.g. `/about` — it must be an EXISTING page (list_pages); a link to a page that does not exist yet is refused, so create the target first (`build_page({page:{slug, title}, modules: []})` makes an empty page shell in one call), or add the link after. The site root `/` (also `/#section`) is always valid, even before the homepage is built. Exception, a site import you are rebuilding in this chat: a link to a page of that import run is kept and resolved by resolve_import_links at the end. Images/files: their media URL (find_media). Other sites: the full https:// URL.";
