// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1454 — the site's response-header policy
 * (docs/dev/site-security-headers.md, rules in @caelo-cms/shared
 * site-security-headers.ts).
 *
 * The policy is stored live and read by the build, so a save changes nothing
 * a visitor gets: it reaches staging with the next Stage and production with
 * a human's Publish live, which copies the staged build and its headers.
 *
 * `security_headers.set` is the Owner panel's write; the AI proposes through
 * `owner_settings.propose_set_security_headers` (CLAUDE.md §11.A): a wrong
 * CSP takes a site's scripts down, a `frame-ancestors` change exposes it to
 * clickjacking, and HSTS cannot be taken back from a browser that saw it.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  composeSiteHeaders,
  EMPTY_CSP_FACTS,
  type ExecutionContext,
  enforceBlockers,
  ok,
  SITE_HEADER_HOSTS,
  type SiteCspFacts,
  type SiteHeaderHost,
  type SiteHeaderSet,
  SiteHeadersTooLargeError,
  type SiteSecurityPolicy,
  siteHeaderSetSchema,
  siteSecurityPolicySchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";
import { handlerError, proposeOutput, queueProposal, type Tx } from "./owner_settings_queue.js";

const OP_SET = "security_headers.set";
const OP_PROPOSE = "owner_settings.propose_set_security_headers";

/** The policy stored now. Throws on a row no migration wrote: a build would refuse it too. */
export async function readSecurityPolicy(tx: Tx): Promise<SiteSecurityPolicy> {
  const rows = (await tx.execute(sql`
    SELECT security_headers FROM site_settings WHERE id = 1
  `)) as unknown as { security_headers: unknown }[];
  return siteSecurityPolicySchema.parse(rows[0]?.security_headers);
}

/** The header set of the build each environment serves (see migration 0640). */
async function servedHeaderSets(
  tx: Tx,
): Promise<{ staged: SiteHeaderSet | null; live: SiteHeaderSet | null }> {
  const rows = (await tx.execute(sql`
    WITH served AS (
      SELECT DISTINCT ON (t.env) t.env, r.build_id
      FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE r.status = 'succeeded' AND r.build_kind = 'site' AND r.build_id IS NOT NULL
        AND t.env IN ('staging', 'production')
      ORDER BY t.env, r.started_at DESC
    )
    SELECT s.env, source.security_headers
    FROM served s
    JOIN deploy_runs source ON source.id = CASE
      WHEN s.build_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN s.build_id::uuid END
  `)) as unknown as { env: string; security_headers: unknown }[];
  const of = (env: string): SiteHeaderSet | null => {
    const stored = rows.find((r) => r.env === env)?.security_headers ?? null;
    return stored === null ? null : siteHeaderSetSchema.parse(stored);
  };
  return { staged: of("staging"), live: of("production") };
}

/** This install's host. Unknown provider names fail: a new adapter must say how it serves. */
function hostOf(): SiteHeaderHost & { readonly provider: string } {
  const provider = process.env.CAELO_PROVIDER ?? "self-hosted";
  const host = SITE_HEADER_HOSTS[provider];
  if (!host) {
    throw new Error(
      `security_headers: provider ${provider} is not in SITE_HEADER_HOSTS, so nothing says how it serves the site's headers.`,
    );
  }
  return { provider, ...host };
}

const servedShape = z
  .object({
    headers: z.record(z.string(), z.string()),
    hsts: z.string().nullable(),
    cspCut: z.boolean(),
    policy: siteSecurityPolicySchema,
  })
  .nullable();

function served(set: SiteHeaderSet | null): z.infer<typeof servedShape> {
  return set && { headers: set.headers, hsts: set.hsts, cspCut: set.cspCut, policy: set.policy };
}

