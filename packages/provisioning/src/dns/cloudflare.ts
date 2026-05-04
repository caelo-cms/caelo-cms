// SPDX-License-Identifier: MPL-2.0

/**
 * Cloudflare DNS adapter — zero-touch via the Cloudflare API.
 * Uses the public REST API directly (no SDK) so the Caelo install
 * doesn't carry the cloudflare-sdk's transitive dependency tree.
 *
 * Auth: CLOUDFLARE_API_TOKEN env var. Token scope needed:
 *   Zone:DNS:Edit on the target zone
 * (Read-only Zone:Zone:Read is enough for `detectCloudflareAuth`.)
 *
 * Records are upserted — repeated runs are idempotent. Each CREATE
 * is followed by a public-DNS poll to verify the change is visible
 * (Cloudflare propagates within ~60s typically).
 */

import { promises as dns } from "node:dns";
import { setTimeout as sleep } from "node:timers/promises";
import { log, spinner } from "@clack/prompts";
import { dim, green, red } from "kleur/colors";
import type { DnsAdapter, DnsRecord } from "./types.js";

const CF_API = "https://api.cloudflare.com/client/v4";

export async function detectCloudflareAuth(): Promise<{ token: string | null }> {
  const token = process.env["CLOUDFLARE_API_TOKEN"] ?? null;
  if (!token) return { token: null };
  // Verify the token resolves (cheap HEAD-style call).
  try {
    const r = await fetch(`${CF_API}/user/tokens/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { token: null };
    return { token };
  } catch {
    return { token: null };
  }
}

interface CfZone {
  id: string;
  name: string;
}

async function findZoneId(token: string, domain: string): Promise<string | null> {
  // Try the apex first, then walk up subdomains until we hit a zone.
  // (e.g. caelo-cms.com → caelo-cms.com)
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    const r = await fetch(`${CF_API}/zones?name=${encodeURIComponent(candidate)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) continue;
    const body = (await r.json()) as { result?: CfZone[] };
    if (body.result && body.result.length > 0) return body.result[0]?.id ?? null;
  }
  return null;
}

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

async function existingRecord(
  token: string,
  zoneId: string,
  hostname: string,
  type: string,
): Promise<CfRecord | null> {
  const r = await fetch(
    `${CF_API}/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(hostname)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) return null;
  const body = (await r.json()) as { result?: CfRecord[] };
  return body.result?.[0] ?? null;
}

async function upsertRecord(
  token: string,
  zoneId: string,
  record: DnsRecord,
): Promise<void> {
  const existing = await existingRecord(token, zoneId, record.hostname, record.type);
  const body = {
    type: record.type,
    name: record.hostname,
    content: record.value,
    ttl: record.ttl ?? 1, // 1 = auto in Cloudflare
    proxied: false, // Caelo expects raw A records hitting GCP LB IP, not Cloudflare's proxy
  };
  if (existing) {
    if (existing.content === record.value) return; // already correct
    const r = await fetch(`${CF_API}/zones/${zoneId}/dns_records/${existing.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Cloudflare PUT ${record.hostname}: ${r.status} ${await r.text()}`);
    return;
  }
  const r = await fetch(`${CF_API}/zones/${zoneId}/dns_records`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Cloudflare POST ${record.hostname}: ${r.status} ${await r.text()}`);
}

export function makeCloudflareAdapter(opts: {
  domain: string;
  apiToken: string;
}): DnsAdapter {
  return {
    name: `Cloudflare (zero-touch via API)`,
    async applyRecords(records: DnsRecord[]): Promise<void> {
      const s = spinner();
      s.start(`Locating Cloudflare zone for ${opts.domain}...`);
      const zoneId = await findZoneId(opts.apiToken, opts.domain);
      if (!zoneId) {
        s.stop(red(`No Cloudflare zone found containing ${opts.domain}.`));
        throw new Error(
          `Domain ${opts.domain} isn't in your Cloudflare account. Add it as a zone first, or unset CLOUDFLARE_API_TOKEN to use the manual paste flow.`,
        );
      }
      s.stop(green(`Cloudflare zone ${dim(zoneId)} found`));

      for (const record of records) {
        const s2 = spinner();
        s2.start(`Upserting ${record.type} ${record.hostname} → ${record.value}...`);
        try {
          await upsertRecord(opts.apiToken, zoneId, record);
        } catch (e) {
          s2.stop(red(`Failed: ${e instanceof Error ? e.message : String(e)}`));
          throw e;
        }
        s2.stop(green(`${record.type} ${record.hostname} set`));
      }

      // Quick public-DNS poll — Cloudflare usually propagates within
      // ~60s. We give 5 min before giving up + telling the operator
      // to verify manually.
      const s3 = spinner();
      s3.start("Verifying public DNS resolution...");
      const start = Date.now();
      const remaining = new Set(records.map((r) => `${r.type}:${r.hostname}`));
      while (remaining.size > 0 && Date.now() - start < 5 * 60 * 1000) {
        for (const key of [...remaining]) {
          const record = records.find((r) => `${r.type}:${r.hostname}` === key);
          if (!record) {
            remaining.delete(key);
            continue;
          }
          if (await checkRecord(record)) remaining.delete(key);
        }
        if (remaining.size > 0) await sleep(5000);
      }
      if (remaining.size > 0) {
        s3.stop(red(`Some records still unresolved: ${[...remaining].join(", ")}`));
        log.error(
          `Cloudflare API succeeded but public DNS doesn't reflect the change yet. Wait + verify with \`dig\` then re-run.`,
        );
        throw new Error("DNS verify timeout.");
      }
      s3.stop(green("All records resolve publicly."));
    },
  };
}

async function checkRecord(record: DnsRecord): Promise<boolean> {
  try {
    if (record.type === "A") {
      const result = await dns.resolve4(record.hostname);
      return result.includes(record.value);
    }
    if (record.type === "CNAME") {
      const result = await dns.resolveCname(record.hostname);
      const expected = record.value.replace(/\.$/, "");
      return result.some((v) => v.replace(/\.$/, "") === expected);
    }
    return true; // AAAA + TXT — assume Cloudflare API success means it's there
  } catch {
    return false;
  }
}
