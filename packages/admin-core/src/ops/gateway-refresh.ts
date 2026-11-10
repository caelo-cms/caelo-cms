// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's refresh pings to the public API gateways (gateway-refresh.ts
 * in admin-core and in @caelo-cms/shared): where they go and how the last
 * one went.
 *
 *   - gateway.refresh_targets — the public URL each gateway answers on.
 *   - gateway.record_refresh  — one ping's outcome, for Settings → Gateway.
 *
 * Both are system-only: the admin's projection publisher pings, never a
 * person or the AI. What the pings recorded is read with the gateway
 * settings (`gateway.get_settings`, {@link readGatewayRefreshPings}).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { type GatewayRefreshTarget, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { liveSiteOrigin, readStagingHost } from "../deploy/staging-domain.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

const target = z.enum(["live", "staging"]) satisfies z.ZodType<GatewayRefreshTarget>;

/** How the last ping to one gateway went, as Settings → Gateway and the AI read it. */
export const gatewayRefreshPingShape = z.object({
  target,
  /** Where the last ping went; null when the admin knew no URL for it. */
  url: z.string().nullable(),
  lastAttemptAt: z.string(),
  lastOkAt: z.string().nullable(),
  /** Why the last failed ping failed; null when none failed yet. */
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
});

export type GatewayRefreshPing = z.infer<typeof gatewayRefreshPingShape>;

const iso = (v: string | Date | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);

/** The recorded pings, live first; a gateway never pinged has no entry. */
export async function readGatewayRefreshPings(tx: Tx): Promise<GatewayRefreshPing[]> {
  const rows = (await tx.execute(sql`
    SELECT target, url, last_attempt_at, last_ok_at, last_error, last_error_at
    FROM gateway_refresh_state
    ORDER BY target
  `)) as unknown as {
    target: "live" | "staging";
    url: string | null;
    last_attempt_at: string | Date;
    last_ok_at: string | Date | null;
    last_error: string | null;
    last_error_at: string | Date | null;
  }[];
  return rows.map((r) => ({
    target: r.target,
    url: r.url,
    lastAttemptAt: iso(r.last_attempt_at) ?? "",
    lastOkAt: iso(r.last_ok_at),
    lastError: r.last_error,
    lastErrorAt: iso(r.last_error_at),
  }));
}

export const gatewayRefreshTargetsOp = defineOperation({
  name: "gateway.refresh_targets",
  readScope: "request",
  // Why system-only: only the admin's projection publisher pings the
  // gateways, right after a publish; nobody else asks where a ping goes.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    /** The live site's origin (`site_defaults.site_base_url`): its `/api/*` is the live gateway. */
    live: z.string().nullable(),
    /** `https://<staging host>`, every path of which is the staging gateway; null while no host is set. */
    staging: z.string().nullable(),
  }),
  handler: async (_ctx, _input, tx) => {
    const live = await liveSiteOrigin(tx);
    const host = await readStagingHost(tx);
    return ok({ live, staging: host ? `https://${host}` : null });
  },
});

export const recordGatewayRefreshOp = defineOperation({
  name: "gateway.record_refresh",
  readScope: "request",
  // Why system-only: the outcome of a ping the admin's projection publisher
  // sent; a person or the AI has nothing to record here.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      target,
      url: z.string().max(2000).nullable(),
      /** Why the ping failed, never containing the token; null when it succeeded. */
      error: z.string().min(1).max(2000).nullable(),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    // A success keeps the last failure on record, so the operator still sees
    // when and why the gateway last missed a ping.
    if (input.error === null) {
      await tx.execute(sql`
        INSERT INTO gateway_refresh_state (target, url, last_attempt_at, last_ok_at)
        VALUES (${input.target}, ${input.url}, now(), now())
        ON CONFLICT (target) DO UPDATE SET
          url = EXCLUDED.url,
          last_attempt_at = EXCLUDED.last_attempt_at,
          last_ok_at = EXCLUDED.last_ok_at
      `);
    } else {
      await tx.execute(sql`
        INSERT INTO gateway_refresh_state (target, url, last_attempt_at, last_error, last_error_at)
        VALUES (${input.target}, ${input.url}, now(), ${input.error}, now())
        ON CONFLICT (target) DO UPDATE SET
          url = EXCLUDED.url,
          last_attempt_at = EXCLUDED.last_attempt_at,
          last_error = EXCLUDED.last_error,
          last_error_at = EXCLUDED.last_error_at
      `);
    }
    return ok({});
  },
});
