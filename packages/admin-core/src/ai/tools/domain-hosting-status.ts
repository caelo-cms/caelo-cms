// SPDX-License-Identifier: MPL-2.0

/**
 * The Firebase Hosting side of `list_domains` / `verify_domains`.
 *
 * On a gcp-firebase install the hostname visitors reach is a Firebase
 * Hosting custom domain, and whether it serves is Firebase's call — not
 * the `domains` table's TLS column. Both domain tools append the live
 * state from `domains.hosting_status`, so the agent sees a stuck domain
 * ("stuck — reconnect recommended") without the operator having to
 * notice the site is down, and proposes `propose_reconnect_domain` on its
 * own. Nothing is appended on other providers.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { CustomDomainHealth } from "../../deploy/firebase-custom-domain-health.js";
import { describeError } from "./_describe-error.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";

interface HostingStatus {
  readonly supported: boolean;
  readonly domains: readonly CustomDomainHealth[];
  readonly cdnPurge: { versionName: string; hostnames: string[] } | null;
  readonly error: string | null;
}

/** Render the hosting status; empty string when the provider has none. */
export function formatHostingStatus(s: HostingStatus): string {
  if (!s.supported) return "";
  const lines = ["## Firebase Hosting custom domains (what visitors actually reach)"];
  if (s.error) {
    lines.push(`Status unavailable: ${s.error}`);
    return lines.join("\n");
  }
  if (s.domains.length === 0) {
    lines.push("No custom domains on the Firebase Hosting site.");
  }
  for (const d of s.domains) {
    lines.push(`${d.hostname}: ${d.summary}`);
    if (d.status === "stuck") {
      lines.push(
        `  → call propose_reconnect_domain {"hostname":"${d.hostname}"} — the operator approves, Caelo re-creates the domain and clears the CDN cache once it is active.`,
      );
    }
  }
  if (s.cdnPurge) {
    lines.push(
      `CDN cache cleared: ${s.cdnPurge.hostnames.join(", ")} became active after the last publish, so the live version was re-released — visitors no longer get a cached "Site Not Found" page.`,
    );
  }
  return lines.join("\n");
}

/** `domains.hosting_status` rendered for a tool result ("" when not applicable). */
export async function hostingStatusSection(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
): Promise<string> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "domains.hosting_status", {});
  if (!r.ok) {
    return `## Firebase Hosting custom domains\nStatus unavailable: domains.hosting_status failed: ${describeError(r.error)}`;
  }
  return formatHostingStatus(r.value as HostingStatus);
}

/** Append the hosting status to a domain tool's successful result. */
export function withHostingStatus<I>(
  tool: ToolDefinitionWithHandler<I>,
): ToolDefinitionWithHandler<I> {
  return {
    ...tool,
    handler: async (ctx, input, toolCtx) => {
      const r = await tool.handler(ctx, input, toolCtx);
      if (!r.ok) return r;
      const section = await hostingStatusSection(ctx, toolCtx);
      return section ? { ...r, content: `${r.content}\n\n${section}` } : r;
    },
  };
}
