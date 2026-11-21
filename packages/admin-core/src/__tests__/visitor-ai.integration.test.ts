// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R4, issue #1654) — the visitor AI on the admin side:
 *
 * - its settings are the Owner's: the AI reads and proposes them (§11.A),
 *   cannot set them, and switching it on needs a live key for the provider;
 * - the key goes to a write-only store after its provider accepted it, and
 *   only the provider and the time reach cms_admin — never the key, which
 *   is also nowhere in cms_public;
 * - `requires: ["visitor-ai"]` refuses activation while it cannot run;
 * - the settings reach the gateways with the `settings` section, staging
 *   with its own budget and key state;
 * - the spend is read from the gateway's ledger, row by row, as untrusted.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { unmetHostRequirement } from "../ops/plugins/registry.js";
import { drainProjectionOnce, stagingPublicAdapter } from "../public-projection.js";
import { registerAdminOps } from "../register.js";
import { removeVisitorAiKey, storeVisitorAiKey } from "../visitor-ai/key-actions.js";
import {
  type VisitorAiKeyPayload,
  VisitorAiKeyStoreUnavailable,
  visitorAiKeyStore,
} from "../visitor-ai/key-store.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL as string;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL as string;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL as string;
const STAGING_ADMIN_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL as string;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL || !STAGING_ADMIN_URL)
  throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const OWNER: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "human",
  requestId: "t1654",
};
const SYSTEM: ExecutionContext = { ...OWNER, actorKind: "system" };
const AI: ExecutionContext = { ...OWNER, actorKind: "ai" };
const KEY = "sk-ant-api03-t1654-0123456789abcdefghij";

let adapter: DatabaseAdapter;
let staging: DatabaseAdapter;
let registry: OperationRegistry;
let saved: Record<string, unknown> | null = null;
let dir = "";

async function onDb<T>(url: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const conn = new SQL(url);
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await conn.end();
  }
}

/** A store that records what it was given. */
function memoryStores() {
  const written: Record<string, VisitorAiKeyPayload[]> = { live: [], staging: [] };
  return {
    written,
    store: (environment: "live" | "staging") => ({
      describe: `memory ${environment}`,
      write: async (p: VisitorAiKeyPayload) => {
        written[environment]?.push(p);
      },
    }),
  };
}

const accepts = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
const refuses = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

beforeAll(async () => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  staging = stagingPublicAdapter(STAGING_ADMIN_URL);
  registry = new OperationRegistry();
  registerAdminOps(registry);
  saved = await onDb(
    ADMIN_URL,
    async (tx) =>
      (
        (await tx`SELECT * FROM visitor_ai_settings WHERE id = 1`) as Record<string, unknown>[]
      )[0] ?? null,
  );
  dir = await mkdtemp(join(tmpdir(), "caelo-t1654-admin-"));
});

