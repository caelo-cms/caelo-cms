// SPDX-License-Identifier: MPL-2.0

/**
 * The DNS records of the sending domain (issue #1337, epic #763 E12).
 *
 * A mail provider delivers for a domain only once its DNS proves the
 * provider may send for it (SPF, DKIM, a return-path MX). The operator
 * creates those records at their registrar; the admin shows which ones and
 * whether the provider found them, so the AI can walk the operator through
 * the setup without anyone opening the provider's dashboard.
 *
 * Resend only, the one transport implemented (transport.ts): its domains
 * API lists the domain's records with a status each, and verification is
 * started with one call and runs asynchronously.
 * https://resend.com/docs/api-reference/domains
 */

import { z } from "zod";

const RESEND_API = "https://api.resend.com";

const resendRecord = z.object({
  record: z.string().max(64),
  name: z.string().max(253),
  type: z.string().max(16),
  ttl: z.union([z.string(), z.number()]).optional(),
  status: z.string().max(32),
  value: z.string().max(4096),
  priority: z.number().int().optional(),
});

const resendDomain = z.object({
  id: z.string().max(64),
  name: z.string().max(253),
  status: z.string().max(32),
  records: z.array(resendRecord).max(32).optional(),
});

const resendDomainList = z.object({
  data: z.array(resendDomain.omit({ records: true })).max(100),
});

/** One DNS record the provider asks for. */
export interface SenderDnsRecord {
  readonly purpose: string;
  readonly type: string;
  readonly name: string;
  readonly value: string;
  readonly priority: number | null;
  /** The provider's status of this record (`verified`, `pending`, `not_started`, `failed`). */
  readonly status: string;
}

/** The sending domain as the provider sees it. */
export type SenderDomainStatus =
  | {
      readonly found: true;
      readonly domain: string;
      /** The provider's domain status (`verified`, `pending`, `not_started`, `failed`, …). */
      readonly status: string;
      readonly records: readonly SenderDnsRecord[];
      /** Whether this call asked the provider to check the records again. */
      readonly verificationStarted: boolean;
    }
  | { readonly found: false; readonly domain: string };

/** The domain of a from-address (`Name <a@b.c>` and `a@b.c` both give `b.c`). */
export function senderDomainOf(fromAddress: string): string {
  const bare = fromAddress.match(/<([^>]+)>/)?.[1] ?? fromAddress;
  return bare
    .slice(bare.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase();
}

/** A provider answer the caller should show as is (no key, no record). */
export class SenderDomainError extends Error {
  override readonly name = "SenderDomainError";
}

async function resendJson(
  fetchImpl: typeof fetch,
  apiKey: string,
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<unknown> {
  const res = await fetchImpl(`${RESEND_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new SenderDomainError(
      "Resend refused to list the domains: the API key may only send. Create a full-access key in Resend (or check the domain there), then save it at Settings → Email.",
    );
  }
  if (!res.ok) {
    throw new SenderDomainError(
      `Resend answered ${res.status} for ${method} ${path.split("/")[1]}`,
    );
  }
  return res.json();
}

/**
 * The records and status of `domain` at Resend. With `verify`, asks
 * Resend to check the records again first (it does so asynchronously; read
 * again after a minute).
 */
export async function resendSenderDomain(opts: {
  readonly apiKey: string;
  readonly domain: string;
  readonly verify: boolean;
  readonly fetchImpl?: typeof fetch;
}): Promise<SenderDomainStatus> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const list = resendDomainList.parse(
    await resendJson(fetchImpl, opts.apiKey, "/domains?limit=100"),
  );
  const match = list.data.find((d) => d.name.toLowerCase() === opts.domain);
  if (!match) return { found: false, domain: opts.domain };
  const id = encodeURIComponent(match.id);
  if (opts.verify) await resendJson(fetchImpl, opts.apiKey, `/domains/${id}/verify`, "POST");
  const domain = resendDomain.parse(await resendJson(fetchImpl, opts.apiKey, `/domains/${id}`));
  return {
    found: true,
    domain: domain.name,
    status: domain.status,
    verificationStarted: opts.verify,
    records: (domain.records ?? []).map((r) => ({
      purpose: r.record,
      type: r.type,
      name: r.name,
      value: r.value,
      priority: r.priority ?? null,
      status: r.status,
    })),
  };
}
