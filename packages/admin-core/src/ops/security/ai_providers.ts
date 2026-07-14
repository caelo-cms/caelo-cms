// SPDX-License-Identifier: MPL-2.0

/**
 * AI provider configuration ops. Each row's API key is encrypted at rest
 * with the project KEK (see security/secret-box.ts) and exposed to the
 * ProviderResolver via a separate, system-only read path. The list op
 * NEVER projects the key bytes — only a `apiKeySource: 'db' | 'env' | null`
 * tag so the admin UI can render a "Source: DB ✓" badge.
 *
 * Writes stay Owner-only — provider config carries secrets and routing
 * decisions. Reads are open to AI ("which provider is active?").
 */

import { defineOperation } from "@caelo-cms/query-api";
import { aiProvidersClearKeyInput, aiProvidersSetInput, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { encryptSecret } from "../../security/secret-box.js";
import { jsonbParam } from "../../sql-helpers.js";

const PROVIDER_NAMES = ["anthropic", "openai", "google", "local-openai-compat"] as const;
type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Map provider name → legacy env var the resolver falls back to. */
function envNameFor(name: ProviderName): string {
  switch (name) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_API_KEY";
    case "local-openai-compat":
      return "LOCAL_OPENAI_API_KEY";
  }
}

const providerRow = z.object({
  id: z.string(),
  name: z.enum(PROVIDER_NAMES),
  displayName: z.string(),
  config: z.record(z.string(), z.unknown()),
  isActive: z.boolean(),
  /**
   * Where the resolver finds the API key for this provider.
   *  - 'db'   — encrypted row in cms_admin (preferred path).
   *  - 'env'  — falls back to process.env[envNameFor(name)] (legacy).
   *  - null   — no key configured anywhere → chat surfaces "configure".
   */
  apiKeySource: z.enum(["db", "env"]).nullable(),
  /** Wall-clock when the encrypted key was last set; NULL when source != 'db'. */
  apiKeySetAt: z.string().nullable(),
});

export const listAiProvidersOp = defineOperation({
  name: "ai_providers.list",
  // CLAUDE.md §11: read surface open to AI. Writes stay Owner-only.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({ providers: z.array(providerRow) }),
  handler: async (_ctx, _input, tx) => {
    // SECURITY: explicitly enumerate columns. NEVER include
    // api_key_encrypted / api_key_iv in the projection — the
    // resolver loads those via a separate system-context path.
    const rows = (await tx.execute(sql`
      SELECT
        id::text AS id,
        name,
        display_name,
        config,
        is_active,
        (api_key_encrypted IS NOT NULL) AS has_db_key,
        api_key_set_at
      FROM ai_providers
      ORDER BY created_at ASC
    `)) as unknown as {
      id: string;
      name: ProviderName;
      display_name: string;
      config: Record<string, unknown> | string;
      is_active: boolean;
      has_db_key: boolean;
      api_key_set_at: Date | string | null;
    }[];
    return ok({
      providers: rows.map((r) => {
        const apiKeySource: "db" | "env" | null = r.has_db_key
          ? "db"
          : process.env[envNameFor(r.name)]
            ? "env"
            : null;
        return {
          id: r.id,
          name: r.name,
          displayName: r.display_name,
          config: typeof r.config === "string" ? JSON.parse(r.config) : r.config,
          isActive: r.is_active,
          apiKeySource,
          apiKeySetAt:
            r.api_key_set_at instanceof Date ? r.api_key_set_at.toISOString() : r.api_key_set_at,
        };
      }),
    });
  },
});

