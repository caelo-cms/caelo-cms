// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1454 — turn a CSP violation the Stage's Lighthouse run saw into the
 * exact next step, so the AI fixes it without asking the operator.
 *
 * The two modes reach the audit differently (measured with real Chromium and
 * the repo's runner, 2026-11-05):
 *
 * - **Report-only:** no console error. Chrome files a DevTools issue, which
 *   fails `inspector-issues` (Best Practices, weight 1). That audit's table
 *   names only the blocked URL, not the directive, so the session reads the
 *   `InspectorIssues` artifact, which has both ({@link cspIssueElements}).
 * - **Enforced:** a console error, which fails `errors-in-console` and
 *   `inspector-issues` ({@link withCspNextStep} on the console entry).
 */

import type { CspSourceKind } from "@caelo-cms/shared";
import type { FlaggedElement } from "./ratchet.js";

/** The fields of a CDP `ContentSecurityPolicyIssueDetails` this file reads. */
export interface CspIssue {
  /** Absent for an inline script, an inline handler or eval. */
  readonly blockedURL?: string;
  readonly violatedDirective: string;
  readonly isReportOnly?: boolean;
}

const KIND_OF_DIRECTIVE: Readonly<Record<string, CspSourceKind>> = {
  "script-src": "script",
  "script-src-elem": "script",
  "style-src": "style",
  "style-src-elem": "style",
  "img-src": "img",
  "font-src": "font",
  "connect-src": "connect",
  "frame-src": "frame",
  "child-src": "frame",
  "media-src": "media",
  "form-action": "form",
};

/** The next step for a blocked resource. */
export function cspNextStep(blockedUrl: string | null, directive: string): string {
  const kind = KIND_OF_DIRECTIVE[directive];
  let url: URL | null = null;
  try {
    url = blockedUrl ? new URL(blockedUrl) : null;
  } catch {
    url = null;
  }
  if (url === null) {
    return `Next step: this is inline code ${directive} does not allow: move it into the module's \`js\` with update_modules_many, then Stage again.`;
  }
  if (kind === undefined) {
    return `Next step: ${directive} takes no extra source; remove what loads ${url.origin} from the module, then Stage again.`;
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:") {
    return `Next step: only https or wss sources can be allowed: load it from an https address in the module, then Stage again.`;
  }
  return `Next step: read get_security_headers, then propose_set_security_headers with ${url.origin} added to \`extraSources.${kind}\` (send the entries it already lists too), then Stage again.`;
}

/**
 * The flagged rows of the `inspector-issues` audit: one per blocked origin
 * and directive.
 */
export function cspIssueElements(issues: readonly CspIssue[]): FlaggedElement[] {
  const rows = new Map<string, FlaggedElement>();
  for (const issue of issues) {
    const blocked = issue.blockedURL ?? null;
    let origin = blocked ?? "inline code";
    try {
      if (blocked) origin = new URL(blocked).origin;
    } catch {
      origin = blocked ?? "inline code";
    }
    const key = `${origin} ${issue.violatedDirective}`;
    if (rows.has(key)) continue;
    const mode = issue.isReportOnly ? "Report-only CSP violation" : "CSP violation";
    rows.set(key, {
      explanation: `${mode}: ${origin} is outside ${issue.violatedDirective}. ${cspNextStep(blocked, issue.violatedDirective)}`,
      ...(blocked ? { url: blocked } : {}),
    });
  }
  return [...rows.values()];
}

const CONSOLE_VIOLATION_RE =
  /'([^']+)' violates the following Content Security Policy directive: "([a-z-]+)|load the [a-z]+ '([^']+)' because it violates the following Content Security Policy directive: "([a-z-]+)/;

/** `message` with the next step, when it is a console CSP violation. */
export function withCspNextStep(message: string): string {
  const m = message.match(CONSOLE_VIOLATION_RE);
  if (!m) return message;
  const url = m[1] ?? m[3] ?? null;
  const directive = m[2] ?? m[4] ?? "";
  return `${message} ${cspNextStep(url, directive)}`;
}
