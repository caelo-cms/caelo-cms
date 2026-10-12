// SPDX-License-Identifier: MPL-2.0

/**
 * DNS diagnostics — the AI's side of the two "Verify" buttons in the
 * Owner panel:
 *
 *   - `verify_domains`      → `domains.verify` per registered domain
 *     (/security/domains: "does this hostname resolve yet?", refreshes the
 *     domain's last-verified stamp + provisional TLS status).
 *   - `verify_dns_records`  → `dns.verify_record` per required record
 *     (/security/dns: "is the exact record the provisioner asked for —
 *     CNAME / TXT / A — published at the registrar?"). Defaults to the
 *     records stored in `provisioning_outputs`, so the AI checks the right
 *     values without the operator reading them out.
 *
 * Two tools because they answer different questions about different rows:
 * a domain can resolve (verify_domains: ok) while the certificate's TXT
 * challenge record is still missing (verify_dns_records: pending).
 * Both are read-only lookups. `dns.verify_record` limits AI lookups to
 * site-owned hostnames at the op (an arbitrary hostname would be a DNS
 * exfil channel), on top of its internal/reserved-suffix denylist.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";
import { hostingStatusSection } from "./domain-hosting-status.js";

const MAX_DOMAINS = 20;
const MAX_RECORDS = 50;

const verifyDomainsInput = z
  .object({
    hostnames: z
      .array(z.string().min(1).max(253))
      .min(1)
      .max(MAX_DOMAINS)
      .optional()
      .describe("Hostnames to check (as shown by list_domains). Omit to check every domain."),
  })
  .strict();

type VerifyDomainsInput = z.infer<typeof verifyDomainsInput>;

interface DomainRow {
  readonly id: string;
  readonly hostname: string;
  readonly kind: string;
}

export const verifyDomainsTool: ToolDefinitionWithHandler<VerifyDomainsInput> = {
  name: "verify_domains",
  description:
    "Check whether the site's registered domains resolve in DNS yet (A/AAAA lookup) and refresh each domain's verification stamp + provisional TLS status. " +
    "Use after the operator says they updated DNS, after a `propose_add_domain` was approved, or when a domain shows TLS 'unknown'/'pending' in `list_domains`. Omit `hostnames` to check all domains at once. " +
    "On Firebase Hosting installs the result also carries each hosting custom domain's live state; a domain reported 'stuck' is healed with `propose_reconnect_domain`. " +
    "Read-only diagnostics — safe to call any time. 'not resolved' usually means the registrar change has not propagated yet (minutes to hours); report it instead of retrying in a loop. " +
    "To check the exact records the installer asked for (CNAME/TXT values), use `verify_dns_records`.",
  schema: verifyDomainsInput,
  handler: async (ctx, input, toolCtx) => {
    const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "domains.list", {});
    if (!listed.ok) {
      return { ok: false, content: `domains.list failed: ${describeError(listed.error)}` };
    }
    const all = (listed.value as { domains: DomainRow[] }).domains;
    if (all.length === 0) {
      const hosting = await hostingStatusSection(ctx, toolCtx);
      if (hosting) {
        return {
          ok: true,
          content: `No domains are registered in Caelo's domain list (the hosting custom domains below come from the installer).\n\n${hosting}`,
        };
      }
      return {
        ok: false,
        content:
          "No domains are registered, so there is nothing to verify. Add one with propose_add_domain.",
      };
    }
    let targets: DomainRow[];
    if (input.hostnames) {
      const wanted = new Set(input.hostnames.map((h) => h.toLowerCase().replace(/\.$/, "")));
      targets = all.filter((d) => wanted.has(d.hostname.toLowerCase()));
      const unknown = [...wanted].filter(
        (h) => !targets.some((d) => d.hostname.toLowerCase() === h),
      );
      if (unknown.length > 0) {
        return {
          ok: false,
          content: `Not registered domains: ${unknown.join(", ")}. Registered: ${all.map((d) => d.hostname).join(", ")}. Pass hostnames from that list (or omit hostnames to check all).`,
        };
      }
    } else {
      targets = all.slice(0, MAX_DOMAINS);
    }

    const lines: string[] = [];
    let failures = 0;
    for (const d of targets) {
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "domains.verify", {
        domainId: d.id,
      });
      if (!r.ok) {
        failures += 1;
        lines.push(`${d.hostname} (${d.kind}): check failed — ${describeError(r.error)}`);
        continue;
      }
      const v = r.value as { a: string[]; aaaa: string[]; resolved: boolean };
      const addrs = [...v.a, ...v.aaaa];
      lines.push(
        v.resolved
          ? `${d.hostname} (${d.kind}): resolves → ${addrs.join(", ")}`
          : `${d.hostname} (${d.kind}): not resolved yet (no A/AAAA records visible)`,
      );
    }
    const truncated =
      !input.hostnames && all.length > MAX_DOMAINS
        ? `\n# ${MAX_DOMAINS} of ${all.length} domains checked — pass hostnames to check the rest.`
        : "";
    const hosting = await hostingStatusSection(ctx, toolCtx);
    return {
      ok: failures < targets.length,
      content: `${lines.join("\n")}${truncated}${hosting ? `\n\n${hosting}` : ""}`,
    };
  },
};

const dnsRecordInput = z
  .object({
    hostname: z.string().min(1).max(253),
    type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
    expectedValue: z.string().min(1).max(2000),
  })
  .strict();

const verifyDnsRecordsInput = z
  .object({
    records: z
      .array(dnsRecordInput)
      .min(1)
      .max(MAX_RECORDS)
      .optional()
      .describe(
        "Records to check. Omit to check every record the installer stored as required for this site (the usual case).",
      ),
    environment: z
      .enum(["dev", "staging", "production"])
      .optional()
      .describe("When records is omitted: only the required records of this environment."),
  })
  .strict();

type VerifyDnsRecordsInput = z.infer<typeof verifyDnsRecordsInput>;

interface RequiredRecord {
  readonly hostname: string;
  readonly type: "A" | "AAAA" | "CNAME" | "TXT";
  readonly value: string;
  readonly purpose: string;
}

export const verifyDnsRecordsTool: ToolDefinitionWithHandler<VerifyDnsRecordsInput> = {
  name: "verify_dns_records",
  description:
    "Check that specific DNS records are published with the expected value — status per record: ok | pending (nothing published yet / propagating) | mismatch (a different value is published). " +
    "Omit `records` to check every record the installer stored as REQUIRED for this site (A/CNAME for the site and admin, TXT for certificate validation); the result names each record's purpose so you can tell the operator exactly which one to add or fix at their registrar. " +
    "Use when the site or a certificate is not coming up, or after the operator says they changed DNS. Read-only. Explicit `records` must be on this site's own domains (registered domains, the base-URL host, the installer's records, or their subdomains) — other hostnames are refused. " +
    "For a quick 'does the domain resolve at all' check of registered domains, use `verify_domains`.",
  schema: verifyDnsRecordsInput,
  handler: async (ctx, input, toolCtx) => {
    let records: (z.infer<typeof dnsRecordInput> & { purpose?: string })[];
    if (input.records) {
      records = input.records;
    } else {
      const outputs = await execute(
        toolCtx.registry,
        toolCtx.adapter,
        ctx,
        "provisioning_outputs.get",
        input.environment ? { environment: input.environment } : {},
      );
      if (!outputs.ok) {
        return {
          ok: false,
          content: `provisioning_outputs.get failed: ${describeError(outputs.error)}`,
        };
      }
      const rows = (outputs.value as { rows: { dnsRecordsRequired: RequiredRecord[] }[] }).rows;
      const seen = new Set<string>();
      records = [];
      for (const row of rows) {
        for (const rec of row.dnsRecordsRequired) {
          const key = `${rec.hostname}|${rec.type}|${rec.value}`;
          if (seen.has(key)) continue;
          seen.add(key);
          records.push({
            hostname: rec.hostname,
            type: rec.type,
            expectedValue: rec.value,
            purpose: rec.purpose,
          });
        }
      }
      if (records.length === 0) {
        return {
          ok: true,
          content:
            "The installer stored no required DNS records for this site (self-hosted or DNS managed by the cloud provider). Pass `records` explicitly to check specific ones.",
        };
      }
      records = records.slice(0, MAX_RECORDS);
    }

    const lines: string[] = [];
    let failures = 0;
    for (const rec of records) {
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "dns.verify_record", {
        hostname: rec.hostname,
        type: rec.type,
        expectedValue: rec.expectedValue,
      });
      const label = `${rec.type} ${rec.hostname}${rec.purpose ? ` (${rec.purpose})` : ""}`;
      if (!r.ok) {
        failures += 1;
        lines.push(`${label}: error — ${describeError(r.error)}`);
        continue;
      }
      const v = r.value as {
        status: "ok" | "pending" | "mismatch" | "error";
        observed: string[];
        message: string | null;
      };
      const detail =
        v.status === "ok"
          ? `= ${rec.expectedValue}`
          : v.status === "mismatch"
            ? `expected ${rec.expectedValue}, published ${v.observed.join(", ")}`
            : `expected ${rec.expectedValue}${v.message ? ` — ${v.message}` : ""}`;
      lines.push(`${label}: ${v.status} ${detail}`);
    }
    return { ok: failures < records.length, content: lines.join("\n") };
  },
};
