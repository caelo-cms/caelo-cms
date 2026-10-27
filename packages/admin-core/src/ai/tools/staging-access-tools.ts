// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #650 — the agent's surface for the protected staging domain.
 *
 *  - get_staging_access: the staging URL and who may open it. Never the
 *    crawler credentials (#971): the Owner reads those in Settings →
 *    Staging access; over MCP the model may belong to a third party.
 *  - propose_set_staging_access / propose_rotate_staging_credentials /
 *    propose_set_staging_host: the
 *    §11.A-gated writes (owner_settings_staging.ts). They change who can
 *    see unpublished work, so the operator approves each one in the chat.
 *
 * "Open staging" (a browser session cookie) has no tool on purpose — see
 * the `Why human-only` note on staging_access.issue_open_link.
 */

import { z } from "zod";
import { describeDraftPages } from "../../deploy/draft-pages.js";
import {
  proposeRotateStagingCredentialsInput,
  proposeSetStagingHostInput,
  proposeStagingAccessInput,
} from "../../ops/owner_settings_staging.js";
import type { stagingAccessOutput } from "../../ops/staging_access.js";
import { makeProposeTool } from "./_make-propose-tool.js";
import { makeReadTool } from "./_make-read-tool.js";

const PENDING_QUEUE = "/settings/owner-settings/pending";

type StagingAccessValue = z.infer<typeof stagingAccessOutput>;

/** Where the operator gets the crawler credentials the AI never sees (#971). */
export const STAGING_CREDENTIALS_NOTE =
  "Crawler credentials (basic-auth password, secret header value): not shown to you — the operator copies them from Settings → Staging access (/settings/staging). Never ask for them or offer to relay them.";

/** Render `staging_access.get` for the model. Exported for tests. */
export function formatStagingAccess(v: StagingAccessValue): string {
  const s = v.settings;
  const lines: string[] = [];
  if (!v.stagingDomainSupported) {
    lines.push(
      `Staging URL: none — this install's provider (${v.provider}) has no protected staging domain yet; the Stage result links the staged build.`,
    );
  } else if (v.stagingUrl === null) {
    lines.push(
      "Staging host: not configured yet — the admin stores it from provisioning on its next start (`cms-provision upgrade`), or propose one with propose_set_staging_host.",
    );
  } else {
    lines.push(
      `Staging URL: ${v.stagingUrl}/ (noindex; serves exactly what Publish live ships, with this host).`,
    );
    // #678 — what the host serves right now, and the next step when that
    // is nothing (or a build rendered for an older host).
    lines.push(v.stageNote ?? "A staged build for this host is being served.");
  }
  const drafts = describeDraftPages(v.draftPages);
  if (drafts) lines.push(drafts);
  lines.push("Access modes (any one lets a request in):");
  lines.push(`- Open staging from the admin (session cookie): ${s.cookieEnabled ? "on" : "off"}`);
  lines.push(
    `- Basic auth: ${s.basicAuthEnabled ? `on, user "${s.basicAuthUser}"` : "off"}${s.basicAuthEnabled && !s.basicAuthGenerated ? " (no password generated yet)" : ""}`,
  );
  lines.push(`- Secret header: ${s.headerEnabled ? `on, header "${s.headerName}"` : "off"}`);
  lines.push(`- IP allowlist: ${s.ipAllowlist.length > 0 ? s.ipAllowlist.join(", ") : "empty"}`);
  lines.push(STAGING_CREDENTIALS_NOTE);
  return lines.join("\n");
}

export const getStagingAccessTool = makeReadTool({
  name: "get_staging_access",
  description:
    "Read the protected staging site: URL, whether a staged build is served, which access modes admit people + crawlers.\n" +
    "USE FOR: where to see staging, how a crawler (e.g. searchVIU dev crawl) gets in, before `propose_set_staging_access`. You never see the basic-auth password / secret header value — the operator copies them from Settings → Staging access (/settings/staging).",
  opName: "staging_access.get",
  input: z.object({}).strict(),
  // #971 — never the credentials, whoever the operator is: the AI result
  // reaches the model, and over MCP a third-party one.
  buildOpInput: () => ({ includeCredentials: false }),
  includeValue: false,
  format: (value) => formatStagingAccess(value as StagingAccessValue),
});

export const proposeSetStagingAccessTool = makeProposeTool({
  toolName: "propose_set_staging_access",
  opName: "owner_settings.propose_set_staging_access",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose who may open the protected staging site (https://staging.<domain>).\n" +
    "CORE RULES:\n" +
    "- Read current settings (`get_staging_access`) first; send ONLY what changes. At least one mode must stay on.\n" +
    "- searchVIU dev crawl: basic auth (dev_auth_type PW) or the crawler's egress IP (dev_auth_type IP). Never invent an IP — take it from the operator.\n" +
    "- Applies within seconds after approval. A new password / header value is never shown to you — the operator copies it from Settings → Staging access (/settings/staging).\n" +
    "- If `get_staging_access` says nothing is staged, the host serves nothing until `stage_changes`.",
  schema: proposeStagingAccessInput,
  summarize: (_input, preview) => String(preview.summary ?? "staging access change"),
});

export const proposeRotateStagingCredentialsTool = makeProposeTool({
  toolName: "propose_rotate_staging_credentials",
  opName: "owner_settings.propose_rotate_staging_credentials",
  pendingQueuePath: PENDING_QUEUE,
  when: "Propose replacing staging crawler credentials. ONLY when the operator asks or one may have leaked: crawlers/tools with the old value are locked out until given the new one; irreversible. You never see the new value — the operator copies it from Settings → Staging access (/settings/staging).",
  schema: proposeRotateStagingCredentialsInput,
  summarize: (_input, preview) => String(preview.summary ?? "rotate staging credentials"),
});

export const proposeSetStagingHostTool = makeProposeTool({
  toolName: "propose_set_staging_host",
  opName: "owner_settings.propose_set_staging_host",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose moving the protected staging site to another host (any FQDN the operator names, also another domain). ONLY when the operator asks. Read the current host (`get_staging_access`) first.\n" +
    "After approval tell the operator both steps: (1) map the host with `cms-provision staging-domain enable --staging-domain <host>` (DNS + certificate; it also sets the host, so if they run it no proposal is needed); (2) NOTHING is served there until the next Stage -> `stage_changes` when the work is ready.",
  schema: proposeSetStagingHostInput,
  summarize: (_input, preview) => String(preview.summary ?? "staging host change"),
});
