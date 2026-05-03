// SPDX-License-Identifier: MPL-2.0

/**
 * P11 — plugins registry + lifecycle ops.
 *
 * Two-tier model. Tier 2 plugins flow:
 *   submit (AI) → validator → status='awaiting_activation' (validation OK)
 *                          OR status='draft' (validation failed; AI auto-fixes from
 *                                             structured failures and resubmits)
 *               → Owner clicks Approve → route handler provisions cms_public
 *                                        schema via adapter.provisionPluginPublicSchema
 *                                        → activate op records the migration row
 *                                          and flips status='active'
 *               → disable → status='disabled' (data preserved)
 *               → re-activate (disabled→active) → no DDL re-run; just status flip
 *
 * Tier 1 plugins flow:
 *   host startup → load packages/plugins/<slug>/ → verify signature
 *               → run validator (defense-in-depth) → upsert plugins row
 *                 with tier=1, status='active'.
 *   This file does NOT do the Tier 1 startup load (that's @caelo/plugin-host
 *   in P11.5+); it only ships the ops that read + mutate the registry.
 */

import { applyPluginLifecycle } from "@caelo/plugin-host";
import { type EmittedSchema, schemaFromSpec, validatePlugin } from "@caelo/plugin-sandbox";
import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

// ---------------------------------------------------------------------------
// Output shapes.
// ---------------------------------------------------------------------------

const validationFailureRow = z.object({
  kind: z.string(),
  nodeType: z.string().optional(),
  snippet: z.string().optional(),
  location: z.object({ line: z.number().int(), column: z.number().int() }).optional(),
  hint: z.string(),
});

const pluginStatus = z.enum([
  "draft",
  "awaiting_activation",
  "active",
  "disabled",
  "rejected",
  "failed",
]);

const pluginRow = z.object({
  id: z.string(),
  slug: z.string(),
  version: z.string(),
  tier: z.union([z.literal(1), z.literal(2)]),
  status: pluginStatus,
  manifestJson: z.unknown(),
  sourceCode: z.string().nullable(),
  sourcePath: z.string().nullable(),
  validationErrors: z.array(validationFailureRow),
  manifestSignature: z.string().nullable(),
  submittedBy: z.string(),
  activatedBy: z.string().nullable(),
  activatedAt: z.string().nullable(),
  disabledBy: z.string().nullable(),
  disabledAt: z.string().nullable(),
  rejectedBy: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

interface PluginDb {
  id: string;
  slug: string;
  version: string;
  tier: number;
  status: string;
  manifest_json: unknown;
  source_code: string | null;
  source_path: string | null;
  validation_errors: unknown;
  manifest_signature: string | null;
  submitted_by: string;
  activated_by: string | null;
  activated_at: string | Date | null;
  disabled_by: string | null;
  disabled_at: string | Date | null;
  rejected_by: string | null;
  rejected_at: string | Date | null;
  rejection_reason: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToOut(r: PluginDb): z.infer<typeof pluginRow> {
  return {
    id: r.id,
    slug: r.slug,
    version: r.version,
    tier: r.tier === 1 ? 1 : 2,
    status: r.status as z.infer<typeof pluginStatus>,
    manifestJson:
      typeof r.manifest_json === "string" ? JSON.parse(r.manifest_json) : r.manifest_json,
    sourceCode: r.source_code,
    sourcePath: r.source_path,
    validationErrors: parseValidationErrors(r.validation_errors),
    manifestSignature: r.manifest_signature,
    submittedBy: r.submitted_by,
    activatedBy: r.activated_by,
    activatedAt: tsToIso(r.activated_at),
    disabledBy: r.disabled_by,
    disabledAt: tsToIso(r.disabled_at),
    rejectedBy: r.rejected_by,
    rejectedAt: tsToIso(r.rejected_at),
    rejectionReason: r.rejection_reason,
    createdAt: tsToIso(r.created_at) ?? "",
    updatedAt: tsToIso(r.updated_at) ?? "",
  };
}

function tsToIso(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function parseValidationErrors(v: unknown): z.infer<typeof validationFailureRow>[] {
  const raw = typeof v === "string" ? JSON.parse(v) : (v ?? []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => validationFailureRow.safeParse(entry))
    .filter((p): p is { success: true; data: z.infer<typeof validationFailureRow> } => p.success)
    .map((p) => p.data);
}

// ---------------------------------------------------------------------------
// Reads — open to all in-scope actors.
// ---------------------------------------------------------------------------

export const listPluginsOp = defineOperation({
  name: "plugins.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      tier: z.union([z.literal(1), z.literal(2)]).optional(),
      status: pluginStatus.optional(),
    })
    .strict()
    .default({}),
  output: z.object({ plugins: z.array(pluginRow) }),
  handler: async (_ctx, input, tx) => {
    const filters = [];
    if (input.tier !== undefined) filters.push(sql`tier = ${input.tier}`);
    if (input.status !== undefined) filters.push(sql`status = ${input.status}`);
    const where =
      filters.length === 0
        ? sql``
        : sql`WHERE ${filters.reduce((acc, f, i) => (i === 0 ? f : sql`${acc} AND ${f}`))}`;
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, version, tier, status,
             manifest_json, source_code, source_path,
             validation_errors, manifest_signature,
             submitted_by::text AS submitted_by,
             activated_by::text AS activated_by, activated_at,
             disabled_by::text AS disabled_by, disabled_at,
             rejected_by::text AS rejected_by, rejected_at, rejection_reason,
             created_at, updated_at
      FROM plugins
      ${where}
      ORDER BY tier ASC, slug ASC
    `)) as unknown as PluginDb[];
    return ok({ plugins: rows.map(rowToOut) });
  },
});

export const getPluginOp = defineOperation({
  name: "plugins.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ slug: z.string().min(1).max(120) }).strict(),
  output: z.object({ plugin: pluginRow.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, version, tier, status,
             manifest_json, source_code, source_path,
             validation_errors, manifest_signature,
             submitted_by::text AS submitted_by,
             activated_by::text AS activated_by, activated_at,
             disabled_by::text AS disabled_by, disabled_at,
             rejected_by::text AS rejected_by, rejected_at, rejection_reason,
             created_at, updated_at
      FROM plugins WHERE slug = ${input.slug} LIMIT 1
    `)) as unknown as PluginDb[];
    const r = rows[0];
    return ok({ plugin: r ? rowToOut(r) : null });
  },
});

