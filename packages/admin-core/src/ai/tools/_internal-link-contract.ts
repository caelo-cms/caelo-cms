// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 — the internal-link contract, one CORE RULES line in every
 * tool whose input can carry a link (CLAUDE.md §11: the tool description says
 * what the op will refuse, so the AI gets it right on the first call
 * instead of learning it from an error). Write ops store an internal link
 * as a reference to the page it names, so the page must already exist.
 */
export const INTERNAL_LINK_CONTRACT =
  "- INTERNAL LINKS (`html` hrefs, `url`/`link` fields, list-entry links): write the page path (e.g. `/about`). Target MUST be an existing page (`list_pages`) or it is refused — create an empty shell first (`build_page({page:{slug, title}, modules:[]})`) or link after. `/` and `/#section` are always valid. Exception: links to pages of this chat's site-import run are kept and resolved by `resolve_import_links` at the end. Media/files: media URL (`find_media`). External: full `https://` URL.";
