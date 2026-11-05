// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1461 — static_files.{propose_set, propose_delete, preview_set,
 * preview_delete, execute_proposal, reject_proposal, list_pending}.
 *
 * The §11.A gate of static files (CLAUDE.md): a file at a chosen path can
 * prove domain ownership to a third party, and recovering from one that did
 * means going to that third party. So the AI proposes and an Owner approves
 * in the chat or at Settings → Static files.
 *
 * The approved write reaches nobody by itself: it lands in `static_files`
 * and the next Stage builds it (static_files.ts).
 */

import {
  defineOperation,
  handlerErrorFromDetails,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import {
  err,
  ok,
  type ProposalStatus,
  proposalStatus,
  type StaticFileInput,
  staticFileByteLength,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";
import { requiresApproverPermission } from "./_approver-permission.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "./_propose-helpers.js";
import {
  deleteStaticFilesOp,
  missingStaticFiles,
  setStaticFilesOp,
  staticFilesDeleteInput,
  staticFilesSetInput,
  staticFileVersions,
  staticFileWriteProblems,
} from "./static_files.js";

const PROPOSAL_KINDS = ["set", "delete"] as const;
type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** What the Owner should hold against every file, on the approval card. */
const WHY_ASKED =
  "A file at a chosen address can prove to another company that you own this domain. Approve only what you expect.";

/** How much of a file the approval card shows. */
const CARD_BODY_CHARS = 2000;

const proposeOutput = z.object({
  proposalId: z.string(),
  preview: z.record(z.string(), z.unknown()),
});

type ProposeInput = z.infer<typeof staticFilesSetInput>;

async function changeOf(
  tx: TransactionRunner,
  paths: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const rows = (await tx.execute(sql`
    SELECT path FROM static_files WHERE deleted_at IS NULL
  `)) as unknown as { path: string }[];
  const known = new Set(rows.map((r) => r.path));
  return new Map(paths.map((p) => [p, known.has(p) ? "replaces the file there" : "new file"]));
}

function setPreview(files: readonly StaticFileInput[], changes: ReadonlyMap<string, string>) {
  return {
    summary: files.map((f) => f.path).join(", "),
    files: files.map((f) => ({
      path: f.path,
      contentType: f.contentType,
      sizeBytes: staticFileByteLength(f.body),
      purpose: f.purpose,
      change: changes.get(f.path) ?? "new file",
    })),
    effect: "Goes live with the next Stage and Publish live.",
  };
}

function setCard(files: readonly StaticFileInput[], changes: ReadonlyMap<string, string>): string {
  const blocks = files.map((f) => {
    const cut = f.body.length > CARD_BODY_CHARS;
    return [
      `${f.path} (${f.contentType}, ${staticFileByteLength(f.body)} bytes, ${changes.get(f.path) ?? "new file"})`,
      `Why: ${f.purpose}`,
      f.body.slice(0, CARD_BODY_CHARS) +
        (cut ? `\n… and ${f.body.length - CARD_BODY_CHARS} more characters` : ""),
    ].join("\n");
  });
  return [
    `Put ${files.length === 1 ? "this file" : `these ${files.length} files`} on your site's address?`,
    WHY_ASKED,
    ...blocks,
    "It goes live with the next Stage and Publish live.",
  ].join("\n\n");
}

// ─── propose_set / preview_set ───────────────────────────────────────

export const proposeSetStaticFilesOp = defineOperation({
  name: "static_files.propose_set",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: staticFilesSetInput,
  output: proposeOutput,
  handler: async (ctx, input: ProposeInput, tx) => {
    const op = "static_files.propose_set";
    const problems = await staticFileWriteProblems(tx, input.files);
    if (problems.length > 0) {
      return {
        ok: false,
        error: handlerErrorFromDetails(op, problems, { lead: "Nothing was proposed." }),
      };
    }
    const changes = await changeOf(
      tx,
      input.files.map((f) => f.path),
    );
    const versions = await staticFileVersions(
      tx,
      input.files.map((f) => f.path),
    );
    return queueProposal(
      tx,
      ctx,
      "set",
      input,
      { ...setPreview(input.files, changes), versions },
      op,
    );
  },
});

export const previewSetStaticFilesOp = defineOperation({
  name: "static_files.preview_set",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: staticFilesSetInput,
  output: z.object({ preview: z.string() }),
  handler: async (_ctx, input: ProposeInput, tx) => {
    const changes = await changeOf(
      tx,
      input.files.map((f) => f.path),
    );
    // The propose op refuses these after the click; the card says so first.
    const problems = await staticFileWriteProblems(tx, input.files);
    const card = setCard(input.files, changes);
    return ok({
      preview:
        problems.length === 0
          ? card
          : `This cannot be applied as it is, so reject it: ${problems.map((p) => p.message).join("; ")}\n\n${card}`,
    });
  },
});

// ─── propose_delete / preview_delete ─────────────────────────────────

export const proposeDeleteStaticFilesOp = defineOperation({
  name: "static_files.propose_delete",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: staticFilesDeleteInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const op = "static_files.propose_delete";
    const paths = [...new Set(input.paths)];
    const missing = await missingStaticFiles(tx, paths);
    if (missing.length > 0) {
      return {
        ok: false,
        error: handlerErrorFromDetails(op, missing, { lead: "Nothing was proposed." }),
      };
    }
    const preview = {
      summary: `delete ${paths.join(", ")}`,
      paths,
      versions: await staticFileVersions(tx, paths),
      effect: "Stays on the live site until the next Stage and Publish live.",
    };
    return queueProposal(tx, ctx, "delete", { paths }, preview, op);
  },
});

export const previewDeleteStaticFilesOp = defineOperation({
  name: "static_files.preview_delete",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: staticFilesDeleteInput,
  output: z.object({ preview: z.string() }),
  handler: async (_ctx, input) =>
    ok({
      preview: [
        `Remove ${input.paths.join(", ")} from your site's address?`,
        "If another company checks this file to confirm you own the domain, that check fails once it is gone.",
        "It stays on the live site until the next Stage and Publish live.",
      ].join("\n\n"),
    }),
});

// ─── execute / reject / list_pending ─────────────────────────────────

const executeOutput = z.object({
  kind: z.enum(PROPOSAL_KINDS),
  paths: z.array(z.string()),
  /** What has to happen before a visitor sees this. */
  nextStep: z.string(),
});

const executeDefinition = defineOperation({
  name: "static_files.execute_proposal",
  readScope: "request",
  // Why human-only: the Owner's Approve click of the §11.A gate — the AI
  // proposes, it can never approve or reject its own proposal.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: executeOutput,
  handler: async (ctx, input, tx) => {
    const op = "static_files.execute_proposal";
    const rows = (await tx.execute(sql`
      SELECT kind, payload, preview, status FROM static_file_pending_actions
      WHERE id = ${input.proposalId}::uuid
    `)) as unknown as {
      kind: ProposalKind;
      payload: unknown;
      preview: { versions: Record<string, number | null> };
      status: string;
    }[];
    const row = rows[0];
    if (!row) return err({ kind: "HandlerError", operation: op, message: "proposal not found" });
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: op,
        message: `proposal is already ${row.status}`,
      });
    }
    const proposed = Object.keys(row.preview.versions);
    const now = await staticFileVersions(tx, proposed);
    const changed = proposed.filter((p) => now[p] !== row.preview.versions[p]);
    if (changed.length > 0) {
      return err({
        kind: "HandlerError",
        operation: op,
        message: `${changed.join(", ")} changed after this proposal was made, so applying it would overwrite that change. Nothing was applied: reject it and propose again from the current file (get_static_file).`,
      });
    }
    let paths: string[];
    if (row.kind === "set") {
      const payload = staticFilesSetInput.parse(row.payload);
      const r = await setStaticFilesOp.handler(ctx, payload, tx);
      if (!r.ok) return r;
      paths = r.value.files.map((f) => f.path);
    } else {
      const payload = staticFilesDeleteInput.parse(row.payload);
      const r = await deleteStaticFilesOp.handler(ctx, payload, tx);
      if (!r.ok) return r;
      paths = r.value.deleted;
    }
    await tx.execute(sql`
      UPDATE static_file_pending_actions
      SET status = 'applied', decided_at = now(), decided_by = ${ctx.actorId}::uuid
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `${row.kind} ${paths.join(", ")}`,
    });
    return ok({
      kind: row.kind,
      paths,
      nextStep:
        "Saved, not on the site yet. It goes live with the next Stage (stage_changes, also when the chat has nothing else to stage) and the operator's Publish live.",
    });
  },
});

/** #589 — the approver must hold settings.write, as for a custom domain. */
export const executeStaticFileProposalOp = requiresApproverPermission(
  ["settings.write"],
  executeDefinition,
);

export const rejectStaticFileProposalOp = defineOperation({
  name: "static_files.reject_proposal",
  readScope: "request",
  // Why human-only: the Owner's Reject click of the §11.A gate.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE static_file_pending_actions
      SET status = 'rejected', decided_at = now(), decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "static_files.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});

const proposalRowSchema = z.object({
  id: z.string(),
  kind: z.enum(PROPOSAL_KINDS),
  proposedBy: z.string(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: proposalStatus,
  createdAt: z.string(),
});

export const listPendingStaticFileProposalsOp = defineOperation({
  name: "static_files.list_pending",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  output: z.object({ proposals: z.array(proposalRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, proposed_by::text AS proposed_by, payload, preview, status,
             created_at
      FROM static_file_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${input.limit ?? 50}
    `)) as unknown as {
      id: string;
      kind: ProposalKind;
      proposed_by: string;
      payload: unknown;
      preview: unknown;
      status: ProposalStatus;
      created_at: string | Date;
    }[];
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        proposedBy: r.proposed_by,
        payload: r.payload as Record<string, unknown>,
        preview: r.preview as Record<string, unknown>,
        status: r.status,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});

