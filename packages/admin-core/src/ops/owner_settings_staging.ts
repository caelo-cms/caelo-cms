// SPDX-License-Identifier: MPL-2.0

/**
 * owner_settings.{propose_set_staging_access,
 * propose_rotate_staging_credentials, propose_set_staging_host} — issue #650: the staging gate's
 * settings behind the owner-settings §11.A gate (CLAUDE.md §11.A,
 * migration 0251).
 *
 *  - Changing the access modes decides who sees unpublished work: an IP
 *    range or a new mode admits people, switching one off locks a crawler
 *    or the editors out. Not undoable by the AI with one call once a
 *    crawler has fetched the staged site.
 *  - Rotating a credential breaks every crawler profile that uses it, and
 *    the old value cannot be restored.
 *  - Moving the staging host needs DNS + a domain mapping before the new
 *    host answers, and every later Stage renders it.
 *
 * Both direct ops (`staging_access.set`, `staging_access.rotate_credentials`)
 * stay human+system; `owner_settings.execute_proposal` applies the queued
 * payload through their handlers via {@link applyOwnerStagingProposal}.
 */

import { defineOperation } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  describeStageNeeded,
  readStagedBuildHost,
  readStagingHost,
  stageNeededFor,
} from "../deploy/staging-domain.js";
import {
  errorMessage,
  handlerError,
  type OwnerSettingsKind,
  proposeOutput,
  queueProposal,
  type Tx,
} from "./owner_settings_queue.js";
import {
  checkStagingHost,
  credentialKind,
  currentStagingAccessInput,
  describeModes,
  readStagingAccessRow,
  rotateStagingCredentialsOp,
  setStagingAccessOp,
  setStagingHostOp,
  stagingAccessFields,
  stagingAccessInput,
  stagingHostNextSteps,
} from "./staging_access.js";

// ─── propose_set_staging_access ──────────────────────────────────────

/** A PATCH: only the named settings change, merged at approve time. */
export const proposeStagingAccessInput = stagingAccessFields
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "name at least one setting to change" });
type StagingPatch = z.infer<typeof proposeStagingAccessInput>;

/** The current row merged with `patch`, validated as the full input. */
async function mergedStagingAccess(tx: Tx, patch: StagingPatch) {
  const base = await currentStagingAccessInput(tx);
  const merged = stagingAccessInput.safeParse({ ...base, ...patch });
  if (!merged.success) {
    return {
      ok: false as const,
      message: merged.error.issues
        .map((i) => `${i.path.join(".") || "settings"}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true as const, base, merged: merged.data };
}

export const proposeSetStagingAccessOp = defineOperation({
  name: "owner_settings.propose_set_staging_access",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeStagingAccessInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const op = "owner_settings.propose_set_staging_access";
    const m = await mergedStagingAccess(tx, input);
    if (!m.ok) return handlerError(op, m.message);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, to] of Object.entries(input)) {
      const from = (m.base as Record<string, unknown>)[key];
      if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
    }
    if (Object.keys(changes).length === 0) {
      return handlerError(
        op,
        "every named setting already has that value — nothing to change. Read the current settings with get_staging_access first.",
      );
    }
    const summary = `staging access: ${describeModes(m.base)} → ${describeModes(m.merged)}`;
    return queueProposal(
      tx,
      ctx,
      "set_staging_access",
      input,
      {
        changes,
        summary,
        effect:
          "Changes who can open staging.<domain> — the unpublished site. A newly enabled crawler credential is generated on approval; the Owner reads it under Settings → Staging access.",
      },
      op,
      summary,
    );
  },
});

// ─── propose_rotate_staging_credentials ──────────────────────────────

export const proposeRotateStagingCredentialsInput = z
  .object({
    which: credentialKind,
    reason: z
      .string()
      .min(10)
      .max(500)
      .describe("Why (e.g. shared with a contractor who left). Shown on the approval."),
  })
  .strict();

export const proposeRotateStagingCredentialsOp = defineOperation({
  name: "owner_settings.propose_rotate_staging_credentials",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeRotateStagingCredentialsInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const op = "owner_settings.propose_rotate_staging_credentials";
    // One rotation waiting is enough — whichever credential it names (`both`
    // overlaps either single one): approving a second would rotate again
    // and void the value handed out after the first. This read names the
    // waiting proposal; migration 0251's partial unique index holds the
    // invariant when two proposals race past it.
    const pending = (await tx.execute(sql`
      SELECT id::text AS id, payload->>'which' AS which FROM owner_settings_pending_actions
      WHERE kind = 'rotate_staging_credentials' AND status = 'pending' LIMIT 1
    `)) as unknown as { id: string; which: string | null }[];
    if (pending[0]) {
      return handlerError(
        op,
        `a staging credential rotation (${pending[0].which ?? "unknown"}) is already waiting for approval (proposal ${pending[0].id}) — tell the operator to approve or reject that one instead of proposing another; to rotate a different credential as well, reject it and propose which: "both".`,
      );
    }
    const label =
      input.which === "both"
        ? "the basic-auth password and the secret header value"
        : input.which === "basic-auth"
          ? "the basic-auth password"
          : "the secret header value";
    const summary = `rotate the staging ${input.which === "both" ? "crawler credentials" : input.which === "basic-auth" ? "basic-auth password" : "secret header value"}`;
    return queueProposal(
      tx,
      ctx,
      "rotate_staging_credentials",
      input,
      {
        reason: input.reason,
        effect: `Replaces ${label}. Every crawler or tool configured with the old value is locked out of staging until it is given the new one (Settings → Staging access). The old value cannot be restored.`,
        summary,
      },
      op,
      summary,
    );
  },
});

// ─── propose_set_staging_host ────────────────────────────────────────

export const proposeSetStagingHostInput = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .describe(
        "e.g. preview.example.com (no https://, port or path). Never the live or admin host.",
      ),
  })
  .strict();

export const proposeSetStagingHostOp = defineOperation({
  name: "owner_settings.propose_set_staging_host",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeSetStagingHostInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const op = "owner_settings.propose_set_staging_host";
    const checked = await checkStagingHost(tx, input.host);
    if (!checked.ok) return handlerError(op, checked.message);
    const current = await readStagingHost(tx);
    if (current === checked.host) {
      return handlerError(op, `the staging host already is ${checked.host} — nothing to change.`);
    }
    const summary = `staging host: ${current ?? "(unset)"} → ${checked.host}`;
    return queueProposal(
      tx,
      ctx,
      "set_staging_host",
      { host: checked.host },
      {
        changes: { stagingHost: { from: current, to: checked.host } },
        summary,
        effect: `Staging moves to https://${checked.host}/: the gate answers on that host and every Stage renders it. It is reachable only after DNS and the domain mapping follow — ${stagingHostNextSteps(checked.host)}`,
      },
      op,
      summary,
    );
  },
});

