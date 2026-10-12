// SPDX-License-Identifier: MPL-2.0

/**
 * Which install DNS records are safe to set right away, and which switch the
 * public website and so wait for go-live.
 *
 * An operator installing Caelo usually still runs a live site on the main
 * domain. The admin host, the staging host and verification TXT records are
 * new names nobody serves yet — set them now. An A / AAAA / CNAME record on
 * the main domain or `www.` repoints every visitor to Caelo, which serves an
 * empty site until the first publish: setting it during the install takes
 * the old site down. Those wait for go-live.
 */

/** A record as the stacks report it (`dnsRecordsRequiredOut`). */
export interface InstallDnsRecord {
  readonly hostname: string;
  readonly type: string;
  readonly value: string;
  readonly purpose?: string;
}

export interface DnsRecordGroups<R extends InstallDnsRecord> {
  /** Records for hosts no live site uses — set during the install. */
  readonly setNow: R[];
  /** Records that move the public site to Caelo — set at go-live only. */
  readonly atGoLive: R[];
}

const TRAFFIC_TYPES = new Set(["A", "AAAA", "CNAME"]);

function bare(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/** Whether `record` repoints the public site on `domain` (apex or www). */
export function switchesPublicSite(record: InstallDnsRecord, domain: string): boolean {
  const host = bare(record.hostname);
  const apex = bare(domain);
  return TRAFFIC_TYPES.has(record.type.toUpperCase()) && (host === apex || host === `www.${apex}`);
}

/** Split `records` into {@link DnsRecordGroups} for the install's `domain`. */
export function groupDnsRecords<R extends InstallDnsRecord>(
  records: readonly R[],
  domain: string,
): DnsRecordGroups<R> {
  const setNow: R[] = [];
  const atGoLive: R[] = [];
  for (const r of records) (switchesPublicSite(r, domain) ? atGoLive : setNow).push(r);
  return { setNow, atGoLive };
}

/** One printable line per record: `TYPE   host → value`. */
export function dnsRecordLine(r: InstallDnsRecord, hostWidth: number): string {
  return `  ${r.type.padEnd(6)} ${r.hostname.padEnd(hostWidth)} → ${r.value}`;
}

/**
 * The two labelled groups as text lines, for the installer's final summary.
 * An empty group is left out; the go-live group always carries its warning.
 */
export function formatDnsRecordGroups(
  groups: DnsRecordGroups<InstallDnsRecord>,
  domain: string,
): string[] {
  const width = Math.max(
    domain.length,
    ...[...groups.setNow, ...groups.atGoLive].map((r) => r.hostname.length),
  );
  const lines: string[] = [];
  if (groups.setNow.length > 0) {
    lines.push("Set now (new hosts, nothing live uses them):");
    for (const r of groups.setNow) lines.push(dnsRecordLine(r, width));
  }
  if (groups.atGoLive.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Only at go-live (these move ${domain} to Caelo):`);
    for (const r of groups.atGoLive) lines.push(dnsRecordLine(r, width));
    lines.push(
      `  Warning: setting these now takes a website that is live on ${domain} offline.`,
      "  Replace the existing records once you have published the new site.",
    );
  }
  return lines;
}