// ---------------------------------------------------------------------------
// Submit — Tier 2 only. AI scope. Validates + persists; never activates.
// ---------------------------------------------------------------------------

export const submitPluginOp = defineOperation({
  name: "plugins.submit",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      slug: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-z][a-z0-9-]*$/),
      version: z
        .string()
        .min(1)
        .max(40)
        .regex(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/),
      manifest: z.unknown(),
      source: z.string().min(1).max(200_000),
    })
    .strict(),
  output: z.object({
    pluginId: z.string(),
    status: pluginStatus,
    validationErrors: z.array(validationFailureRow),
  }),
  handler: async (ctx, input, tx) => {
    // Force tier=2 regardless of what the manifest claims; the AI tool
    // surface is Tier 2 only.
    const rawManifest = input.manifest as { tier?: unknown } | null;
    if (rawManifest && typeof rawManifest === "object" && "tier" in rawManifest) {
      if (rawManifest.tier !== 2) {
        return err({
          kind: "HandlerError",
          operation: "plugins.submit",
          message:
            "plugins.submit accepts Tier 2 only. Tier 1 plugins ship via human PR + signed release; the AI tool surface cannot promote.",
        });
      }
    }
    const validation = validatePlugin({
      manifest: input.manifest,
      source: input.source,
      filename: `${input.slug}.ts`,
    });
    const status: z.infer<typeof pluginStatus> = validation.ok ? "awaiting_activation" : "draft";
    const validationErrorsJson = JSON.stringify(validation.failures);

    // Upsert by slug — re-submitting the same plugin overwrites the
    // previous draft. Activation gates re-submitting an active plugin
    // (it must be disabled first; the constraint is on status flow).
    const rows = (await tx.execute(sql`
      INSERT INTO plugins (
        slug, version, tier, status,
        manifest_json, source_code, validation_errors,
        submitted_by
      ) VALUES (
        ${input.slug}, ${input.version}, 2, ${status},
        ${JSON.stringify(input.manifest)}::jsonb,
        ${input.source},
        ${validationErrorsJson}::jsonb,
        ${ctx.actorId}::uuid
      )
      ON CONFLICT (slug) DO UPDATE SET
        version = EXCLUDED.version,
        status = EXCLUDED.status,
        manifest_json = EXCLUDED.manifest_json,
        source_code = EXCLUDED.source_code,
        validation_errors = EXCLUDED.validation_errors,
        submitted_by = EXCLUDED.submitted_by,
        updated_at = now()
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "plugins.submit",
        message: "no id returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.submit",
      input: { slug: input.slug, version: input.version },
      succeeded: validation.ok,
      entityId: id,
      resultSummary: validation.ok
        ? `validated tier=2 status=${status}`
        : `validation_failed errors=${validation.failures.length}`,
    });
    return ok({
      pluginId: id,
      status,
      validationErrors: validation.failures.map((f) => ({ ...f })),
    });
  },
});

// ---------------------------------------------------------------------------
// list_pending — AI's own pending or rejected submissions, used by the
// `## Plugins` system-prompt block so the AI doesn't re-propose what's
// already in the queue and reads its own rejection reasons.
// ---------------------------------------------------------------------------

export const listPendingPluginsOp = defineOperation({
  name: "plugins.list_pending",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      // Loose UUID shape — Zod 4's strict uuid() rejects fixture UUIDs
      // like 00000000-0000-0000-0000-00000000ffff. The handler treats
      // this purely as an opaque actor id passed to a parameterised
      // SQL filter, so format-check is sufficient.
      submittedBy: z
        .string()
        .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
        .optional(),
    })
    .strict()
    .default({}),
  output: z.object({
    plugins: z.array(
      z.object({
        slug: z.string(),
        version: z.string(),
        status: pluginStatus,
        validationErrorCount: z.number().int().nonnegative(),
        rejectionReason: z.string().nullable(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = input.submittedBy
      ? ((await tx.execute(sql`
          SELECT slug, version, status, validation_errors, rejection_reason
          FROM plugins
          WHERE tier = 2
            AND status IN ('draft','awaiting_activation','rejected')
            AND submitted_by = ${input.submittedBy}::uuid
          ORDER BY updated_at DESC
          LIMIT 50
        `)) as unknown as Array<{
          slug: string;
          version: string;
          status: string;
          validation_errors: unknown;
          rejection_reason: string | null;
        }>)
      : ((await tx.execute(sql`
          SELECT slug, version, status, validation_errors, rejection_reason
          FROM plugins
          WHERE tier = 2
            AND status IN ('draft','awaiting_activation','rejected')
          ORDER BY updated_at DESC
          LIMIT 50
        `)) as unknown as Array<{
          slug: string;
          version: string;
          status: string;
          validation_errors: unknown;
          rejection_reason: string | null;
        }>);
    return ok({
      plugins: rows.map((r) => {
        const errs =
          typeof r.validation_errors === "string"
            ? (JSON.parse(r.validation_errors) as unknown)
            : (r.validation_errors ?? []);
        return {
          slug: r.slug,
          version: r.version,
          status: r.status as z.infer<typeof pluginStatus>,
          validationErrorCount: Array.isArray(errs) ? errs.length : 0,
          rejectionReason: r.rejection_reason,
        };
      }),
    });
  },
});

// ---------------------------------------------------------------------------
// Activate (3-step: prepare → external DDL → commit).
//
//   plugins.prepare_activation(slug)  — cms_admin, validates state,
//                                        emits the SQL, returns it.
//                                        Does NOT mutate.
//   adapter.provisionPluginPublicSchema — cms_public, runs the DDL.
//                                        Idempotent.
//   plugins.commit_activation(slug, schemaName, appliedSql, version) —
//     cms_admin, records the migration row, flips status='active',
//     creates per-plugin actor row.
//
// On commit failure the route handler calls
// adapter.dropPluginPublicSchema(schemaName) so the cms_public side
// doesn't leak.
//
// Re-enabling a disabled plugin skips DDL entirely — provision is
// already in place; just flips status. That path is the legacy single-op
// shape kept under `plugins.activate` for the disabled→active case.
// ---------------------------------------------------------------------------

export const preparePluginActivationOp = defineOperation({
  name: "plugins.prepare_activation",
  // Why human-only: returns the DDL that the route will run on
  // cms_public. Owner gate; CLAUDE.md §2.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ slug: z.string().min(1).max(120) }).strict(),
  output: z.object({
    pluginId: z.string(),
    version: z.string(),
    schemaName: z.string(),
    appliedSql: z.string(),
    /** When true the caller should skip provisioning + commit and just
     *  call plugins.activate (re-enable path). */
    isReEnable: z.boolean(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, tier, status, manifest_json, version
      FROM plugins
      WHERE slug = ${input.slug}
    `)) as unknown as Array<{
      id: string;
      tier: number;
      status: string;
      manifest_json: unknown;
      version: string;
    }>;
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "plugins.prepare_activation",
        message: `no plugin with slug "${input.slug}"`,
      });
    }
    if (r.tier !== 2) {
      return err({
        kind: "HandlerError",
        operation: "plugins.prepare_activation",
        message: "Tier 1 plugins are auto-activated by the host loader.",
      });
    }
    if (r.status !== "awaiting_activation" && r.status !== "disabled") {
      return err({
        kind: "HandlerError",
        operation: "plugins.prepare_activation",
        message: `plugin "${input.slug}" status is "${r.status}"; expected awaiting_activation or disabled.`,
      });
    }
    const schemaName = `plugin_${input.slug.replace(/-/g, "_")}`;
    if (r.status === "disabled") {
      return ok({
        pluginId: r.id,
        version: r.version,
        schemaName,
        appliedSql: "",
        isReEnable: true,
      });
    }
    const manifest =
      typeof r.manifest_json === "string"
        ? (JSON.parse(r.manifest_json) as { schema?: Record<string, Record<string, string>> })
        : (r.manifest_json as { schema?: Record<string, Record<string, string>> });
    if (!manifest?.schema || typeof manifest.schema !== "object") {
      return err({
        kind: "HandlerError",
        operation: "plugins.prepare_activation",
        message: "manifest missing `schema` — re-submit",
      });
    }
    let emitted: EmittedSchema;
    try {
      emitted = schemaFromSpec({
        pluginId: r.id,
        slug: input.slug,
        schema: manifest.schema,
      });
    } catch (e) {
      return err({
        kind: "HandlerError",
        operation: "plugins.prepare_activation",
        message: `schema emission failed: ${(e as Error).message}`,
      });
    }
    return ok({
      pluginId: r.id,
      version: r.version,
      schemaName: emitted.schemaName,
      appliedSql: emitted.sql,
      isReEnable: false,
    });
  },
});

export const activatePluginOp = defineOperation({
  name: "plugins.activate",
  // Why human-only: writes the migration row, flips status, creates
  // the per-plugin actor row. Owner click; CLAUDE.md §2.
  // The caller must have already run prepare_activation + provisioned
  // the cms_public schema OR this is the disabled→active re-enable
  // path (no DDL needed; activate alone flips status).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      slug: z.string().min(1).max(120),
      /** Required when transitioning awaiting_activation → active.
       *  Omitted on the disabled → active re-enable path. */
      schemaName: z.string().min(1).max(200).optional(),
      appliedSql: z.string().max(200_000).optional(),
      version: z.string().min(1).max(40).optional(),
    })
    .strict(),
  output: z.object({
    schemaName: z.string(),
    appliedSql: z.string(),
    actorId: z.string(),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, tier, status, version
      FROM plugins
      WHERE slug = ${input.slug}
      FOR UPDATE
    `)) as unknown as Array<{
      id: string;
      tier: number;
      status: string;
      version: string;
    }>;
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "plugins.activate",
        message: `no plugin with slug "${input.slug}"`,
      });
    }
    if (r.tier !== 2) {
      return err({
        kind: "HandlerError",
        operation: "plugins.activate",
        message: "Tier 1 plugins are auto-activated by the host loader.",
      });
    }
    if (r.status !== "awaiting_activation" && r.status !== "disabled") {
      return err({
        kind: "HandlerError",
        operation: "plugins.activate",
        message: `plugin "${input.slug}" status is "${r.status}"; expected awaiting_activation or disabled.`,
      });
    }

    const schemaName = input.schemaName ?? `plugin_${input.slug.replace(/-/g, "_")}`;

    // Re-enable: schema already provisioned. Skip migration row + DDL.
    if (r.status === "disabled") {
      const existing = (await tx.execute(sql`
        SELECT applied_sql FROM plugin_schema_migrations
        WHERE plugin_id = ${r.id}::uuid
        ORDER BY applied_at DESC LIMIT 1
      `)) as unknown as { applied_sql: string }[];
      await tx.execute(sql`
        UPDATE plugins
        SET status = 'active',
            activated_by = ${ctx.actorId}::uuid,
            activated_at = now(),
            disabled_by = NULL,
            disabled_at = NULL,
            updated_at = now()
        WHERE id = ${r.id}::uuid
      `);
      const actorId = await upsertPluginActor(tx, r.id, input.slug);
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "plugins.activate",
        input,
        succeeded: true,
        entityId: r.id,
        resultSummary: "tier=2 re-enabled",
      });
      // Audit fix #2: hot-update the live host. Tools reappear in the
      // AI's catalogue, workers resume, dispatch flips back to ok.
      applyPluginLifecycle(input.slug, "enable");
      return ok({
        schemaName,
        appliedSql: existing[0]?.applied_sql ?? "",
        actorId,
      });
    }

    // Fresh activate: provision SQL must come from prepare_activation.
    if (!input.appliedSql || !input.version) {
      return err({
        kind: "HandlerError",
        operation: "plugins.activate",
        message:
          "appliedSql + version required for awaiting_activation → active. Call plugins.prepare_activation first.",
      });
    }
    if (input.version !== r.version) {
      return err({
        kind: "HandlerError",
        operation: "plugins.activate",
        message: `version mismatch: prepare returned ${input.version}, plugin row is ${r.version}. Re-prepare and retry.`,
      });
    }
    await tx.execute(sql`
      INSERT INTO plugin_schema_migrations (plugin_id, applied_for_version, applied_sql)
      VALUES (${r.id}::uuid, ${r.version}, ${input.appliedSql})
    `);
    await tx.execute(sql`
      UPDATE plugins
      SET status = 'active',
          activated_by = ${ctx.actorId}::uuid,
          activated_at = now(),
          disabled_by = NULL,
          disabled_at = NULL,
          updated_at = now()
      WHERE id = ${r.id}::uuid
    `);
    const actorId = await upsertPluginActor(tx, r.id, input.slug);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.activate",
      input: { slug: input.slug, version: input.version },
      succeeded: true,
      entityId: r.id,
      resultSummary: `tier=2 schema=${schemaName} actor=${actorId}`,
    });
    // Audit fix #2: ensure the live host's disabled-flag (if any from
    // a prior session) is cleared. New activations default to enabled
    // already; this is defense-in-depth.
    applyPluginLifecycle(input.slug, "enable");
    return ok({ schemaName, appliedSql: input.appliedSql, actorId });
  },
});

