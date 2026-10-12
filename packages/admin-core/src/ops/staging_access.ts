// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #650 — the access gate of `staging.<domain>`.
 *
 *  - staging_access.get                — the staging URL, the enabled modes
 *                                         and (Owner only) the crawler
 *                                         credentials.
 *  - staging_access.set                — which modes let a request in.
 *  - staging_access.rotate_credentials — new basic-auth / header credentials.
 *  - staging_access.issue_open_link    — the admin's "Open staging": a
 *                                         short-lived signed link that sets
 *                                         the staging session cookie.
 *
 * The gate itself runs where staging is served (the gateway on
 * gcp-firebase); these ops only maintain its settings row. Credentials are
 * never stored: they are derived from the Secret Manager gate key and the
 * nonce in the row (@caelo-cms/shared staging-gate.ts).
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  DEFAULT_STAGING_HEADER_NAME,
  deriveStagingCredential,
  type ExecutionContext,
  err,
  newStagingCredentialNonce,
  normalizeStagingHost,
  ok,
  parseCidr,
  STAGING_ACCESS_PATH,
  STAGING_OPEN_TOKEN_TTL_SECONDS,
  safeStagingNextPath,
  signStagingToken,
  stagingHostProblem,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  providerHasStagingDomain,
  readStagingHost,
  reservedStagingHosts,
  stagingGateSecret,
  stagingSiteUrl,
} from "../deploy/staging-domain.js";
import { jsonbParam } from "../sql-helpers.js";
import { actorHasPermission } from "./quality/_permissions.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/**
 * Request headers the secret-header mode must not reuse: the platform or
 * the browser sets them, or another gate mode reads them.
 */
const RESERVED_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-type",
  "content-length",
  "user-agent",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
]);

/** The gate's settings fields, unrefined so a proposal can take a partial patch. */
export const stagingAccessFields = z
  .object({
    cookieEnabled: z
      .boolean()
      .describe(
        'Admin users reach staging through the admin\'s "Open staging" (a signed session cookie, no password).',
      ),
    basicAuthEnabled: z
      .boolean()
      .describe(
        "Crawlers/tools log in with generated basic-auth credentials (user basicAuthUser + a generated password).",
      ),
    basicAuthUser: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/, "letters, digits, '.', '_' or '-', at most 64")
      .describe("Basic-auth user name crawlers send."),
    headerEnabled: z
      .boolean()
      .describe("Crawlers/tools send a generated secret value in the request header headerName."),
    headerName: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/, "a header name: letters, digits and '-'")
      .refine((h) => !RESERVED_HEADERS.has(h.toLowerCase()), {
        message: "pick a custom header name (e.g. X-Caelo-Staging-Key), not a standard one",
      })
      .describe(`Name of the secret request header (default ${DEFAULT_STAGING_HEADER_NAME}).`),
    ipAllowlist: z
      .array(
        z
          .string()
          .trim()
          .refine((c) => parseCidr(c) !== null, {
            message: "not an IPv4/IPv6 address or CIDR (e.g. 203.0.113.7 or 203.0.113.0/24)",
          }),
      )
      .max(50)
      .describe(
        "Client addresses/CIDRs let in without credentials (e.g. a crawler's static egress IP).",
      ),
  })
  .strict();

/** The settings `staging_access.set` writes — the whole row. */
export const stagingAccessInput = stagingAccessFields.refine(
  (v) => v.cookieEnabled || v.basicAuthEnabled || v.headerEnabled || v.ipAllowlist.length > 0,
  {
    message:
      "enable at least one access mode — with none, nobody (not even the admin) can open staging",
  },
);
export type StagingAccessInput = z.infer<typeof stagingAccessInput>;

