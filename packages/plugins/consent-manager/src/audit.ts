// SPDX-License-Identifier: MPL-2.0

/**
 * The consent-manager's Stage-audit findings (core's
 * `auditFindingsOperation`).
 *
 * A module whose vendor nobody has classified is left out of the built
 * page (see `consent_deferrals`), so without a finding a header that
 * vanished for every visitor would publish unnoticed. Each one is an
 * error: Publish live waits until someone decides. Site-wide rather than
 * per page, because the module is missing wherever it is placed and one
 * decision resolves it everywhere.
 */

import type { PluginAuditFinding } from "@caelo-cms/plugin-sdk";

/** What the audit needs to know about one module the render gate withholds. */
export interface WithheldEmbed {
  readonly moduleId: string;
  readonly moduleSlug: string;
  readonly siteChrome: boolean;
  readonly hosts: ReadonlyArray<string>;
  /** A consent category key, or `unclassified` while nobody has ruled. */
  readonly reason: string;
}

const MAX_HOSTS_SHOWN = 8;

/** Hosts for a finding message, capped so a module reaching dozens stays readable. */
function hostList(hosts: ReadonlyArray<string>): string {
  const shown = hosts.slice(0, MAX_HOSTS_SHOWN).join(", ");
  return hosts.length > MAX_HOSTS_SHOWN
    ? `${shown} and ${hosts.length - MAX_HOSTS_SHOWN} more`
    : shown;
}

/**
 * One blocking finding per unclassified module. Gated modules are fine:
 * they show the visitor a consent placeholder, which is the intended state.
 */
export function unreviewedEmbedFindings(
  withheld: ReadonlyArray<WithheldEmbed>,
): PluginAuditFinding[] {
  return withheld
    .filter((w) => w.reason === "unclassified")
    .map((w) => ({
      rule: "embed-not-reviewed",
      severity: "error",
      message:
        `External content not reviewed: module "${w.moduleSlug}" loads from ${hostList(w.hosts)}, and nobody has decided yet whether visitors must consent to that. ` +
        `Until then visitors get nothing in its place. ${w.siteChrome ? "It is site chrome, so every page is missing it" : "Every page it is placed on is missing it"}.`,
      fix: {
        tool: "classify_external_embed",
        hint: `Pin module ${w.moduleId} to the consent category its vendor needs, or allow it when the request identifies nobody; ask the operator if the vendor is unclear.`,
      },
    }));
}
