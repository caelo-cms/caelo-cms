// SPDX-License-Identifier: MPL-2.0

/**
 * Firebase Hosting custom-domain ops (`CAELO_PROVIDER=gcp-firebase`).
 *
 *  domains.hosting_status     read — every Firebase custom domain of the
 *                             site with its health (active / dns_pending /
 *                             provisioning / stuck) and a one-line summary.
 *                             Also purges the CDN once after a domain turns
 *                             active (see firebase-custom-domain.ts): the
 *                             purge re-releases the version that is already
 *                             live, so no content changes.
 *  domains.reconnect_hosting  Owner — delete + re-create a custom domain
 *                             that is stuck. The AI reaches it through
 *                             propose_reconnect_domain (domains.propose_
 *                             reconnect → domains.execute_proposal).
 *
 * The Firebase custom domains are authoritative here, not the `domains`
 * table: the gcp-firebase stack creates the apex custom domain directly,
 * so it is usually not registered in `domains` at all.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  getCustomDomain,
  type HostingTarget,
  listCustomDomains,
  purgeCdnIfDomainsActivatedSinceLastRelease,
  reconnectCustomDomain,
  resolveHostingTarget,
} from "../deploy/firebase-custom-domain.js";
import {
  assessCustomDomain,
  type CustomDomainHealth,
  customDomainHostname,
} from "../deploy/firebase-custom-domain-health.js";

const FIREBASE_PROVIDER = "gcp-firebase";

function isFirebaseHostingInstall(): boolean {
  return process.env.CAELO_PROVIDER === FIREBASE_PROVIDER;
}

const healthSchema = z.object({
  hostname: z.string(),
  status: z.enum(["active", "dns_pending", "provisioning", "stuck", "deleted"]),
  hostState: z.string(),
  ownershipState: z.string(),
  certState: z.string(),
  dnsChanges: z.array(
    z.object({
      action: z.enum(["ADD", "REMOVE"]),
      type: z.string(),
      domainName: z.string(),
      rdata: z.string(),
    }),
  ),
  checkTime: z.string().nullable(),
  updateTime: z.string().nullable(),
  summary: z.string(),
});

const cdnPurgeSchema = z.object({
  versionName: z.string(),
  hostnames: z.array(z.string()),
});

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export const reconnectInput = z
  .object({
    hostname: z
      .string()
      .min(1)
      .max(253)
      .transform((s) => s.toLowerCase().trim().replace(/\.$/, ""))
      .refine((s) => HOSTNAME_RE.test(s), "must be a valid hostname"),
  })
  .strict();

export const reconnectResultSchema = z.object({
  hostname: z.string(),
  method: z.enum(["recreated", "undeleted"]),
  health: healthSchema.nullable(),
  cdnPurge: cdnPurgeSchema.nullable(),
  /** What happens next, in one sentence for the operator. */
  message: z.string(),
});

export const hostingStatusOp = defineOperation({
  name: "domains.hosting_status",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    supported: z.boolean(),
    domains: z.array(healthSchema),
    cdnPurge: cdnPurgeSchema.nullable(),
    error: z.string().nullable(),
  }),
  handler: async (ctx, _input, tx) => {
    if (!isFirebaseHostingInstall()) {
      return ok({ supported: false, domains: [], cdnPurge: null, error: null });
    }
    try {
      const target = await resolveHostingTarget();
      const raw = await listCustomDomains(target);
      const now = new Date();
      const domains = raw.map((d) => assessCustomDomain(d, now));
      const cdnPurge = await purgeCdnIfDomainsActivatedSinceLastRelease(target, raw);
      if (cdnPurge) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: "domains.hosting_status",
          input: {},
          succeeded: true,
          resultSummary: `CDN purge: re-released ${cdnPurge.versionName} after ${cdnPurge.hostnames.join(", ")} became active`,
        });
      }
      return ok({ supported: true, domains, cdnPurge, error: null });
    } catch (e) {
      // A Firebase outage or missing IAM must not hide the rest of the
      // domain listing; the caller renders the error next to it.
      return ok({ supported: true, domains: [], cdnPurge: null, error: (e as Error).message });
    }
  },
});

/** Read one custom domain's health — the precondition both reconnect paths check. */
export async function currentHostingHealth(
  hostname: string,
): Promise<
  { ok: true; health: CustomDomainHealth; target: HostingTarget } | { ok: false; message: string }
> {
  if (!isFirebaseHostingInstall()) {
    return {
      ok: false,
      message: `reconnecting a hosting domain applies to Firebase Hosting installs only (CAELO_PROVIDER=${process.env.CAELO_PROVIDER ?? "self-hosted"}).`,
    };
  }
  const target = await resolveHostingTarget();
  // A live domain answers GET; a soft-deleted one (an earlier reconnect
  // interrupted between DELETE and re-create) only shows in the
  // showDeleted listing — reconnecting restores it.
  const domain =
    (await getCustomDomain(target, hostname)) ??
    (await listCustomDomains(target)).find((d) => customDomainHostname(d) === hostname) ??
    null;
  if (!domain) {
    return {
      ok: false,
      message: `"${hostname}" is not a Firebase Hosting custom domain of this site — list_domains shows the ones that are.`,
    };
  }
  return { ok: true, health: assessCustomDomain(domain, new Date()), target };
}

export const reconnectHostingDomainOp = defineOperation({
  name: "domains.reconnect_hosting",
  // Why human-only: §11.A — deletes and re-creates the live hosting binding of a hostname; the AI
  // reaches it through propose_reconnect_domain (Owner-approved).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: reconnectInput,
  output: reconnectResultSchema,
  handler: async (ctx, input, tx) => {
    const current = await currentHostingHealth(input.hostname);
    if (!current.ok) {
      return err({
        kind: "HandlerError",
        operation: "domains.reconnect_hosting",
        message: current.message,
      });
    }
    if (current.health.status === "active") {
      return err({
        kind: "HandlerError",
        operation: "domains.reconnect_hosting",
        message: `"${input.hostname}" is active — reconnecting would take it offline until Firebase re-verifies it. Nothing to heal.`,
      });
    }
    const r = await reconnectCustomDomain(current.target, input.hostname, {
      alreadyDeleted: current.health.status === "deleted",
    });
    const health = r.domain ? assessCustomDomain(r.domain, new Date()) : null;
    const message = r.active
      ? r.cdnPurge
        ? `${input.hostname} is active again; the live version was re-released to clear the CDN's cached "Site Not Found" page.`
        : r.cdnPurgeError
          ? `${input.hostname} is active again, but clearing the CDN cache failed (${r.cdnPurgeError}) — publish the site again to clear it.`
          : `${input.hostname} is active again; nothing is published live yet, so there is no CDN cache to clear.`
      : `${input.hostname} was reconnected and Firebase is verifying it (${health?.summary ?? "status not readable yet"}). The CDN cache is cleared automatically the next time the domain status is read (list_domains or the Domains page) and it is active.`;
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "domains.reconnect_hosting",
      input,
      succeeded: true,
      resultSummary: `${r.method}; active=${r.active}; cdnPurge=${r.cdnPurge?.versionName ?? "none"}`,
    });
    return ok({
      hostname: input.hostname,
      method: r.method,
      health,
      cdnPurge: r.cdnPurge,
      message,
    });
  },
});