const settingsOutput = z.object({
  cookieEnabled: z.boolean(),
  basicAuthEnabled: z.boolean(),
  basicAuthUser: z.string(),
  /** A basic-auth credential exists (it is generated on first enable). */
  basicAuthGenerated: z.boolean(),
  headerEnabled: z.boolean(),
  headerName: z.string(),
  headerGenerated: z.boolean(),
  ipAllowlist: z.array(z.string()),
  updatedAt: z.string(),
});

interface StagingAccessRow {
  cookie_enabled: boolean;
  basic_auth_enabled: boolean;
  basic_auth_user: string;
  basic_auth_nonce: string | null;
  header_enabled: boolean;
  header_name: string;
  header_nonce: string | null;
  ip_allowlist: string[] | string;
  origin_run_id: string | null;
  updated_at: string | Date;
}

/** The singleton row. Throws when migration 0251 has not seeded it. */
export async function readStagingAccessRow(tx: Tx): Promise<StagingAccessRow> {
  const rows = (await tx.execute(sql`
    SELECT cookie_enabled, basic_auth_enabled, basic_auth_user, basic_auth_nonce,
           header_enabled, header_name, header_nonce,
           to_jsonb(ip_allowlist) AS ip_allowlist,
           origin_run_id::text AS origin_run_id, updated_at
    FROM staging_access WHERE id = 1
  `)) as unknown as StagingAccessRow[];
  const row = rows[0];
  if (!row) {
    throw new Error(
      "staging_access row (id=1) is missing — run the cms_admin migrations (0251 seeds it).",
    );
  }
  return row;
}

function allowlistOf(row: StagingAccessRow): string[] {
  return typeof row.ip_allowlist === "string"
    ? (JSON.parse(row.ip_allowlist) as string[])
    : row.ip_allowlist;
}

function toOutput(row: StagingAccessRow): z.infer<typeof settingsOutput> {
  return {
    cookieEnabled: row.cookie_enabled,
    basicAuthEnabled: row.basic_auth_enabled,
    basicAuthUser: row.basic_auth_user,
    basicAuthGenerated: row.basic_auth_nonce !== null,
    headerEnabled: row.header_enabled,
    headerName: row.header_name,
    headerGenerated: row.header_nonce !== null,
    ipAllowlist: allowlistOf(row),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

/** The current settings in the shape `staging_access.set` accepts. */
export async function currentStagingAccessInput(tx: Tx): Promise<StagingAccessInput> {
  const s = toOutput(await readStagingAccessRow(tx));
  return {
    cookieEnabled: s.cookieEnabled,
    basicAuthEnabled: s.basicAuthEnabled,
    basicAuthUser: s.basicAuthUser,
    headerEnabled: s.headerEnabled,
    headerName: s.headerName,
    ipAllowlist: s.ipAllowlist,
  };
}

function handlerError(operation: string, message: string) {
  return err({ kind: "HandlerError" as const, operation, message });
}

/** Wake the gateway's settings LISTEN so the change applies immediately. */
async function notifyGateway(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_notify('caelo_gateway_settings', 'staging_access')`);
}

/** What `staging_access.get` returns. */
export const stagingAccessOutput = z.object({
  /** `https://<staging host>`, or null when this provider has no staging domain yet or no host is set. */
  stagingUrl: z.string().nullable(),
  /** The staging host setting (default staging.<domain>); null until provisioning seeded it. */
  stagingHost: z.string().nullable(),
  /** This install's provider serves staging at its own gated host. */
  stagingDomainSupported: z.boolean(),
  provider: z.string(),
  settings: settingsOutput,
  /** True while a staged build is being served (gcp-firebase: a preview channel exists). */
  hasStagedBuild: z.boolean(),
  credentials: z
    .object({
      basicAuthUser: z.string(),
      basicAuthPassword: z.string().nullable(),
      headerName: z.string(),
      headerValue: z.string().nullable(),
    })
    .optional(),
});

export const getStagingAccessOp = defineOperation({
  name: "staging_access.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      includeCredentials: z
        .boolean()
        .default(false)
        .describe(
          "Also return the basic-auth password and secret header value. Only an operator holding settings.write (Owner) gets them.",
        ),
    })
    .strict(),
  output: stagingAccessOutput,
  handler: async (ctx, input, tx) => {
    const op = "staging_access.get";
    const row = await readStagingAccessRow(tx);
    const provider = process.env.CAELO_PROVIDER ?? "self-hosted";
    const supported = providerHasStagingDomain(provider);
    const stagingHost = await readStagingHost(tx);
    const base = {
      stagingUrl: supported && stagingHost ? `https://${stagingHost}` : null,
      stagingHost,
      stagingDomainSupported: supported,
      provider,
      settings: toOutput(row),
      hasStagedBuild: row.origin_run_id !== null,
    };
    // No gate on this provider (yet): there are no crawler credentials to
    // show, and the gate key is not provisioned — answering the settings
    // keeps Security → Staging access usable instead of failing on it.
    if (!input.includeCredentials || !supported) return ok(base);
    if (ctx.actorKind !== "human" || !(await actorHasPermission(tx, ctx, "settings.write"))) {
      return handlerError(
        op,
        "the staging credentials are shown only to an operator holding settings.write (the Owner) — ask them to open Security → Staging access, or to read them here themselves.",
      );
    }
    let secret: string;
    try {
      secret = stagingGateSecret();
    } catch (e) {
      return handlerError(op, e instanceof Error ? e.message : String(e));
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "staging_access.reveal_credentials",
      input: {},
      succeeded: true,
      resultSummary: "staging crawler credentials shown",
    });
    return ok({
      ...base,
      credentials: {
        basicAuthUser: row.basic_auth_user,
        basicAuthPassword: row.basic_auth_nonce
          ? await deriveStagingCredential(secret, "basic-auth", row.basic_auth_nonce)
          : null,
        headerName: row.header_name,
        headerValue: row.header_nonce
          ? await deriveStagingCredential(secret, "header", row.header_nonce)
          : null,
      },
    });
  },
});

