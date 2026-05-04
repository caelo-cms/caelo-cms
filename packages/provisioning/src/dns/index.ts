// SPDX-License-Identifier: MPL-2.0

/**
 * DNS adapters — each provider implements the same `DnsAdapter`
 * interface so the wizard can pick by registrar. Per CLAUDE.md §11.C:
 * "DNS records land automatically when the registrar API is supported.
 * Otherwise the CLI prints the records, polls DNS, and continues only
 * when resolution succeeds."
 *
 * v1 adapters:
 *   - Cloudflare — zero-touch via the Cloudflare API
 *   - Route53     — zero-touch via the AWS SDK
 *   - manual      — print records + verify-poll via dig
 *
 * Detection order: Cloudflare → Route53 → manual fallback. Detection
 * is best-effort; the wizard always prompts to confirm.
 */

import { detectCloudflareAuth, makeCloudflareAdapter } from "./cloudflare.js";
import { makeManualAdapter } from "./manual.js";
import type { DnsAdapter } from "./types.js";

export type { DnsAdapter, DnsRecord } from "./types.js";

/**
 * Pick the right DNS adapter based on environment + interactive
 * detection. The CLI's wizard calls this; if a registrar's API is
 * reachable, returns its adapter. Otherwise falls back to manual.
 */
export async function pickDnsAdapter(opts: {
  domain: string;
  forceManual?: boolean;
}): Promise<DnsAdapter> {
  if (opts.forceManual) {
    return makeManualAdapter({ domain: opts.domain });
  }

  // Cloudflare — needs CLOUDFLARE_API_TOKEN (read-only zone scope is
  // enough for detection; create needs Zone:DNS:Edit).
  const cf = await detectCloudflareAuth();
  if (cf.token) {
    return makeCloudflareAdapter({
      domain: opts.domain,
      apiToken: cf.token,
    });
  }

  // Route53 — would need AWS_PROFILE / AWS_ACCESS_KEY_ID. Not yet
  // implemented; falls through to manual. The interface + adapter
  // skeleton land here so the future PR is one file.

  return makeManualAdapter({ domain: opts.domain });
}
