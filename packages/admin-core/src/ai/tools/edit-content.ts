// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: edit_content. The DB-content analogue of Claude Code's Edit /
 * MultiEdit — surgical `oldString → newString` replacements against a
 * module's or template's body (html/css/js), applied atomically in one
 * transaction via the entity's existing write op.
 *
 * Why this over re-emitting the whole body through update_modules_many: the wire
 * cost drops from O(body) to O(diff), the preview is genuinely minimal
 * (CLAUDE.md §8), and every existing invariant is preserved for free —
 * the edit funnels through modules.update (snapshot, per-entity chat-branch
 * lock, media-usage diff, field extractor) or, for templates, through the
 * §11.A propose gate (AI proposes, Owner approves).
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { readContentRow } from "../content-edit/read-row.js";
import { CONTENT_ENTITY_KINDS, resolveContentTarget } from "../content-edit/registry.js";
import { applyStringEdits, contentSha, renderEditSnippet } from "../content-edit/text-ops.js";
import { cssVarWarningSuffix } from "./_css-var-warnings.js";
import { describeError } from "./_describe-error.js";
import { designGuardSuffix } from "./_design-guard.js";
import { INTERNAL_LINK_CONTRACT } from "./_internal-link-contract.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const editContentInput = z
  .object({
    entityKind: z.enum(CONTENT_ENTITY_KINDS),
    entityId: z.string().uuid(),
    field: z.string().min(1).max(32),
    edits: z
      .array(
        z
          .object({
            // Empty only to fill an empty field (text-ops.ts applyStringEdits).
            oldString: z.string(),
            newString: z.string(),
            replaceAll: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    /**
     * Optional freshness token from read_content's `sha=`. When set and it
     * no longer matches the live body, the edit is rejected so a change by
     * another writer since your read is never silently clobbered.
     */
    expectedSha: z.string().min(1).max(16).optional(),
  })
  .strict();
type EditContentInput = z.infer<typeof editContentInput>;

export const editContentTool: ToolDefinitionWithHandler<EditContentInput> = {
  name: "edit_content",
  description:
    "Surgically edit a module's, template's or layout's body (html/css/js) by string replacement — the cheap, minimal-diff way to change existing code. " +
    "Pass `entityKind` + `entityId` + `field` + an `edits` array of {oldString, newString, replaceAll?}. Each `oldString` must be UNIQUE in the body (add surrounding context if not) unless `replaceAll:true`; edits apply in order, atomically (all-or-nothing). " +
    "Read the body first with read_content and copy exact text (incl. whitespace) into `oldString`; optionally pass its `sha=` as `expectedSha` to guard against a concurrent change. " +
    'To fill an EMPTY field (e.g. a module with no js yet), pass one edit with `oldString: ""` and the new content as `newString`; an empty oldString on a field that has content is refused. ' +
    "On success it returns the NEW `sha=` plus a line-numbered snippet of each changed region — chain another edit_content in the same turn using that sha and the fresh line numbers, WITHOUT re-reading. " +
    "PREFER this over update_modules_many for targeted changes to existing html/css/js — it is far cheaper and the diff is reviewable. " +
    "Use update_modules_many instead for a wholesale rewrite, a new module, or field-schema / displayName / kind changes. " +
    "TEMPLATES AND LAYOUTS ARE GATED: an edit_content on a template or layout is a TWO-STEP §11.A flow — you propose, the Owner clicks Approve on the proposal card. Do not claim such an edit was applied." +
    INTERNAL_LINK_CONTRACT,
  schema: editContentInput,
  inputSchema: z.toJSONSchema(editContentInput) as Record<string, unknown>,
  handler: async (ctx, input, toolCtx) => {
    const target = resolveContentTarget(input.entityKind);
    if (!target) {
      return {
        ok: false,
        content: `unknown entityKind "${input.entityKind}". Valid: ${CONTENT_ENTITY_KINDS.join(", ")}.`,
      };
    }
    if (!target.fields.includes(input.field)) {
      return {
        ok: false,
        content: `unknown field "${input.field}" for ${input.entityKind}. Valid fields: ${target.fields.join(", ")}. Use read_content to see the current bodies.`,
      };
    }

    // Read current body (branch-aware via the entity's get op).
    const row = await readContentRow(ctx, toolCtx, target, input.entityId);
    if (!row.ok) return { ok: false, content: row.content };
    const body = row.bodies[input.field] ?? "";

    // Optional freshness guard (Claude Code's read-before-edit, adapted to a
    // stateless server: uniqueness is the primary net; this catches the
    // cross-writer case where the body changed since read_content).
    if (input.expectedSha !== undefined && contentSha(body) !== input.expectedSha) {
      return {
        ok: false,
        content:
          `content changed since your read (${input.field} sha is now ${contentSha(body)}, you passed ${input.expectedSha}). ` +
          "Re-read with read_content and re-issue the edit against the current text.",
      };
    }

    // Apply the edits in memory — atomic, text-anchored.
    const applied = applyStringEdits(body, input.edits);
    if (!applied.ok) {
      return { ok: false, content: applied.error };
    }
    if (applied.content === body) {
      return { ok: false, content: "edits produced no change to the body." };
    }

    // Persist through the entity's existing write op — inherits snapshot,
    // lock, branch isolation, media-usage diff, and (modules) field extractor.
    const writeInput = target.write.buildInput(input.entityId, input.field, applied.content);
    const writeRes = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      target.write.op,
      writeInput,
    );
    if (!writeRes.ok) {
      return { ok: false, content: `${target.write.op} failed: ${describeError(writeRes.error)}` };
    }

    const plural = applied.replacements === 1 ? "" : "s";

    // Gated (template, layout): the write op queued a proposal — surface the
    // canonical "Queued proposal <uuid>:" shape so ChatPanel's ProposeCard
    // renders the inline Approve/Reject buttons, and DO NOT claim success.
    if (target.write.gated) {
      const proposalId = (writeRes.value as { proposalId?: string }).proposalId;
      if (proposalId) {
        return {
          ok: true,
          content:
            `Queued proposal ${proposalId}: edit_content on ${input.entityKind} ${input.entityId} ` +
            `(${input.field}, ${applied.replacements} replacement${plural}) — needs Owner approval. ` +
            `Approve it on the proposal card in this chat${target.write.queuePath ? ` (queue: ${target.write.queuePath})` : ""}. ` +
            "The change is NOT applied until approved." +
            applied.notes.map((n) => `\n${n}`).join(""),
        };
      }
      // Gated op returned ok but no proposalId — report honestly.
      return {
        ok: true,
        content: `${input.entityKind} ${input.field} edit proposed (awaiting Owner approval).`,
      };
    }

    // Module parity with update_modules_many: surface theme-var drift + design-guard
    // findings on the freshly-written CSS / html so the AI fixes them in
    // the same turn.
    let suffix = "";
    if (input.entityKind === "module" && input.field === "css") {
      suffix =
        (await cssVarWarningSuffix(ctx, toolCtx, applied.content)) +
        (await designGuardSuffix(ctx, toolCtx, {
          css: applied.content,
          scopeModuleId: input.entityId,
        }));
    } else if (input.entityKind === "module" && input.field === "html") {
      // #820 — an html edit can turn a module into a copy of another one.
      suffix = await designGuardSuffix(ctx, toolCtx, {
        html: applied.content,
        excludeModuleIds: [input.entityId],
      });
    }

    // Return the new sha + a cat -n snippet of each changed region (Claude
    // Code's Edit-result trick): the model can chain a follow-up edit_content
    // — reusing `expectedSha` and the fresh line numbers — WITHOUT a re-read.
    const newSha = contentSha(applied.content);
    const snippet = renderEditSnippet(applied.content, applied.edits);
    const notes = applied.notes.length > 0 ? `\n${applied.notes.join("\n")}` : "";
    const summary = `${input.entityKind} ${input.entityId} ${input.field} edited — ${applied.replacements} replacement${plural} (new sha=${newSha}).${notes}`;
    return {
      ok: true,
      content: snippet ? `${summary}\n${snippet}${suffix}` : `${summary}${suffix}`,
    };
  },
};
