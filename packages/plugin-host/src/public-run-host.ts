// SPDX-License-Identifier: MPL-2.0

/**
 * #1340 (epic #763 E2-B) — the host executes a public operation's declared
 * `run` (SDK `./public-run.ts`); no plugin code answers a visitor.
 *
 * The context is the visitor call's (capabilities.ts): `ctx.query` reaches
 * only the operation's declared reads and writes on the plugin's own
 * public tables, under Postgres grants generated from the table kinds, and
 * `ctx.adminQuery` (where granted) only the admin data the plugin publishes
 * (`visitorProjection`). So a run can do no more than its declaration
 * says, and the declaration no more than the kinds allow.
 *
 * A refusal the declaration words (a failed check) is a
 * `PublicOperationError` (422); anything else is a failure (500), whose
 * text the visitor never sees (public-contract.ts `visitorSafeResult`).
 */

import {
  matchesDropPattern,
  type PluginContextTier1,
  type PublicAnswer,
  type PublicBlock,
  type PublicCheck,
  type PublicOperationDef,
  PublicOperationError,
  type PublicRun,
  type PublicValueRef,
} from "@caelo-cms/plugin-sdk";
import { COMMENT_THREAD_BLOCKS } from "./public-blocks/comment-thread.js";
import { MAIL_BLOCKS } from "./public-blocks/mail-blocks.js";
import { VISITOR_AUTH_BLOCKS } from "./public-blocks/visitor-auth.js";

type BlockFn = (
  ctx: PluginContextTier1,
  args: unknown,
  options: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

/** Every core building block, by name (the SDK's `PUBLIC_BLOCKS`). */
const BLOCKS: Readonly<Record<PublicBlock, BlockFn>> = {
  ...VISITOR_AUTH_BLOCKS,
  ...MAIL_BLOCKS,
  ...COMMENT_THREAD_BLOCKS,
};

/** Sentinel: an optional input field that is absent leaves its column out. */
const ABSENT = Symbol("absent");

function inputAt(args: unknown, field: string): unknown {
  let at: unknown = args;
  for (const part of field.split(".")) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return undefined;
    at = Object.hasOwn(at, part) ? (at as Record<string, unknown>)[part] : undefined;
  }
  return at;
}

function resolve(ref: PublicValueRef, args: unknown, ctx: PluginContextTier1): unknown {
  switch (ref.from) {
    case "input": {
      const v = inputAt(args, ref.field);
      if (v === undefined) {
        if (ref.orElse !== undefined) return ref.orElse;
        if (ref.optional) return ABSENT;
        // The input schema should have required it: a declaration that
        // names a field its own schema does not guarantee is the plugin's
        // defect, not the visitor's.
        throw new Error(`public run: input field "${ref.field}" is missing`);
      }
      if (ref.distinct && Array.isArray(v)) return [...new Set(v)];
      return ref.trim && typeof v === "string" ? v.trim() : v;
    }
    case "visitor":
      return ctx.visitor.id ?? null;
    case "const":
      return ref.value;
    case "now":
      return new Date().toISOString();
    case "today":
      return new Date().toISOString().slice(0, 10);
  }
}

function resolveAll(
  refs: Readonly<Record<string, PublicValueRef>>,
  args: unknown,
  ctx: PluginContextTier1,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, ref] of Object.entries(refs)) {
    const v = resolve(ref, args, ctx);
    if (v !== ABSENT) out[column] = v;
  }
  return out;
}

function answerOf(answer: PublicAnswer, insertedId: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(answer)) {
    out[key] = v !== null && typeof v === "object" && "from" in v ? insertedId : v;
  }
  return out;
}