/** What `security_headers.get` answers. */
export const securityHeadersOutput = z.object({
  policy: siteSecurityPolicySchema,
  host: z.object({
    provider: z.string(),
    served: z.boolean(),
    hostSendsHsts: z.boolean(),
    note: z.string(),
  }),
  /** The headers staging sends now; null before the first Stage after #1454. */
  staged: servedShape,
  /** The headers the live site sends now; null before the first Publish live after #1454. */
  live: servedShape,
  /** The stored policy differs from the staged build's: a Stage is needed. */
  stageNeeded: z.boolean(),
  /** What `enforce` would block, by the last staged build. */
  enforceBlockers: z.array(z.string()),
  /** What each plugin added to the staged build's policy. */
  plugins: z.array(
    z.object({
      slug: z.string(),
      origins: z.array(z.string()),
      inlineScripts: z.number().int().nonnegative(),
    }),
  ),
  /** Origins per kind the staged build references. */
  derivedOrigins: z.partialRecord(z.string(), z.array(z.string())),
  inlineScriptHashes: z.number().int().nonnegative(),
});

export const getSecurityHeadersOp = defineOperation({
  name: "security_headers.get",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: securityHeadersOutput,
  handler: async (_ctx, _input, tx) => {
    const policy = await readSecurityPolicy(tx);
    const { staged, live } = await servedHeaderSets(tx);
    return ok({
      policy,
      host: hostOf(),
      staged: served(staged),
      live: served(live),
      stageNeeded: JSON.stringify(staged?.policy ?? null) !== JSON.stringify(policy),
      enforceBlockers: staged ? enforceBlockers(staged) : [],
      plugins: staged?.facts.plugins ?? [],
      derivedOrigins: staged?.facts.origins ?? {},
      inlineScriptHashes: staged?.facts.inlineScriptHashes.length ?? 0,
    });
  },
});

async function writePolicy(ctx: ExecutionContext, tx: Tx, policy: SiteSecurityPolicy, op: string) {
  await tx.execute(sql`
    UPDATE site_settings SET security_headers = ${jsonbParam(policy)}, updated_at = now()
    WHERE id = 1
  `);
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: op,
    input: policy,
    succeeded: true,
    resultSummary: `csp=${policy.cspMode} frameAncestors=${policy.frameAncestors.length}`,
  });
}

/** What the headers of `policy` would be on the staged build, or why they cannot be. */
function composed(
  policy: SiteSecurityPolicy,
  facts: SiteCspFacts,
): { ok: true; set: SiteHeaderSet } | { ok: false; message: string } {
  try {
    return { ok: true, set: composeSiteHeaders(policy, facts) };
  } catch (e) {
    if (e instanceof SiteHeadersTooLargeError) return { ok: false, message: e.message };
    throw e;
  }
}

export const setSecurityHeadersOp = defineOperation({
  name: "security_headers.set",
  readScope: "request",
  // Why human-only: the direct write is the Owner's Settings → Security
  // headers form. A wrong CSP takes the site's scripts down and a
  // frame-ancestors change exposes it to clickjacking, neither undoable for
  // a visitor who got them (HSTS least of all). The AI reaches it only
  // through the §11.A gate (`propose_set_security_headers`).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: siteSecurityPolicySchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const host = hostOf();
    if (!host.served) return handlerError(OP_SET, host.note);
    const { staged } = await servedHeaderSets(tx);
    const made = composed(input, staged?.facts ?? EMPTY_CSP_FACTS);
    if (!made.ok) return handlerError(OP_SET, made.message);
    await writePolicy(ctx, tx, input, OP_SET);
    return ok({});
  },
});

// ─── the proposal ────────────────────────────────────────────────────

/** A PATCH: only the named settings change, merged at approve time. */
export const proposeSecurityHeadersInput = siteSecurityPolicySchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "name at least one setting to change" });
type Patch = z.infer<typeof proposeSecurityHeadersInput>;

interface Plan {
  readonly current: SiteSecurityPolicy;
  readonly merged: SiteSecurityPolicy;
  readonly changes: Record<string, { from: unknown; to: unknown }>;
  readonly before: Readonly<Record<string, string>>;
  readonly after: Readonly<Record<string, string>>;
  readonly warnings: readonly string[];
}

