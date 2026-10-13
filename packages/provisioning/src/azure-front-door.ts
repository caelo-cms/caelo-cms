// SPDX-License-Identifier: MPL-2.0

/**
 * DNS records the Azure stack asks the operator's registrar to hold.
 *
 * The public site is served by Azure Front Door (CLAUDE.md §11.B Tier 1:
 * object storage + edge CDN + managed TLS, no compute on the request path),
 * so the primary domain points at the Front Door endpoint, and Front Door's
 * managed certificate needs the `_dnsauth` TXT record to prove domain
 * ownership before it issues.
 */

import type { DnsRecord } from "./adapter.js";

/** Inputs the Azure stack resolves from its Front Door resources. */
export interface AzureFrontDoorDnsInputs {
  /** The site's primary domain (`caelo-azure:domain`). */
  readonly domain: string;
  /** `AFDEndpoint.hostName`, e.g. `caelo-prod-abc123.z01.azurefd.net`. */
  readonly endpointHostName: string;
  /** `AFDCustomDomain.validationProperties.validationToken`. */
  readonly validationToken: string;
}

/**
 * The records for the primary domain: a CNAME to the Front Door endpoint and
 * the TXT record that validates the custom domain for its managed certificate.
 *
 * @throws when the endpoint hostname or validation token is empty — a record
 * pointing at nothing would read fine in the DNS guidance page and then fail
 * at the registrar (no fallbacks pre-1.0, CLAUDE.md §2).
 */
export function azureFrontDoorDnsRecords(input: AzureFrontDoorDnsInputs): DnsRecord[] {
  if (input.endpointHostName.length === 0) {
    throw new Error("azure-front-door: the Front Door endpoint has no hostName yet");
  }
  if (input.validationToken.length === 0) {
    throw new Error(
      `azure-front-door: the custom domain ${input.domain} has no validation token yet`,
    );
  }
  return [
    {
      hostname: input.domain,
      type: "CNAME",
      value: input.endpointHostName,
      purpose: "Primary domain → Azure Front Door endpoint (static site)",
    },
    {
      hostname: `_dnsauth.${input.domain}`,
      type: "TXT",
      value: input.validationToken,
      purpose: "Validates the primary domain for Front Door's managed TLS certificate",
    },
  ];
}