/**
 * Idempotently create the per-plugin actor row used by P13's
 * `plugins.run_operation` dispatcher. The Database Adapter sets
 * `caelo.actor_id = <this row's id>` and `caelo.plugin_id = <pluginId>`
 * so RLS on `cms_public.plugin_<slug>.*` matches the per-plugin policy.
 *
 * Why an actor: every Query API write tags audit + snapshot rows with
 * an actor_id; without one the plugin's writes can't be attributed.
 */
async function upsertPluginActor(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  pluginId: string,
  slug: string,
): Promise<string> {
  const rows = (await tx.execute(sql`
    INSERT INTO actors (kind, display_name, plugin_id)
    VALUES ('plugin', ${"Plugin: " + slug}, ${pluginId}::uuid)
    ON CONFLICT (plugin_id) WHERE plugin_id IS NOT NULL DO UPDATE
      SET display_name = EXCLUDED.display_name
    RETURNING id::text AS id
  `)) as unknown as { id: string }[];
  const id = rows[0]?.id;
  if (!id) throw new Error("upsertPluginActor: no id returned");
  return id;
}

// ---------------------------------------------------------------------------
// Disable — both tiers, human/system only.
// ---------------------------------------------------------------------------

export const disablePluginOp = defineOperation({
  name: "plugins.disable",
  // Why human-only: stops dispatching plugin operations across the
  // site. Owner gate.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ slug: z.string().min(1).max(120) }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE plugins
      SET status = 'disabled',
          disabled_by = ${ctx.actorId}::uuid,
          disabled_at = now(),
          updated_at = now()
      WHERE slug = ${input.slug} AND status = 'active'
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "plugins.disable",
        message: `no active plugin with slug "${input.slug}"`,
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.disable",
      input,
      succeeded: true,
      entityId: id,
    });
    // Audit fix #2: hot-update the live host. Tools drop from the AI's
    // catalogue, workers pause, dispatch returns PluginDisabled — all
    // without a process restart.
    applyPluginLifecycle(input.slug, "disable");
    return ok({});
  },
});