/** The merged policy and what it changes, or why it cannot apply. */
async function planPatch(
  tx: Tx,
  patch: Patch,
): Promise<{ ok: true; plan: Plan } | { ok: false; message: string }> {
  const host = hostOf();
  if (!host.served) return { ok: false, message: host.note };
  const current = await readSecurityPolicy(tx);
  const parsed = siteSecurityPolicySchema.safeParse({ ...current, ...patch });
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "policy"}: ${i.message}`)
        .join("; "),
    };
  }
  const merged = parsed.data;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, to] of Object.entries(patch)) {
    const from = current[key as keyof SiteSecurityPolicy];
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
  }
  if (Object.keys(changes).length === 0) {
    return {
      ok: false,
      message:
        "every named setting already has that value, so nothing would change. Read them with get_security_headers first.",
    };
  }
  const { staged } = await servedHeaderSets(tx);
  const facts = staged?.facts ?? EMPTY_CSP_FACTS;
  const before = composed(current, facts);
  const after = composed(merged, facts);
  if (!after.ok) return { ok: false, message: after.message };
  const warnings: string[] = [];
  if (staged === null) {
    warnings.push(
      "No build has been staged since these headers exist, so this preview names no third-party origins and shows no blockers. Stage first to see them.",
    );
  }
  if (merged.cspMode === "enforce") {
    warnings.push(...enforceBlockers(after.set).map((b) => `Would stop working: ${b}`));
  }
  if (host.hostSendsHsts && "hsts" in changes) {
    warnings.push(`${host.provider} sends its own HSTS header, so the hsts setting has no effect.`);
  }
  return {
    ok: true,
    plan: {
      current,
      merged,
      changes,
      before: before.ok ? before.set.headers : {},
      after: after.set.headers,
      warnings,
    },
  };
}

function summaryOf(plan: Plan): string {
  return `security headers: ${Object.keys(plan.changes).join(", ")}${
    plan.current.cspMode === plan.merged.cspMode
      ? ""
      : ` (CSP ${plan.current.cspMode} → ${plan.merged.cspMode})`
  }`;
}

const EFFECT =
  "Saved, not live: staging sends the new headers after the next Stage, the live site after a Publish live.";

function card(plan: Plan): string {
  const lines = [summaryOf(plan), EFFECT];
  for (const warning of plan.warnings) lines.push(`Warning: ${warning}`);
  const names = new Set([...Object.keys(plan.before), ...Object.keys(plan.after)]);
  for (const name of names) {
    const from = plan.before[name];
    const to = plan.after[name];
    if (from === to) continue;
    lines.push(`\n${name}\n  now: ${from ?? "(not sent)"}\n  new: ${to ?? "(not sent)"}`);
  }
  return lines.join("\n");
}

export const proposeSetSecurityHeadersOp = defineOperation({
  name: "owner_settings.propose_set_security_headers",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeSecurityHeadersInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const planned = await planPatch(tx, input);
    if (!planned.ok) return handlerError(OP_PROPOSE, planned.message);
    const { plan } = planned;
    const summary = summaryOf(plan);
    return queueProposal(
      tx,
      ctx,
      "set_security_headers",
      input,
      {
        changes: plan.changes,
        summary,
        effect: EFFECT,
        warnings: plan.warnings,
        headersBefore: plan.before,
        headersAfter: plan.after,
      },
      OP_PROPOSE,
      summary,
    );
  },
});

export const previewSetSecurityHeadersOp = defineOperation({
  name: "security_headers.preview_set",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeSecurityHeadersInput,
  output: z.object({ preview: z.string() }),
  handler: async (_ctx, input, tx) => {
    const planned = await planPatch(tx, input);
    return ok({
      preview: planned.ok
        ? card(planned.plan)
        : `This cannot be applied as it is, so reject it: ${planned.message}`,
    });
  },
});

/** Apply a queued patch, merged onto the row as it is now. An error's text, or null. */
export async function applySecurityHeadersProposal(
  ctx: ExecutionContext,
  tx: Tx,
  payload: unknown,
): Promise<string | null> {
  const planned = await planPatch(tx, proposeSecurityHeadersInput.parse(payload));
  if (!planned.ok) return planned.message;
  await writePolicy(ctx, tx, planned.plan.merged, OP_SET);
  return null;
}

/** What the operator does after approval. */
export const SECURITY_HEADERS_NEXT_STEP =
  "Saved. Staging sends the new headers after the next Stage (offer it), the live site after the operator's Publish live.";