// ─── apply (called by owner_settings.execute_proposal) ───────────────

/** The kinds this module queues; `execute_proposal` routes them here. */
export const OWNER_STAGING_KINDS: ReadonlySet<OwnerSettingsKind> = new Set([
  "set_staging_access",
  "rotate_staging_credentials",
  "set_staging_host",
]);

/**
 * Apply one approved {@link OWNER_STAGING_KINDS} proposal inside the
 * approving transaction, through the direct op's handler. Returns the
 * error message, or the next step to report with the applied result
 * (#678: a new host or access mode serves nothing until a Stage exists).
 */
export async function applyOwnerStagingProposal(
  ctx: ExecutionContext,
  tx: Tx,
  kind: OwnerSettingsKind,
  payload: unknown,
): Promise<{ error: string } | { nextStep: string }> {
  if (kind === "set_staging_access") {
    const m = await mergedStagingAccess(tx, proposeStagingAccessInput.parse(payload));
    if (!m.ok) return { error: m.message };
    const r = await setStagingAccessOp.handler(ctx, m.merged, tx);
    if (!r.ok) return { error: `staging_access.set failed: ${errorMessage(r.error)}` };
    return { nextStep: await accessNextStep(tx) };
  }
  if (kind === "rotate_staging_credentials") {
    const p = proposeRotateStagingCredentialsInput.parse(payload);
    const r = await rotateStagingCredentialsOp.handler(ctx, { which: p.which }, tx);
    if (!r.ok) {
      return { error: `staging_access.rotate_credentials failed: ${errorMessage(r.error)}` };
    }
    return { nextStep: await accessNextStep(tx) };
  }
  if (kind === "set_staging_host") {
    const p = proposeSetStagingHostInput.parse(payload);
    const r = await setStagingHostOp.handler(ctx, p, tx);
    if (!r.ok) return { error: `staging_access.set_host failed: ${errorMessage(r.error)}` };
    return { nextStep: r.value.nextSteps };
  }
  return { error: `kind ${kind} is not a staging-access proposal` };
}

/** After an access change: where the new credentials are, and whether a Stage is missing. */
async function accessNextStep(tx: Tx): Promise<string> {
  const host = await readStagingHost(tx);
  const row = await readStagingAccessRow(tx);
  const needed = stageNeededFor(host, await readStagedBuildHost(tx), row.origin_run_id !== null);
  const stage = describeStageNeeded(needed, host);
  return (
    "The gate applies the change within seconds. A new basic-auth password / header value is never shown to the AI: the operator copies it from Settings → Staging access (/settings/staging)." +
    (stage ? ` ${stage}` : "")
  );
}