export const setStagingAccessOp = defineOperation({
  name: "staging_access.set",
  // Why human-only: the Owner's Security → Staging access form. Opening the
  // gate (an IP range, a new mode) exposes unpublished work to whoever it
  // admits; the AI reaches this only through the §11.A gate
  // (owner_settings.propose_set_staging_access → the operator's Approve).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: stagingAccessInput,
  output: z.object({ settings: settingsOutput }),
  handler: async (ctx, input, tx) => {
    const current = await readStagingAccessRow(tx);
    // A mode that is switched on gets its credential the first time; an
    // existing one is kept (rotation is its own op).
    const basicNonce =
      input.basicAuthEnabled && current.basic_auth_nonce === null
        ? newStagingCredentialNonce()
        : current.basic_auth_nonce;
    const headerNonce =
      input.headerEnabled && current.header_nonce === null
        ? newStagingCredentialNonce()
        : current.header_nonce;
    const allowlist = [...new Set(input.ipAllowlist.map((c) => c.trim()))];
    await tx.execute(sql`
      UPDATE staging_access SET
        cookie_enabled     = ${input.cookieEnabled},
        basic_auth_enabled = ${input.basicAuthEnabled},
        basic_auth_user    = ${input.basicAuthUser},
        basic_auth_nonce   = ${basicNonce},
        header_enabled     = ${input.headerEnabled},
        header_name        = ${input.headerName},
        header_nonce       = ${headerNonce},
        ip_allowlist       = ARRAY(SELECT jsonb_array_elements_text(${jsonbParam(allowlist)})),
        updated_at         = now()
      WHERE id = 1
    `);
    await notifyGateway(tx);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "staging_access.set",
      input: { ...input, ipAllowlist: allowlist },
      succeeded: true,
      resultSummary: describeModes({ ...input, ipAllowlist: allowlist }),
    });
    return ok({ settings: toOutput(await readStagingAccessRow(tx)) });
  },
});

