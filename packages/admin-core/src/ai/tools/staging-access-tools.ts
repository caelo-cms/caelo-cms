// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #650 — the agent's surface for the protected staging domain.
 *
 *  - get_staging_access: the staging URL and who may open it (and, for an
 *    Owner who asks, the crawler credentials — e.g. to set up a crawl).
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
  if (v.credentials) {
    const c = v.credentials;
    lines.push("Credentials (Owner only — give them only to the tool that needs them):");
    lines.push(
      `- basic auth: ${c.basicAuthPassword === null ? "not generated (enable basic auth first)" : `${c.basicAuthUser} / ${c.basicAuthPassword}`}`,
    );
    lines.push(
      `- header: ${c.headerValue === null ? "not generated (enable the secret header first)" : `${c.headerName}: ${c.headerValue}`}`,
    );
  }
  return lines.join("\n");
}

export const getStagingAccessTool = makeReadTool({
  name: "get_staging_access",
  description:
    "Read the protected staging site: its URL (https://staging.<domain>), whether a staged build is served, and which access modes let people and crawlers in (admin 'Open staging' cookie, basic auth, secret header, IP allowlist). " +
    "Use when the operator asks where to look at staging, how a crawler (e.g. a searchVIU dev crawl) gets in, or before propose_set_staging_access. " +
    "Pass includeCredentials: true ONLY when the operator asks for the basic-auth password / header value; they are returned only to an Owner (settings.write) and you must not repeat them anywhere else.",
  opName: "staging_access.get",
  input: z
    .object({
      includeCredentials: z
        .boolean()
        .optional()
        .describe("Return the crawler credentials (Owner only; only when asked)."),
    })
    .strict(),
  buildOpInput: (input) => ({ includeCredentials: input.includeCredentials ?? false }),
  // Credentials are revealed only to an operator holding settings.write;
  // run as that operator so the op can check their permission.
  runAsOperator: true,
  // The formatted text is the whole answer; never copy the raw value (and
  // the credentials in it) into the result twice.
  includeValue: false,
  format: (value) => formatStagingAccess(value as StagingAccessValue),
});

export const proposeSetStagingAccessTool = makeProposeTool({
  toolName: "propose_set_staging_access",
  opName: "owner_settings.propose_set_staging_access",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose who may open the protected staging site (https://staging.<domain>): cookieEnabled (admin 'Open staging'), basicAuthEnabled + basicAuthUser (a crawler logs in; the password is generated on approval), headerEnabled + headerName (a crawler sends a generated secret header), ipAllowlist (CIDRs or addresses let in without credentials, e.g. a crawler's static egress IP). " +
    "Send ONLY the settings that change. For a searchVIU dev crawl: basic auth (dev_auth_type PW) or the crawler's egress IP (dev_auth_type IP). " +
    "At least one mode must stay on. Read the current settings with get_staging_access first. Never invent an IP address — take it from the operator. " +
    "Applies on the gateway within seconds after approval; a newly enabled basic-auth password or header value is read with get_staging_access({includeCredentials: true}) when the operator asks for it. If get_staging_access says nothing is staged, the host serves nothing until stage_changes.",
  schema: proposeStagingAccessInput,
  summarize: (_input, preview) => String(preview.summary ?? "staging access change"),
});

export const proposeRotateStagingCredentialsTool = makeProposeTool({
  toolName: "propose_rotate_staging_credentials",
  opName: "owner_settings.propose_rotate_staging_credentials",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose replacing the staging crawler credentials (which: basic-auth, header or both). " +
    "ONLY when the operator asks or a credential may have leaked: every crawler/tool using the old value is locked out until it gets the new one, and the old value cannot be restored. " +
    "Give the reason in `reason`; it is shown on the approval. You never see the new value unless the Owner asks for it via get_staging_access.",
  schema: proposeRotateStagingCredentialsInput,
  summarize: (_input, preview) => String(preview.summary ?? "rotate staging credentials"),
});

export const proposeSetStagingHostTool = makeProposeTool({
  toolName: "propose_set_staging_host",
  opName: "owner_settings.propose_set_staging_host",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose moving the protected staging site to another host (default staging.<domain>; any FQDN the operator names, also on another domain, e.g. preview.example.com). " +
    "ONLY when the operator asks for a different staging host. Never the live or admin host. Read the current host with get_staging_access first. " +
    "After approval: the operator maps the host with `cms-provision staging-domain enable --staging-domain <host>` (DNS record + certificate; that command also sets the host itself, so if the operator runs it you need no proposal), and NOTHING is served at the new host until the next Stage — call stage_changes once the work is ready, and tell the operator both steps.",
  schema: proposeSetStagingHostInput,
  summarize: (_input, preview) => String(preview.summary ?? "staging host change"),
});
