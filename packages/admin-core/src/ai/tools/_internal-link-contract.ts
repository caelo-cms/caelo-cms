// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 — the internal-link contract, one CORE RULES line in every
 * tool whose input can carry a link. Write ops store an internal link as a
 * reference to the page it names, so the page must already exist.
 *
 * #1277 — one line, not the full block it used to be in seven core tools.
 * The line keeps what the AI gets wrong often (linking to a page it has
 * not built yet, ~1 in 5–10 calls during a multi-page build) and what the
 * server cannot see (where the path comes from). The rest — the empty-
 * shell remedy, media URLs, `/` always valid — is in the refusal itself
 * (`describeLinkIssues`), which the AI reads exactly when it needs it.
 * The site-import exception stays: it is behaviour no error reveals, and
 * without it a migration would build empty shells it does not need.
 */
export const INTERNAL_LINK_CONTRACT =
  "- INTERNAL LINKS: path of an EXISTING page (`/about`, `/#section`; `list_pages`) — a link to a page not built yet is refused (pages of this chat's site import excepted). External: full `https://` URL.";
