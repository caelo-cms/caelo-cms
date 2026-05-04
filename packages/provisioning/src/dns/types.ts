// SPDX-License-Identifier: MPL-2.0

/**
 * Shared DNS-adapter interface. Every adapter (Cloudflare / Route53 /
 * Cloud DNS / manual) implements `applyRecords` end-to-end: takes the
 * desired records, makes them real (via API or operator paste), and
 * resolves only when public DNS lookups succeed.
 */

export interface DnsRecord {
  hostname: string;
  type: "A" | "AAAA" | "CNAME" | "TXT";
  value: string;
  ttl?: number;
}

export interface DnsAdapter {
  /** Human-readable name shown in wizard output. */
  readonly name: string;

  /**
   * Make the records exist + verify they resolve. Resolves when
   * `dig <hostname> <type>` returns the expected value globally.
   * Throws on terminal failure (operator should fix + re-run).
   */
  applyRecords(records: DnsRecord[]): Promise<void>;
}