// ---------------------------------------------------------------------------
// Reject — Tier 2 plugins the Owner declines. Flips status='rejected'
// (preserves audit + the structured validator errors + the source so
// the AI can read its own draft, fix per the Owner's reason, and
// resubmit). DELETE-on-reject was the v1 shape; opt-5 changes it.
// ---------------------------------------------------------------------------

export const rejectPluginOp = defineOperation({
  name: "plugins.reject",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      slug: z.string().min(1).max(120),
      reason: z.string().max(2000).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE plugins
      SET status = 'rejected',
          rejected_by = ${ctx.actorId}::uuid,
          rejected_at = now(),
          rejection_reason = ${input.reason ?? null},
          updated_at = now()
      WHERE slug = ${input.slug}
        AND tier = 2
        AND status IN ('draft', 'awaiting_activation')
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "plugins.reject",
        message: `no Tier 2 plugin with slug "${input.slug}" awaiting activation`,
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.reject",
      input,
      succeeded: true,
      entityId: id,
      resultSummary: input.reason ?? "rejected",
    });
    return ok({});
  },
});

// ---------------------------------------------------------------------------
// Revalidate — re-runs the validator over the stored Tier 2 source.
// Owner-triggered after a Caelo upgrade in case the validator caught
// something the older version missed.
// ---------------------------------------------------------------------------