afterAll(async () => {
  const s = saved;
  if (s)
    await onDb(ADMIN_URL, async (tx) => {
      await tx`UPDATE visitor_ai_settings SET enabled = ${s.enabled as boolean}, provider = ${s.provider as string},
        model = ${s.model as string}, daily_budget_microcents = ${String(s.daily_budget_microcents)}::bigint,
        monthly_budget_microcents = ${String(s.monthly_budget_microcents)}::bigint,
        conversation_budget_microcents = ${String(s.conversation_budget_microcents)}::bigint,
        staging_daily_budget_microcents = ${String(s.staging_daily_budget_microcents)}::bigint,
        live_key_provider = NULL, live_key_set_at = NULL, staging_key_provider = NULL, staging_key_set_at = NULL
        WHERE id = 1`;
    });
  await drainProjectionOnce(adapter, staging);
  await adapter.close();
  await staging.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the visitor AI's settings (#1654, §11.A)", () => {
  it("are off by default, readable by the AI, and not settable by it", async () => {
    const got = await execute(registry, adapter, AI, "visitor_ai.get", {});
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    const v = got.value as {
      settings: Record<string, unknown>;
      blocked: string;
      providerLimitHint: string;
    };
    expect(v.settings).toMatchObject({
      enabled: false,
      provider: "anthropic",
      model: "claude-haiku-5-5",
    });
    expect(v.blocked).toBe("the visitor AI is switched off");
    expect(v.providerLimitHint).toContain("spending limit");
    const direct = await execute(registry, adapter, AI, "visitor_ai.set", {
      ...v.settings,
      enabled: true,
    });
    expect(direct.ok).toBe(false);
    const record = await execute(registry, adapter, AI, "visitor_ai.record_key", {
      environment: "live",
      provider: "anthropic",
    });
    expect(record.ok).toBe(false);
  });

  it("switch on only once the Owner stored a key the provider accepts", async () => {
    const proposed = await execute(registry, adapter, AI, "owner_settings.propose_set_visitor_ai", {
      enabled: true,
      dailyBudgetUsd: 3,
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const { proposalId, preview } = proposed.value as {
      proposalId: string;
      preview: { keyNeeded: boolean; summary: string };
    };
    expect(preview.keyNeeded).toBe(true);
    expect(preview.summary).toContain("paste the anthropic key on this card");
    const early = await execute(registry, adapter, SYSTEM, "owner_settings.execute_proposal", {
      proposalId,
    });
    expect(early.ok).toBe(false);
    expect(JSON.stringify(early.ok ? null : early.error)).toContain("no anthropic key is stored");

    const stores = memoryStores();
    const refused = await storeVisitorAiKey(
      registry,
      adapter,
      OWNER,
      { provider: "anthropic", apiKey: KEY, staging: "same" },
      { store: stores.store, fetch: refuses },
    );
    expect(refused.ok).toBe(false);
    expect(stores.written.live).toEqual([]);

    const stored = await storeVisitorAiKey(
      registry,
      adapter,
      OWNER,
      { provider: "anthropic", apiKey: KEY, staging: "none" },
      { store: stores.store, fetch: accepts },
    );
    expect(stored).toEqual({ ok: true, stored: ["live", "staging"] });
    expect(stores.written.live).toEqual([{ provider: "anthropic", apiKey: KEY }]);
    expect(stores.written.staging).toEqual([null]);

    const applied = await execute(registry, adapter, SYSTEM, "owner_settings.execute_proposal", {
      proposalId,
    });
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));
    const after = await execute(registry, adapter, AI, "visitor_ai.get", {});
    const v = (after.ok ? after.value : null) as {
      settings: { enabled: boolean; dailyBudgetUsd: number };
      keys: { live: { provider: string | null }; staging: { provider: string | null } };
      blocked: string | null;
    };
    expect(v.settings).toMatchObject({ enabled: true, dailyBudgetUsd: 3 });
    expect(v.keys.live.provider).toBe("anthropic");
    expect(v.keys.staging.provider).toBeNull();
    expect(v.blocked).toBeNull();
  });

  it("never holds the key in a database", async () => {
    const admin = await onDb(ADMIN_URL, async (tx) =>
      JSON.stringify([
        await tx`SELECT * FROM visitor_ai_settings`,
        await tx`SELECT payload, preview FROM owner_settings_pending_actions WHERE kind = 'set_visitor_ai'`,
        await tx`SELECT input_hash, result_summary FROM audit_events WHERE operation LIKE 'visitor_ai.%' OR operation LIKE 'owner_settings.%visitor_ai%'`,
      ]),
    );
    expect(admin).not.toContain(KEY);
    await drainProjectionOnce(adapter, staging);
    const pub = await onDb(PUBLIC_ADMIN_URL, async (tx) =>
      JSON.stringify(await tx`SELECT * FROM published_visitor_ai`),
    );
    expect(pub).not.toContain(KEY);
    expect(pub).toContain('"key_provider":"anthropic"');
  });

  it("publishes each environment's own budget and key state", async () => {
    await drainProjectionOnce(adapter, staging);
    const live = await onDb(
      PUBLIC_ADMIN_URL,
      async (tx) =>
        ((await tx`SELECT * FROM published_visitor_ai`) as Record<string, unknown>[])[0],
    );
    const stage = await onDb(
      STAGING_ADMIN_URL,
      async (tx) =>
        ((await tx`SELECT * FROM published_visitor_ai`) as Record<string, unknown>[])[0],
    );
    expect(live).toMatchObject({ enabled: true, key_provider: "anthropic" });
    expect(Number(live?.daily_cap_microcents)).toBe(300_000_000);
    expect(Number(stage?.daily_cap_microcents)).toBe(100_000_000);
    expect(stage?.key_provider).toBeNull();
    // The model's prices travel with it, so the gateway can count what a turn may cost.
    expect((live?.pricing as unknown[]).length).toBeGreaterThan(0);
  });

  it("lets a plugin that requires it be activated only while it can run", async () => {
    const manifest = { requires: ["visitor-ai"] };
    expect(
      await adapter.withAdminTransaction(SYSTEM, (tx) =>
        unmetHostRequirement(tx, "assistant", manifest),
      ),
    ).toBeNull();
    const removed = await removeVisitorAiKey(registry, adapter, OWNER, "both", {
      store: memoryStores().store,
    });
    expect(removed.ok).toBe(true);
    const unmet = await adapter.withAdminTransaction(SYSTEM, (tx) =>
      unmetHostRequirement(tx, "assistant", manifest),
    );
    expect(unmet).toContain("no visitor-AI key is stored for the live site");
    expect(unmet).toContain("propose_set_visitor_ai");
  });

  it("reads what visitors spent from the gateway's ledger", async () => {
    const plugin = "a1654000-0000-4000-8000-000000000001";
    const gateway = new SQL(PUBLIC_URL);
    try {
      await gateway.begin(async (tx) => {
        await tx`INSERT INTO visitor_ai_calls (plugin_id, operation, conversation_id, reservation, reserved_microcents, model)
                 VALUES (${plugin}::uuid, 'ask', 'AAAAAAAAAAAAAAAAAAAAAA', 'reserved', 2000000, 'claude-haiku-5-5')`;
        await tx`UPDATE visitor_ai_calls SET reservation = 'settled', cost_microcents = 150000, input_tokens = 900, output_tokens = 80
                 WHERE conversation_id = 'AAAAAAAAAAAAAAAAAAAAAA'`;
        await tx`INSERT INTO visitor_ai_calls (plugin_id, operation, conversation_id, reservation, reserved_microcents, model)
                 VALUES (${plugin}::uuid, 'ask', 'BBBBBBBBBBBBBBBBBBBBBB', 'reserved', 2000000, 'claude-haiku-5-5')`;
      });
      // The gateway may not insert a settled row, nor raise another's cost later.
      await expect(
        gateway`INSERT INTO visitor_ai_calls (plugin_id, operation, conversation_id, reservation, reserved_microcents, model)
                VALUES (${plugin}::uuid, 'ask', 'CCCCCCCCCCCCCCCCCCCCCC', 'settled', 0, 'm')`,
      ).rejects.toThrow();
    } finally {
      await gateway.end();
    }
    const spent = await execute(registry, adapter, AI, "visitor_ai.spend", {});
    if (!spent.ok) throw new Error(JSON.stringify(spent.error));
    const v = spent.value as {
      last24hUsd: number;
      perOperation: { running: number; turns: number }[];
    };
    // A running turn counts at its reservation, a finished one at its cost.
    expect(v.last24hUsd).toBeCloseTo((150_000 + 2_000_000) / 1e8, 8);
    expect(v.perOperation[0]).toMatchObject({ turns: 2, running: 1 });
    // The admin may only read the gateway's ledger.
    await expect(
      onDb(PUBLIC_ADMIN_URL, (tx) => tx`UPDATE visitor_ai_calls SET cost_microcents = 0`),
    ).resolves.toBeDefined();
    const still = await execute(registry, adapter, AI, "visitor_ai.spend", {});
    expect((still.ok ? still.value : null) as unknown).toMatchObject({ last24hUsd: v.last24hUsd });
    await onDb(PUBLIC_ADMIN_URL, (tx) => tx`TRUNCATE visitor_ai_calls`);
  });
});

describe("the key store (#1654)", () => {
  it("replaces a key file atomically and never reads it", async () => {
    const file = join(dir, "visitor-ai-key.json");
    const store = visitorAiKeyStore("live", { CAELO_VISITOR_AI_KEY_FILE: file });
    await store.write({ provider: "openai", apiKey: KEY });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ provider: "openai", apiKey: KEY });
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    await store.write(null);
    expect(await readFile(file, "utf8")).toBe("{}");
  });

  it("refuses on AWS and Azure, and without a store", () => {
    expect(() => visitorAiKeyStore("live", { CAELO_PROVIDER: "aws" })).toThrow(
      VisitorAiKeyStoreUnavailable,
    );
    expect(() => visitorAiKeyStore("staging", { CAELO_PROVIDER: "azure" })).toThrow("#750");
    expect(() => visitorAiKeyStore("live", {})).toThrow("cms-provision upgrade");
    expect(() => visitorAiKeyStore("live", { CAELO_VISITOR_AI_KEY_STORE: "not-a-secret" })).toThrow(
      VisitorAiKeyStoreUnavailable,
    );
  });
});