/** "cookie, basic-auth (crawler), 2 IP ranges" — for audits and previews. */
export function describeModes(s: StagingAccessInput): string {
  const modes = [
    s.cookieEnabled ? "Open staging (admin cookie)" : null,
    s.basicAuthEnabled ? `basic auth (user ${s.basicAuthUser})` : null,
    s.headerEnabled ? `secret header ${s.headerName}` : null,
    s.ipAllowlist.length > 0 ? `IP allowlist (${s.ipAllowlist.join(", ")})` : null,
  ].filter((m): m is string => m !== null);
  return modes.length > 0 ? modes.join("; ") : "no access mode";
}

/** Which crawler credential(s) a rotation replaces. */
export const credentialKind = z.enum(["basic-auth", "header", "both"]);

export const rotateStagingCredentialsOp = defineOperation({
  name: "staging_access.rotate_credentials",
  // Why human-only: the Owner's Rotate button. Every crawler profile that
  // uses the old credential stops working and the old one cannot be
  // restored; the AI reaches it only through
  // owner_settings.propose_rotate_staging_credentials (§11.A).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ which: credentialKind }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const basic = input.which === "basic-auth" || input.which === "both";
    const header = input.which === "header" || input.which === "both";
    await tx.execute(sql`
      UPDATE staging_access SET
        basic_auth_nonce = ${basic ? newStagingCredentialNonce() : sql`basic_auth_nonce`},
        header_nonce     = ${header ? newStagingCredentialNonce() : sql`header_nonce`},
        updated_at       = now()
      WHERE id = 1
    `);
    await notifyGateway(tx);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "staging_access.rotate_credentials",
      input,
      succeeded: true,
      resultSummary: `rotated ${input.which}`,
    });
    return ok({});
  },
});

export const issueStagingOpenLinkOp = defineOperation({
  name: "staging_access.issue_open_link",
  // Why human-only: it hands THIS browser a staging session (the link sets
  // a cookie on staging.<domain>); there is no browser on the AI side. The
  // AI tells the operator to use "Open staging" or reads the URL with
  // get_staging_access.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      path: z.string().max(2000).default("/").describe("Staging path to land on."),
    })
    .strict(),
  output: z.object({ url: z.string(), expiresAt: z.string() }),
  handler: async (ctx: ExecutionContext, input, tx) => {
    const op = "staging_access.issue_open_link";
    let stagingUrl: string | null;
    let secret: string;
    try {
      stagingUrl = await stagingSiteUrl(tx);
      secret = stagingGateSecret();
    } catch (e) {
      return handlerError(op, e instanceof Error ? e.message : String(e));
    }
    if (stagingUrl === null) {
      return handlerError(
        op,
        `this install's provider (${process.env.CAELO_PROVIDER ?? "self-hosted"}) has no protected staging domain yet; open the staged build from the Stage result instead.`,
      );
    }
    const row = await readStagingAccessRow(tx);
    if (!row.cookie_enabled) {
      return handlerError(
        op,
        '"Open staging" is switched off for this install (Security → Staging access → admin cookie). Turn it on, or reach staging with the crawler credentials.',
      );
    }
    const expiresAt = Math.floor(Date.now() / 1000) + STAGING_OPEN_TOKEN_TTL_SECONDS;
    const token = await signStagingToken(secret, "open", expiresAt);
    const next = safeStagingNextPath(input.path);
    const url = `${stagingUrl}${STAGING_ACCESS_PATH}?t=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input: { path: next },
      succeeded: true,
      resultSummary: `opened staging at ${next}`,
    });
    return ok({ url, expiresAt: new Date(expiresAt * 1000).toISOString() });
  },
});

/**
 * Record which staged build staging.<domain> serves (#650): its provider
 * origin and run, or null when nothing is staged (after Publish live).
 * Written by deploy.trigger / deploy.promote inside their transaction;
 * the gateway reads it to know where to proxy.
 */
export async function setStagingOrigin(
  tx: Tx,
  staged: { readonly originUrl: string | null; readonly runId: string } | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE staging_access SET
      origin_url    = ${staged?.originUrl ?? null},
      origin_run_id = ${staged === null ? null : sql`${staged.runId}::uuid`},
      updated_at    = now()
    WHERE id = 1
  `);
  await notifyGateway(tx);
}

