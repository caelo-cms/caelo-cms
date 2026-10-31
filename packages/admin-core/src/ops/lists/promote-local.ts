// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — `lists.promote_local` (docs/lists.md §7): a module's LOCAL
 * list becomes a shared list, and the field binds it, in one call.
 *
 * Why one op: "the footer links should also show in the mobile menu" is
 * create-the-list + rebind-the-field + clear-the-placement-values; three
 * calls in the right order is exactly the choreography CLAUDE.md §11
 * folds into a single op. Every placement of the module must show the same
 * list for this to be lossless (a placement without its own value shows
 * the field default); when they differ the op refuses and names them.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { type ListItem, ok } from "@caelo-cms/shared";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  bindingOf,
  listFieldsOf,
  loadInstancesOfModules,
  loadModulesInView,
} from "../../lists/local.js";
import { loadListEntityForUpsert } from "../../lists/store.js";
import { emitSnapshot } from "../../snapshots/index.js";
import { setContentInstanceValuesOp } from "../content/content-instances.js";
import { updateModuleOp } from "../content/modules.js";
import { branchOf, failBatch, handlerError } from "./_shared.js";
import { writeListForOps } from "./lists.js";

/** Entries without their ids — what "the same list" means across placements. */
function shape(items: unknown): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const { id: _id, ...rest } = v as Record<string, unknown>;
      return Object.fromEntries(Object.entries(rest).map(([k, x]) => [k, strip(x)]));
    }
    return v;
  };
  return JSON.stringify(strip(items ?? []));
}

export const promoteLocalListOp = defineOperation({
  name: "lists.promote_local",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      moduleId: z.string().uuid(),
      /** The module's `list` field holding the local list. */
      field: z.string().min(1).max(64),
      slug: z
        .string()
        .regex(
          /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
          "list slug: lowercase letters, digits, hyphens",
        ),
      name: z.string().min(1).max(200),
      purpose: z.string().min(1).max(1000),
    })
    .strict(),
  output: z.object({ listId: z.string(), listRef: z.string(), itemCount: z.number().int() }),
  handler: async (ctx, input, tx) => {
    const op = "lists.promote_local";
    const branchId = branchOf(ctx);
    const module = (await loadModulesInView(tx, branchId)).find((m) => m.id === input.moduleId);
    if (!module) {
      return failBatch(
        false,
        handlerError(
          op,
          `module ${input.moduleId} does not exist (or was deleted) — list_modules shows the modules.`,
        ),
      );
    }
    const field = listFieldsOf(module.fields).find((f) => f.name === input.field);
    if (!field) {
      const names = listFieldsOf(module.fields).map((f) => f.name);
      return failBatch(
        false,
        handlerError(
          op,
          `module "${module.slug}" has no list field "${input.field}" — its list fields are ${names.join(", ") || "none"}.`,
        ),
      );
    }
    if (bindingOf(field) !== "local") {
      return failBatch(
        false,
        handlerError(
          op,
          `field "${input.field}" of module "${module.slug}" is already bound (${bindingOf(field)}) — there is no local list to promote.`,
          true,
        ),
      );
    }
    if (await loadListEntityForUpsert(tx, "list", branchId, input.slug)) {
      return failBatch(
        false,
        handlerError(op, `a list "${input.slug}" already exists — pick another slug.`, true),
      );
    }

    // What every placement shows: its own value, else the field default.
    const instances = await loadInstancesOfModules(tx, branchId, [module.id]);
    const shown = instances.map((ci) => ({
      id: ci.id,
      items: Array.isArray(ci.values[input.field]) ? ci.values[input.field] : field.default,
    }));
    const candidates = shown.length > 0 ? shown.map((s) => s.items) : [field.default];
    const distinct = new Map<string, string[]>();
    for (const s of shown) {
      const key = shape(s.items);
      distinct.set(key, [...(distinct.get(key) ?? []), s.id]);
    }
    if (distinct.size > 1) {
      const groups = [...distinct.values()]
        .slice(0, 4)
        .map((ids) => `[${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}]`)
        .join(" vs ");
      return failBatch(
        false,
        handlerError(
          op,
          `placements of module "${module.slug}" show different "${input.field}" lists (content instances ${groups}). One shared list cannot keep them all. Make them the same first (set_content_instance_values_many), or create the shared list yourself with lists.upsert_many and bind only the module you want.`,
          true,
        ),
      );
    }
    const items = (Array.isArray(candidates[0]) ? candidates[0] : []) as ListItem[];

    const r = await writeListForOps(ctx, tx, {
      at: `module "${module.slug}" field "${input.field}"`,
      found: null,
      slug: input.slug,
      name: input.name,
      purpose: input.purpose,
      typeSlug: field.listType,
      items,
    });
    if (!r.ok) return failBatch(false, handlerError(op, r.message));
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "lists.promote_local",
      description: `lists.promote_local ${module.slug}.${input.field} → ${input.slug}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: branchId,
      entities: [{ kind: "list", entityId: r.id, state: r.state }],
    });
    // Rebind the field to the new list, fixed for every placement.
    const listRef = `caelo:list/${r.id}`;
    const fields = module.fields.map((f) => {
      if (!listFieldsOf([f]).some((lf) => lf.name === input.field)) return f;
      const { default: _default, ...rest } = f as Record<string, unknown>;
      return { ...rest, bind: "shared", list: listRef };
    });
    const moduleWrite = await updateModuleOp.handler(
      ctx,
      { moduleId: module.id, fields } as Parameters<typeof updateModuleOp.handler>[1],
      tx,
    );
    if (!moduleWrite.ok) {
      return failBatch(
        true,
        handlerError(
          op,
          `rebinding field "${input.field}" failed: ${"message" in moduleWrite.error ? moduleWrite.error.message : moduleWrite.error.kind}`,
        ),
      );
    }
    // Placement values for the field are obsolete once the module fixes the list.
    for (const ci of instances) {
      if (!(input.field in ci.values)) continue;
      const { [input.field]: _drop, ...values } = ci.values;
      const w = await setContentInstanceValuesOp.handler(ctx, { id: ci.id, values }, tx);
      if (!w.ok) {
        return failBatch(
          true,
          handlerError(
            op,
            `clearing the local value of content instance ${ci.id} failed: ${"message" in w.error ? w.error.message : w.error.kind}`,
          ),
        );
      }
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      entityId: r.id,
      resultSummary: `${module.slug}.${input.field} → ${input.slug} items=${r.state.items.length}${branchId ? " (branch)" : ""}`,
    });
    return ok({ listId: r.id, listRef, itemCount: r.state.items.length });
  },
});
