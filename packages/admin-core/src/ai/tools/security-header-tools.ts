// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1454 — the AI's surface for the site's response headers: a read
 * open to it, and one gated write (ops/security_headers.ts,
 * docs/dev/site-security-headers.md).
 */

import { ENFORCE_EVIDENCE_NOTE, NO_BUILD_HEADERS_NOTE } from "@caelo-cms/shared";
import { z } from "zod";
import {
  proposeSecurityHeadersInput,
  type securityHeadersOutput,
} from "../../ops/security_headers.js";
import { makeProposeTool } from "./_make-propose-tool.js";
import { makeReadTool } from "./_make-read-tool.js";

type Value = z.infer<typeof securityHeadersOutput>;

function headerLines(label: string, served: Value["staged"], stageHint: string): string[] {
  if (served === null) return [`${label}: ${stageHint}`];
  const lines = Object.entries(served.headers).map(([k, v]) => `  ${k}: ${v}`);
  if (served.cspCut) lines.push("  (the full CSP did not fit a header; parts were left out)");
  return [`${label}:`, ...lines];
}

/** Render `security_headers.get` for the model. Exported for tests. */
export function formatSecurityHeaders(v: Value): string {
  const p = v.policy;
  const extra = Object.entries(p.extraSources)
    .map(([kind, list]) => `${kind}: ${(list ?? []).join(" ")}`)
    .join("; ");
  const derived = Object.entries(v.derivedOrigins)
    .map(([kind, list]) => `${kind}: ${(list ?? []).join(" ")}`)
    .join("; ");
  return [
    `Host: ${v.host.provider}. ${v.host.note}`,
    ...(v.host.served ? [] : ["Headers cannot be served here, so changes are refused."]),
    `Policy: CSP ${p.cspMode}; frameAncestors [${p.frameAncestors.join(" ")}]; referrer ${p.referrerPolicy}; allowedFeatures [${p.allowedFeatures.join(" ")}]; HSTS ${v.host.hostSendsHsts ? "sent by the host" : `max-age ${p.hsts.maxAgeSeconds}`}; extraSources {${extra}}`,
    ...headerLines("Staging sends", v.staged, NO_BUILD_HEADERS_NOTE),
    ...headerLines("Live sends", v.live, NO_BUILD_HEADERS_NOTE),
    `Derived from the staged build: ${derived || "no third-party origins"}; ${v.inlineScriptHashes} inline script hash(es).`,
    ...v.plugins.map(
      (x) =>
        `Plugin ${x.slug} added ${x.origins.join(" ") || "no origin"} and ${x.inlineScripts} inline script(s).`,
    ),
    v.enforceBlockers.length > 0
      ? `Enforcing would stop: ${v.enforceBlockers.join("; ")}`
      : "Nothing in the staged markup stops enforcing. Runtime loads on audited pages show as report-only violations in the Stage's quality check.",
    ENFORCE_EVIDENCE_NOTE,
    ...(v.stageNeeded
      ? ["The saved policy is newer than the staged build: Stage to apply it."]
      : []),
  ].join("\n");
}

export const getSecurityHeadersTool = makeReadTool({
  name: "get_security_headers",
  description:
    "Read the site's response-header policy and the headers staging and the live site send now (CSP, Referrer-Policy, Permissions-Policy, framing, HSTS), what the build derived and which plugin added what.\n" +
    "USE FOR: a security scan names a missing header; a script, embed or frame is blocked; before `propose_set_security_headers`.",
  opName: "security_headers.get",
  input: z.object({}).strict(),
  format: (value) => formatSecurityHeaders(value as Value),
});

export const proposeSetSecurityHeadersTool = makeProposeTool({
  toolName: "propose_set_security_headers",
  opName: "owner_settings.propose_set_security_headers",
  pendingQueuePath: "/settings/owner-settings/pending",
  approvalPreviewOp: "security_headers.preview_set",
  when:
    "Change the site's response-header policy; only the named settings change. The build derives each CSP from what it ships (origins in markup, approved tags and embeds, inline hashes), so a host used in a page needs no entry.\n" +
    "USE FOR: `extraSources` when a Stage finding names a host and this tool as the next step; `frameAncestors` when another site must embed this one; `cspMode` when the operator decides to enforce.\n" +
    "DO NOT USE FOR: allowing an embed or tag for visitors -> consent tools; turning off a blocker -> move the handler into module `js`.\n" +
    "CORE RULES: read `get_security_headers` first. Patch fields replace, so `extraSources` carries every entry to keep. Propose `enforce` only when it lists nothing that enforcing would stop and the Stage's quality check shows no CSP violation, and tell the operator what that rests on: the check opens a few pages and gives no consent, so a violation elsewhere or after consent reaches nobody and is blocked for visitors. After approval it is saved, not live: offer the Stage; Publish live stays the operator's.",
  schema: proposeSecurityHeadersInput,
  summarize: (_input, preview) => String(preview.summary ?? "security headers change"),
});