// ─── the staging host setting ────────────────────────────────────────

const stagingHostInput = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .describe(
    "Host name of the staging site, e.g. staging.example.com or preview.other-domain.com (no https://, port or path).",
  );

/** The validated, normalised host, or a refusal naming why it cannot be one. */
export async function checkStagingHost(
  tx: Tx,
  host: string,
): Promise<{ ok: true; host: string } | { ok: false; message: string }> {
  const problem = stagingHostProblem(host, await reservedStagingHosts(tx), {
    provider: process.env.CAELO_PROVIDER,
  });
  return problem ? { ok: false, message: problem } : { ok: true, host: normalizeStagingHost(host) };
}

export const seedStagingHostOp = defineOperation({
  name: "staging_access.seed_host",
  // Why human-only: system-only. The admin calls it at boot with the host
  // provisioning recorded (CAELO_STAGING_HOST: the wizard's answer, default
  // staging.<domain>); it fills an unset value and never overwrites one, so
  // it cannot replace an Owner's choice. Changing it is staging_access.set_host.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ host: stagingHostInput }).strict(),
  output: z.object({ seeded: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const checked = await checkStagingHost(tx, input.host);
    if (!checked.ok) return handlerError("staging_access.seed_host", checked.message);
    const updated = (await tx.execute(sql`
      UPDATE staging_access SET staging_host = ${checked.host}, updated_at = now()
      WHERE id = 1 AND staging_host IS NULL
      RETURNING id
    `)) as unknown as { id: number }[];
    if (updated.length > 0) {
      await notifyGateway(tx);
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "staging_access.seed_host",
        input: { host: checked.host },
        succeeded: true,
        resultSummary: `staging host=${checked.host} (from CAELO_STAGING_HOST)`,
      });
    }
    return ok({ seeded: updated.length > 0 });
  },
});

export const setStagingHostOp = defineOperation({
  name: "staging_access.set_host",
  // Why human-only: the Owner's Security → Domains form. A new staging host
  // needs its own DNS record and domain mapping before anyone can open it,
  // and every Stage renders it; the AI reaches it only through the §11.A
  // gate (owner_settings.propose_set_staging_host → the operator's Approve).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ host: stagingHostInput }).strict(),
  output: z.object({ host: z.string(), previous: z.string().nullable(), nextSteps: z.string() }),
  handler: async (ctx, input, tx) => {
    const op = "staging_access.set_host";
    const checked = await checkStagingHost(tx, input.host);
    if (!checked.ok) return handlerError(op, checked.message);
    const previous = await readStagingHost(tx);
    if (previous === checked.host) {
      return handlerError(op, `the staging host already is ${checked.host} — nothing to change.`);
    }
    await tx.execute(sql`
      UPDATE staging_access SET staging_host = ${checked.host}, updated_at = now() WHERE id = 1
    `);
    await notifyGateway(tx);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input: { host: checked.host },
      succeeded: true,
      resultSummary: `staging host ${previous ?? "(unset)"} → ${checked.host}`,
    });
    return ok({ host: checked.host, previous, nextSteps: stagingHostNextSteps(checked.host) });
  },
});

/** What the operator does after the staging host changed. */
export function stagingHostNextSteps(host: string): string {
  return `Point ${host} at the gateway: run \`cms-provision staging-domain enable --staging-domain ${host}\` (it records the host for the install, maps it and prints the DNS record to add), then Stage again so the staged build renders the new host.`;
}
