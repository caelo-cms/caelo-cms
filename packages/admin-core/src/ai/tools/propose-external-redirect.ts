// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1358 — `propose_external_redirect`: a redirect to another domain,
 * AI-proposed and Owner-approved (CLAUDE.md §11.A). Redirects within the site
 * stay routine (`bulk_create_redirects`).
 */

import { externalRedirectsInput } from "../../ops/redirects_pending.js";
import { makeProposeTool } from "./_make-propose-tool.js";

export const proposeExternalRedirectTool = makeProposeTool({
  toolName: "propose_external_redirect",
  opName: "redirects.propose_external",
  pendingQueuePath: "/settings/redirects",
  approvalPreviewOp: "redirects.preview_external",
  // #1550 — `goLive: "now"` puts the approved rules live after the apply.
  afterApply: "redirects-go-live-now",
  when:
    "Send an address on this site to another website with a real redirect: a short link on a QR code or letter, a booking link, an old subdomain's target. One call for several, approved together. Never build a page with a JS forward for this.\n" +
    "DO NOT USE FOR: a target on this site (`bulk_create_redirects`, the path only).\n" +
    'CORE RULES: `url` is the full `https://` address as a browser shows it: no credentials, no port, no host of this install. `statusCode` defaults to 302; use 301 only when the destination never changes, because browsers remember it. On the plain GCP hosting the `url` cannot carry a `?query` or `#fragment`. Approved rules are Staged (live with the next Publish live); `goLive: "now"` only when the operator wants them live at approval.',
  schema: externalRedirectsInput,
  summarize: (_input, preview) => `external redirects: ${String(preview.summary ?? "?")}`,
});