function sourceQuery(ctx: PluginContextTier1, of: "schema" | "adminSchema") {
  if (of === "schema") return ctx.query;
  if (!ctx.adminQuery) {
    throw new Error(
      "public run: a check reads published admin data, but this call has no admin data handle (the plugin needs cms_admin_schema)",
    );
  }
  return ctx.adminQuery;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FormField {
  readonly name: string;
  readonly label: string;
  readonly type?: string;
  readonly required?: boolean;
}

/** A stored field definition; a broken one is the Owner's defect, a loud failure. */
function formFieldsOf(raw: unknown): FormField[] {
  const fields = (raw as { fields?: unknown } | null)?.fields;
  const ok =
    Array.isArray(fields) &&
    fields.length > 0 &&
    fields.every(
      (f) =>
        f !== null &&
        typeof f === "object" &&
        typeof (f as FormField).name === "string" &&
        typeof (f as FormField).label === "string",
    );
  if (!ok) {
    throw new Error(
      "public run: a stored field definition has no valid fields — re-create it with the plugin's admin tool",
    );
  }
  return fields as FormField[];
}

async function runCheck(check: PublicCheck, args: unknown, ctx: PluginContextTier1): Promise<void> {
  const value = inputAt(args, check.field);
  switch (check.check) {
    case "not-blank":
      if (typeof value !== "string" || value.trim() === "")
        throw new PublicOperationError(check.refusal);
      return;
    case "equals-row": {
      const rows = await sourceQuery(ctx, check.source.of).list(check.source.table, { limit: 1 });
      if (!rows[0] || rows[0][check.column] !== value)
        throw new PublicOperationError(check.refusal);
      return;
    }
    case "all-in": {
      if (!Array.isArray(value)) throw new PublicOperationError(check.refusal);
      const rows = await sourceQuery(ctx, check.source.of).list(check.source.table, {
        limit: 1000,
      });
      const known = new Set(rows.map((r) => r[check.column]));
      if (!value.every((v) => known.has(v))) throw new PublicOperationError(check.refusal);
      return;
    }
    case "form-fields": {
      const key = inputAt(args, check.keyField);
      const rows = await sourceQuery(ctx, check.source.of).list(check.source.table, {
        [check.keyColumn]: key,
        limit: 1,
      });
      if (!rows[0]) throw new PublicOperationError(check.missing);
      const fields = formFieldsOf(rows[0][check.definitionColumn]);
      const data = (value ?? {}) as Record<string, unknown>;
      const byName = new Map(fields.map((f) => [f.name, f]));
      for (const name of Object.keys(data))
        if (!byName.has(name)) throw new PublicOperationError(`this form has no field "${name}"`);
      for (const f of fields) {
        const v = data[f.name];
        const empty = v === undefined || v === null || String(v).trim() === "";
        if (f.required && (empty || v === false))
          throw new PublicOperationError(`"${f.label}" is required`);
        if (!empty && f.type === "email" && !EMAIL_RE.test(String(v)))
          throw new PublicOperationError(`"${f.label}" must be an email address`);
      }
      return;
    }
  }
}

function honeypotTripped(args: unknown, field: string): boolean {
  const v = inputAt(args, field);
  return typeof v === "string" && v.trim() !== "";
}

async function runInsert(
  run: Extract<PublicRun, { action: "insert" }>,
  args: unknown,
  ctx: PluginContextTier1,
): Promise<unknown> {
  if (run.honeypot && honeypotTripped(args, run.honeypot.field)) {
    // Same answer as a real submission: the bot learns nothing.
    if (run.honeypot.store === "nothing") return answerOf(run.honeypot.answer, null);
    const row = {
      ...resolveAll(run.values, args, ctx),
      ...resolveAll(run.honeypot.values ?? {}, args, ctx),
    };
    const r = await ctx.query.insert(run.table, row);
    return answerOf(run.honeypot.answer, r.id);
  }
  if (run.onlyIf) {
    const rows = await sourceQuery(ctx, run.onlyIf.source.of).list(run.onlyIf.source.table, {
      limit: 1,
    });
    if ((rows[0]?.[run.onlyIf.column] ?? null) !== run.onlyIf.equals)
      return answerOf(run.onlyIf.answer, null);
  }
  if (run.drop) {
    const v = inputAt(args, run.drop.field);
    if (typeof v === "string" && matchesDropPattern(v, run.drop.patterns))
      return answerOf(run.drop.answer, null);
  }
  for (const check of run.checks ?? []) await runCheck(check, args, ctx);
  const r = await ctx.query.insert(run.table, resolveAll(run.values, args, ctx));
  return answerOf(run.answer, r.id);
}

async function runList(
  run: Extract<PublicRun, { action: "list" }>,
  args: unknown,
  ctx: PluginContextTier1,
): Promise<unknown> {
  const filter: Record<string, unknown> = {
    ...resolveAll(run.where ?? {}, args, ctx),
    limit: run.limit,
  };
  if (run.orderBy) filter.orderBy = run.orderBy;
  if (run.orderDir) filter.orderDir = run.orderDir;
  const rows = await sourceQuery(ctx, run.of ?? "schema").list(run.table, filter);
  return {
    [run.as]: rows.map((r) => Object.fromEntries(run.columns.map((c) => [c, r[c] ?? null]))),
  };
}

/**
 * Run a public operation's declaration for one visitor call. `args` is the
 * body after the host's contract checks (captcha, input schema).
 */
export async function runDeclaredPublicOperation(
  op: PublicOperationDef,
  ctx: PluginContextTier1,
  args: unknown,
): Promise<unknown> {
  const run = op.run;
  switch (run.action) {
    case "insert":
      return runInsert(run, args, ctx);
    case "list":
      return runList(run, args, ctx);
    case "block": {
      const block = BLOCKS[run.block];
      if (!block) throw new Error(`public run: no core block "${run.block}"`);
      return block(ctx, args, run.options ?? {});
    }
  }
}
