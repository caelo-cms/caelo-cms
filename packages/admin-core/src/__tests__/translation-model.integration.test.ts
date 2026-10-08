// SPDX-License-Identifier: MPL-2.0

/**
 * #593 — configurable translation model, against a real Postgres.
 *
 *   - Resolution order: a call that declares purpose=translation runs on
 *     the active provider's translation model when one is stored, else on
 *     the chat model; a call without a purpose (the chat path) is never
 *     affected.
 *   - `ai_providers.set_translation_model` (Owner) accepts only the
 *     provider's catalogue models or NULL (= same as chat model).
 *   - The AI reaches it through the §11.A owner-settings gate:
 *     propose (preview with both models' rates) → Owner approve.
 *   - The cost dashboard reports plugin spend per model.
 *
 * Mutates ai_providers — every original row is captured in beforeAll and
 * restored in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { catalogModel } from "../ai/model-catalog.js";
import { configureProviderResolver, getActiveProviderForPurpose } from "../ai/provider-resolver.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const OWNER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000005f1",
  actorKind: "human",
  requestId: "translation-model-owner",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000005f2",
  actorKind: "ai",
  requestId: "translation-model-ai",
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "translation-model-system",
};
const PLUGIN_SLUG = "t593-cost-probe";

const CHAT_MODEL = catalogModel("anthropic", "default");
const FAST_MODEL = catalogModel("anthropic", "fast");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let savedProviders: Array<Record<string, unknown>> = [];
const savedEnv = {
  key: process.env.ANTHROPIC_API_KEY,
  override: process.env.CAELO_CHAT_MODEL_OVERRIDE,
};

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    let out!: T;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      out = await fn(tx as unknown as SQL);
    });
    return out;
  } finally {
    await sql.end();
  }
}

function value<T>(r: { ok: boolean }): T {
  if (!r.ok) throw new Error(`op failed: ${JSON.stringify(r)}`);
  return (r as unknown as { value: T }).value;
}

async function storedTranslationModel(): Promise<string | null> {
  return asSystem(async (tx) => {
    const rows =
      (await tx`SELECT translation_model FROM ai_providers WHERE name = 'anthropic'`) as {
        translation_model: string | null;
      }[];
    return rows[0]?.translation_model ?? null;
  });
}

beforeAll(async () => {
  await asSystem(async (tx) => {
    savedProviders = (await tx`SELECT * FROM ai_providers`) as Array<Record<string, unknown>>;
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER.actorId}::uuid, 'human', 't593-owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER.actorId}::uuid, 't593-owner@translation-model.test', 'test-only') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER.actorId}::uuid, id FROM roles WHERE name = 'owner' ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${AI.actorId}::uuid, 'ai', 't593-ai') ON CONFLICT DO NOTHING`;
    // One active provider (anthropic, key via env) with a stored chat model.
    await tx`DELETE FROM ai_providers`;
    await tx`INSERT INTO ai_providers (name, display_name, config, is_active)
             VALUES ('anthropic', 'Anthropic (Claude)', ${JSON.stringify({ model: CHAT_MODEL })}::jsonb, true)`;
    await tx`INSERT INTO ai_providers (name, display_name, config, is_active)
             VALUES ('local-openai-compat', 'Local', '{"model":"qwen2.5"}'::jsonb, false)`;
  });
  process.env.ANTHROPIC_API_KEY = "sk-ant-t593-not-a-real-key";
  delete process.env.CAELO_CHAT_MODEL_OVERRIDE;
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  configureProviderResolver({ adapter, registry });
});

afterAll(async () => {
  await asSystem(async (tx) => {
    await tx`DELETE FROM owner_settings_pending_actions WHERE proposed_by = ${AI.actorId}::uuid`;
    await tx`DELETE FROM ai_calls WHERE request_id = 't593'`;
    await tx`DELETE FROM plugins WHERE slug = ${PLUGIN_SLUG}`;
    await tx`DELETE FROM ai_providers`;
    for (const r of savedProviders) {
      const config = typeof r.config === "string" ? r.config : JSON.stringify(r.config);
      await tx`INSERT INTO ai_providers (id, name, display_name, config, is_active, created_at,
                 api_key_encrypted, api_key_iv, api_key_kek_fp, api_key_set_at, translation_model)
               VALUES (${r.id}::uuid, ${r.name}, ${r.display_name}, ${config}::jsonb, ${r.is_active},
                 ${r.created_at}, ${r.api_key_encrypted}, ${r.api_key_iv}, ${r.api_key_kek_fp},
                 ${r.api_key_set_at}, ${r.translation_model})`;
    }
  });
  if (savedEnv.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedEnv.key;
  if (savedEnv.override !== undefined) process.env.CAELO_CHAT_MODEL_OVERRIDE = savedEnv.override;
  await adapter.close();
});

describe("resolution order (purpose → model)", () => {
  it("with no translation model stored, translation runs on the chat model", async () => {
    const r = await getActiveProviderForPurpose("translation");
    expect(r?.providerName).toBe("anthropic");
    expect(r?.model).toBe(CHAT_MODEL);
  });

  it("with a translation model stored, translation uses it and the chat path does not", async () => {
    value(
      await execute(registry, adapter, OWNER, "ai_providers.set_translation_model", {
        name: "anthropic",
        model: FAST_MODEL,
      }),
    );
    expect((await getActiveProviderForPurpose("translation"))?.model).toBe(FAST_MODEL);
    expect((await getActiveProviderForPurpose(undefined))?.model).toBe(CHAT_MODEL);
    // A purpose the host has no setting for runs on the chat model.
    expect((await getActiveProviderForPurpose("summarize"))?.model).toBe(CHAT_MODEL);
  });

  it("clearing it (NULL) puts translation back on the chat model", async () => {
    value(
      await execute(registry, adapter, OWNER, "ai_providers.set_translation_model", {
        name: "anthropic",
        model: null,
      }),
    );
    expect(await storedTranslationModel()).toBeNull();
    expect((await getActiveProviderForPurpose("translation"))?.model).toBe(CHAT_MODEL);
  });
});

describe("ai_providers.set_translation_model", () => {
  it("rejects a model outside the provider's catalogue and names the choices", async () => {
    const r = await execute(registry, adapter, OWNER, "ai_providers.set_translation_model", {
      name: "anthropic",
      model: "gpt-5.5",
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain(FAST_MODEL);
  });

  it("a provider without a catalogue only takes NULL", async () => {
    const r = await execute(registry, adapter, OWNER, "ai_providers.set_translation_model", {
      name: "local-openai-compat",
      model: "qwen2.5",
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("no model catalogue");
  });

  it("an unconfigured provider is refused with the next step", async () => {
    const r = await execute(registry, adapter, OWNER, "ai_providers.set_translation_model", {
      name: "openai",
      model: null,
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("/security/ai");
  });

  it("the AI cannot set it directly", async () => {
    const r = await execute(registry, adapter, AI, "ai_providers.set_translation_model", {
      name: "anthropic",
      model: FAST_MODEL,
    });
    expect(r.ok).toBe(false);
    expect((r as { error: { kind: string } }).error.kind).toBe("ActorScopeRejected");
  });

  it("ai_providers.list reports the stored value (null = same as chat model)", async () => {
    const v = value<{ providers: Array<{ name: string; translationModel: string | null }> }>(
      await execute(registry, adapter, AI, "ai_providers.list", {}),
    );
    expect(v.providers.find((p) => p.name === "anthropic")?.translationModel).toBeNull();
  });
});

describe("owner_settings — translation model gate", () => {
  let proposalId = "";

  it("AI proposes: pending row whose preview shows both models", async () => {
    const v = value<{
      proposalId: string;
      preview: {
        provider: string;
        changes: { translationModel: { from: { label: string }; to: { model: string } } };
      };
    }>(
      await execute(registry, adapter, AI, "owner_settings.propose_set_translation_model", {
        model: FAST_MODEL,
      }),
    );
    proposalId = v.proposalId;
    expect(v.preview.provider).toBe("anthropic");
    expect(v.preview.changes.translationModel.from.label).toContain("same as chat model");
    expect(v.preview.changes.translationModel.to.model).toBe(FAST_MODEL);
    expect(await storedTranslationModel()).toBeNull();
  });

  it("a model outside the catalogue is refused at propose time", async () => {
    const r = await execute(registry, adapter, AI, "owner_settings.propose_set_translation_model", {
      model: "claude-made-up-1",
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("not in the anthropic model catalogue");
  });

  it("a no-op proposal is refused", async () => {
    const r = await execute(registry, adapter, AI, "owner_settings.propose_set_translation_model", {
      model: null,
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("nothing to change");
  });

  it("Owner approve stores the translation model", async () => {
    const v = value<{ kind: string }>(
      await execute(registry, adapter, OWNER, "owner_settings.execute_proposal", { proposalId }),
    );
    expect(v.kind).toBe("set_translation_model");
    expect(await storedTranslationModel()).toBe(FAST_MODEL);
    expect((await getActiveProviderForPurpose("translation"))?.model).toBe(FAST_MODEL);
  });
});

describe("cost dashboard — plugin spend per model", () => {
  it("ai_calls.aggregate splits a plugin's spend by the model the calls ran on", async () => {
    await asSystem(async (tx) => {
      const p = (await tx`
        INSERT INTO plugins (slug, version, tier, status, manifest_json, source_code, submitted_by)
        VALUES (${PLUGIN_SLUG}, '1.0.0', 2, 'awaiting_activation', '{}'::jsonb, '', ${OWNER.actorId}::uuid)
        RETURNING id::text AS id`) as { id: string }[];
      const pluginId = p[0]?.id as string;
      // Large costs so the rows rank inside the dashboard's top 20.
      for (const model of [CHAT_MODEL, FAST_MODEL]) {
        await tx`INSERT INTO ai_calls (actor_id, provider, model, input_tokens, output_tokens,
                   cost_estimate_microcents, plugin_id, operation_type, request_id)
                 VALUES (${SYSTEM.actorId}::uuid, 'anthropic', ${model}, 1, 1,
                   ${9_000_000_000_000}, ${pluginId}::uuid, 'text', 't593')`;
      }
    });
    const v = value<{
      perPlugin: Array<{ pluginSlug: string | null; provider: string; model: string }>;
    }>(await execute(registry, adapter, OWNER, "ai_calls.aggregate", {}));
    const mine = v.perPlugin.filter((r) => r.pluginSlug === PLUGIN_SLUG);
    expect(mine.map((r) => r.model).sort()).toEqual([CHAT_MODEL, FAST_MODEL].sort());
    expect(mine.every((r) => r.provider === "anthropic")).toBe(true);
  });
});
