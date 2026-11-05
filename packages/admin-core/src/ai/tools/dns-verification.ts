// SPDX-License-Identifier: MPL-2.0

/**
 * DNS diagnostics — the AI's side of the two "Verify" buttons in the
 * Owner panel:
 *
 *   - `verify_domains`      → `domains.verify` per registered domain
 *     (/settings/domains: "does this hostname resolve yet?", refreshes the
 *     domain's last-verified stamp + provisional TLS status).
 *   - `verify_dns_records`  → `dns.verify_record` per required record
 *     (/settings/dns: "is the exact record the provisioner asked for —
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
import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import { readStagingHostDns } from "../../deploy/staging-host-dns.js";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";
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
      .describe("As shown by `list_domains`. Omit for all."),
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
    "Check whether registered domains resolve (A/AAAA); refreshes verification stamp + provisional TLS status. Read-only.\n" +
    "USE FOR: after DNS changes, an approved `propose_add_domain`, or TLS 'unknown'/'pending' in `list_domains`.\n" +
    "DO NOT USE FOR: exact installer records (CNAME/TXT values) -> `verify_dns_records`.\n" +
    "'stuck' (Firebase Hosting) -> `propose_reconnect_domain`. 'not resolved' = usually still propagating (minutes-hours): report it, don't retry in a loop.",
  schema: verifyDomainsInput,
  handler: async (ctx, input, toolCtx) => {
    const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "domains.list", {});
    if (!listed.ok) {
      return toolError(listed.error, `domains.list failed: ${describeError(listed.error)}`);
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
        "Omit (usual) = every record the install requires (site/admin A|CNAME, certificate TXT, staging host); result names each record's purpose -> tell the operator what to add/fix at the registrar. Explicit records only on the site's own domains (registered, base-URL host, installer records, their subdomains).",
      ),
    environment: z
      .enum(["dev", "staging", "production"])
      .optional()
      .describe("With `records` omitted: only this environment's records."),
  })
  .strict();

type VerifyDnsRecordsInput = z.infer<typeof verifyDnsRecordsInput>;

interface RequiredRecord {
  readonly hostname: string;
  readonly type: "A" | "AAAA" | "CNAME" | "TXT";
  readonly value: string;
  readonly purpose: string;
}

function recordKey(r: { hostname: string; type: string; expectedValue: string }): string {
  return `${r.hostname}|${r.type}|${r.expectedValue}`;
}

/**
 * The records the staging host needs right now (`readStagingHostDns`, what
 * Settings → Updates shows), or a line saying why there is nothing to check.
 * Empty on a host whose DNS already points at the staging site.
 *
 * @param read - {@link readStagingHostDns}, replaced in tests
 */
export async function stagingHostRecords(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  read: typeof readStagingHostDns = readStagingHostDns,
): Promise<{
  records: (z.infer<typeof dnsRecordInput> & { purpose: string })[];
  note: string | null;
}> {
  const access = await execute(toolCtx.registry, toolCtx.adapter, ctx, "staging_access.get", {});
  if (!access.ok) {
    return {
      records: [],
      note: `Staging host: could not read it — ${describeError(access.error)}`,
    };
  }
  const url = (access.value as { stagingUrl: string | null }).stagingUrl;
  if (!url) return { records: [], note: null };
  const siteUrl = process.env.CAELO_SITE_URL;
  const dns = await read(new URL(url).host, siteUrl ? new URL(siteUrl).host : "");
  switch (dns.kind) {
    case "records":
      return {
        records: dns.records.map((r) => ({
          hostname: r.name,
          type: r.type as z.infer<typeof dnsRecordInput>["type"],
          expectedValue: r.value,
          purpose: "staging host",
        })),
        note: null,
      };
    case "same-as-site":
      return {
        records: [],
        note: `Staging host ${dns.host}: needs the same address as ${dns.sameAs}.`,
      };
    case "unavailable":
      return {
        records: [],
        note: `Staging host ${dns.host}: its records could not be read — ${dns.reason}.`,
      };
    case "unsupported":
      return { records: [], note: null };
  }
}

export const verifyDnsRecordsTool: ToolDefinitionWithHandler<VerifyDnsRecordsInput> = {
  name: "verify_dns_records",
  description:
    "Check DNS records carry the expected value: ok | pending (unpublished/propagating) | mismatch (other value). Read-only.\n" +
    "USE FOR: site or certificate not coming up; after the operator changed DNS.\n" +
    "DO NOT USE FOR: a quick 'does it resolve' check of registered domains -> `verify_domains`.",
  schema: verifyDnsRecordsInput,
  handler: async (ctx, input, toolCtx) => {
    let records: (z.infer<typeof dnsRecordInput> & { purpose?: string })[];
    /** What the staging host needs when no record can say it (see below). */
    let stagingNote: string | null = null;
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
        return toolError(
          outputs.error,
          `provisioning_outputs.get failed: ${describeError(outputs.error)}`,
        );
      }
      const rows = (outputs.value as { rows: { dnsRecordsRequired: RequiredRecord[] }[] }).rows;
      const seen = new Set<string>();
      records = [];
      for (const row of rows) {
        for (const rec of row.dnsRecordsRequired) {
          const key = recordKey({ ...rec, expectedValue: rec.value });
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
      // #1455 — the staging host's records are not stack outputs: on
      // gcp-firebase Hosting works them out when an update adds the host.
      const staging = await stagingHostRecords(ctx, toolCtx);
      records.push(...staging.records.filter((r) => !seen.has(recordKey(r))));
      stagingNote = staging.note;
      if (records.length === 0) {
        if (stagingNote) return { ok: true, content: stagingNote };
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
    if (stagingNote) lines.push(stagingNote);
    return { ok: failures < records.length, content: lines.join("\n") };
  },
};