export const setAiProvidersOp = defineOperation({
  name: "ai_providers.set",
  // Why human-only: Owner-only — provider config carries secrets and
  // routing decisions. AI can't paste a key.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: aiProvidersSetInput,
  output: z.object({ apiKeyChanged: z.boolean() }),
  handler: async (ctx, input, tx) => {
    if (input.isActive) {
      // Only one active provider at a time — chat runtime instantiates
      // exactly one. Owner can flip between them.
      await tx.execute(sql`UPDATE ai_providers SET is_active = false WHERE is_active = true`);
    }

    if (input.apiKey !== undefined) {
      // Encrypt + store + bump set_at + insert/upsert atomically.
      const enc = await encryptSecret(input.apiKey);
      // Convert Uint8Array → Buffer so node-postgres binds bytea correctly.
      const ctBuf = Buffer.from(enc.ciphertext);
      const ivBuf = Buffer.from(enc.iv);
      await tx.execute(sql`
        INSERT INTO ai_providers (
          name, display_name, config, is_active,
          api_key_encrypted, api_key_iv, api_key_kek_fp, api_key_set_at
        )
        VALUES (
          ${input.name},
          ${input.displayName},
          ${jsonbParam(input.config)},
          ${input.isActive},
          ${ctBuf},
          ${ivBuf},
          ${enc.kekFingerprint},
          now()
        )
        ON CONFLICT (name) DO UPDATE
          SET display_name      = EXCLUDED.display_name,
              config            = EXCLUDED.config,
              is_active         = EXCLUDED.is_active,
              api_key_encrypted = EXCLUDED.api_key_encrypted,
              api_key_iv        = EXCLUDED.api_key_iv,
              api_key_kek_fp    = EXCLUDED.api_key_kek_fp,
              api_key_set_at    = EXCLUDED.api_key_set_at
      `);
    } else {
      // No key in this update — preserve any existing encrypted triplet.
      await tx.execute(sql`
        INSERT INTO ai_providers (name, display_name, config, is_active)
        VALUES (
          ${input.name},
          ${input.displayName},
          ${jsonbParam(input.config)},
          ${input.isActive}
        )
        ON CONFLICT (name) DO UPDATE
          SET display_name = EXCLUDED.display_name,
              config       = EXCLUDED.config,
              is_active    = EXCLUDED.is_active
      `);
    }

    // pg_notify so the in-process resolver TTL invalidates instantly
    // (cross-process LISTEN consumer is a P18 follow-up).
    await tx.execute(sql`SELECT pg_notify('caelo_ai_providers', ${input.name})`);

    // Audit `apiKeyChanged: boolean`, NEVER the key value.
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "ai_providers.set",
      input: { ...input, apiKey: input.apiKey === undefined ? undefined : "[redacted]" },
      succeeded: true,
      resultSummary: `name=${input.name} active=${input.isActive} apiKeyChanged=${input.apiKey !== undefined}`,
    });
    return ok({ apiKeyChanged: input.apiKey !== undefined });
  },
});

export const clearAiProviderKeyOp = defineOperation({
  name: "ai_providers.clear_key",
  // Owner-only — wipes the encrypted key + falls back to env-var (or
  // null source if no env). Requires conscious user click.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: aiProvidersClearKeyInput,
  output: z.object({ cleared: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const result = (await tx.execute(sql`
      UPDATE ai_providers
         SET api_key_encrypted = NULL,
             api_key_iv        = NULL,
             api_key_kek_fp    = NULL,
             api_key_set_at    = NULL
       WHERE name = ${input.name}
         AND api_key_encrypted IS NOT NULL
       RETURNING name
    `)) as unknown as { name: string }[];
    const cleared = result.length > 0;

    if (cleared) {
      await tx.execute(sql`SELECT pg_notify('caelo_ai_providers', ${input.name})`);
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "ai_providers.clear_key",
      input,
      succeeded: true,
      resultSummary: `name=${input.name} cleared=${cleared}`,
    });
    return ok({ cleared });
  },
});

export const anyAiProviderConfiguredOp = defineOperation({
  name: "ai_providers.any_configured",
  // Open read — the post-setup redirect logic (in +layout.server.ts)
  // calls this for every authenticated request until it returns true.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({ anyConfigured: z.boolean() }),
  handler: async (_ctx, _input, tx) => {
    // Configured = at least one active provider with a usable key
    // (DB-stored OR matching env-var present).
    const rows = (await tx.execute(sql`
      SELECT name, (api_key_encrypted IS NOT NULL) AS has_db_key
      FROM ai_providers
      WHERE is_active = true
    `)) as unknown as { name: ProviderName; has_db_key: boolean }[];

    const anyConfigured = rows.some(
      (r) => r.has_db_key || Boolean(process.env[envNameFor(r.name)]),
    );
    return ok({ anyConfigured });
  },
});
