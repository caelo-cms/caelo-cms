// SPDX-License-Identifier: MPL-2.0

/**
 * Provider configuration ops. API keys live in the secrets manager / env;
 * `name` is the lookup key. P5 ships only the "anthropic" provider; P16
 * widens. The active provider is the one the chat runtime instantiates.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { aiProvidersSetInput, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

const providerRow = z.object({
  id: z.string(),
  name: z.enum(["anthropic", "openai", "google", "local-openai-compat"]),
  displayName: z.string(),
  config: z.record(z.string(), z.unknown()),
  isActive: z.boolean(),
});

export const listAiProvidersOp = defineOperation({
  name: "ai_providers.list",
  // CLAUDE.md §11: read surface open to AI ("which provider is
  // active?"). Writes stay Owner-only — provider config carries
  // secrets and routing decisions.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({ providers: z.array(providerRow) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, name, display_name, config, is_active
      FROM ai_providers ORDER BY created_at ASC
    `)) as unknown as {
      id: string;
      name: "anthropic" | "openai" | "google" | "local-openai-compat";
      display_name: string;
      config: Record<string, unknown> | string;
      is_active: boolean;
    }[];
    return ok({
      providers: rows.map((r) => ({
        id: r.id,
        name: r.name,
        displayName: r.display_name,
        config: typeof r.config === "string" ? JSON.parse(r.config) : r.config,
        isActive: r.is_active,
      })),
    });
  },
});

export const setAiProvidersOp = defineOperation({
  name: "ai_providers.set",
  // Why human-only: Owner-only — provider config carries secrets and routing decisions.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: aiProvidersSetInput,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    if (input.isActive) {
      // Only one active provider at a time — chat runtime instantiates
      // exactly one. Owner can flip between them.
      await tx.execute(sql`UPDATE ai_providers SET is_active = false WHERE is_active = true`);
    }
    await tx.execute(sql`
      INSERT INTO ai_providers (name, display_name, config, is_active)
      VALUES (${input.name}, ${input.displayName}, ${JSON.stringify(input.config)}::jsonb, ${input.isActive})
      ON CONFLICT (name) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            config = EXCLUDED.config,
            is_active = EXCLUDED.is_active
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "ai_providers.set",
      input,
      succeeded: true,
      resultSummary: `name=${input.name} active=${input.isActive}`,
    });
    return ok({});
  },
});