export const revalidatePluginOp = defineOperation({
  name: "plugins.revalidate",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ slug: z.string().min(1).max(120) }).strict(),
  output: z.object({
    status: pluginStatus,
    validationErrors: z.array(validationFailureRow),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, tier, manifest_json, source_code
      FROM plugins WHERE slug = ${input.slug}
      FOR UPDATE
    `)) as unknown as Array<{
      id: string;
      tier: number;
      manifest_json: unknown;
      source_code: string | null;
    }>;
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "plugins.revalidate",
        message: `no plugin with slug "${input.slug}"`,
      });
    }
    if (r.tier !== 2 || r.source_code === null) {
      return err({
        kind: "HandlerError",
        operation: "plugins.revalidate",
        message: "plugins.revalidate runs only on Tier 2 (source_code in DB)",
      });
    }
    const manifestObj =
      typeof r.manifest_json === "string" ? JSON.parse(r.manifest_json) : r.manifest_json;
    const validation = validatePlugin({
      manifest: manifestObj,
      source: r.source_code,
      filename: `${input.slug}.ts`,
    });
    const status: z.infer<typeof pluginStatus> = validation.ok ? "awaiting_activation" : "draft";
    await tx.execute(sql`
      UPDATE plugins
      SET status = ${status},
          validation_errors = ${JSON.stringify(validation.failures)}::jsonb,
          updated_at = now()
      WHERE id = ${r.id}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.revalidate",
      input,
      succeeded: validation.ok,
      entityId: r.id,
      resultSummary: `status=${status} errors=${validation.failures.length}`,
    });
    return ok({
      status,
      validationErrors: validation.failures.map((f) => ({ ...f })),
    });
  },
});