// ─── helpers ─────────────────────────────────────────────────────────

async function queueProposal(
  tx: TransactionRunner,
  ctx: { actorId: string; requestId: string; chatBranchId?: string; chatTaskId?: string },
  kind: ProposalKind,
  payload: unknown,
  preview: Record<string, unknown>,
  opName: string,
): Promise<
  | { ok: true; value: { proposalId: string; preview: Record<string, unknown> } }
  | { ok: false; error: { kind: "HandlerError"; operation: string; message: string } }
> {
  const payloadHash = await hashProposalPayload(payload);
  const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId, ctx.chatTaskId);
  let rows: { id: string }[];
  try {
    rows = (await tx.execute(sql`
      INSERT INTO static_file_pending_actions
        (kind, proposed_by, payload, preview, status, chat_session_id, payload_hash)
      VALUES (
        ${kind},
        ${ctx.actorId}::uuid,
        ${jsonbParam(payload)},
        ${jsonbParam(preview)},
        'pending',
        ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
        ${payloadHash}
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
  } catch (e) {
    if (isDuplicatePendingError(e)) {
      return err({ kind: "HandlerError", operation: opName, message: DUPLICATE_PROPOSAL_MESSAGE });
    }
    throw e;
  }
  const proposalId = rows[0]?.id;
  if (!proposalId) {
    return err({ kind: "HandlerError", operation: opName, message: "insert returned no id" });
  }
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: opName,
    input: { kind, summary: preview.summary },
    succeeded: true,
    entityId: proposalId,
    resultSummary: `kind=${kind}`,
  });
  return ok({ proposalId, preview });
}
