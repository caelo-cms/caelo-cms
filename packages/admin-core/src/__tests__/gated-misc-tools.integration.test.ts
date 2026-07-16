// SPDX-License-Identifier: MPL-2.0

/**
 * Coverage for the last catalogue tools without a dedicated test, spanning
 * the gateway / proposal / plugin / import surfaces:
 *   - tune_rate_limit       → queues a gateway rate-limit proposal
 *   - cancel_proposal       → withdraws a proposal the same actor queued
 *   - revert_chat_changes   → clean refusal for an unknown chat session
 *   - add_plugin_to_page    → clean refusal for an unloaded plugin
 *   - submit_plugin         → Tier-2 submit lands `awaiting_activation`
 *   - add_import_page_notes → records notes on a staged import page
 * Real Postgres (§6).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { addPluginToPageTool } from "../ai/tools/add-plugin-to-page.js";
import { cancelProposalTool } from "../ai/tools/cancel-proposal.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { addImportPageNotesTool } from "../ai/tools/import-run-report.js";
import { revertChatChangesTool } from "../ai/tools/revert-chat-changes.js";
import { submitPluginTool } from "../ai/tools/submit-plugin.js";
import { tuneRateLimitTool } from "../ai/tools/tune-rate-limit.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

// The cancel_proposal op restricts callers to their OWN pending rows
// (proposed_by = ctx.actorId), so propose + cancel must share an actor.
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000aaaa",
  actorKind: "ai",
  requestId: "gated-misc-int",
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "gated-misc-int-sys",
};

const PLUGIN_SLUG = "test-gm-hello";
const IMPORT_HOST = "https://gm-import.example";
const PROPOSE_EMAIL = "gm-cancel-target@example.com";
const toolCtx = () => ({ adapter, registry }) as ToolContext;

/** Run a read inside a system-actor tx (RLS bypass) and close the pool. */
async function inspect<T>(fn: (tx: import("bun").SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    let result!: T;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      result = await fn(tx as unknown as import("bun").SQL);
    });
    return result;
  } finally {
    await sql.end();
  }
}

const helloManifest = {
  slug: PLUGIN_SLUG,
  version: "0.0.1",
  tier: 2,
  schema: {
    greetings: {
      id: "uuid",
      page_id: "string",
      locale: "string",
      message: "string",
      created_at: "timestamp",
    },
  },
  operations: ["submit", "list"],
  hasStaticRender: true,
};
const helloSource = `
import { definePlugin } from "@caelo-cms/plugin-sdk";
export default definePlugin({
  slug: "${PLUGIN_SLUG}",
  version: "0.0.1",
  tier: 2,
  schema: {
    greetings: {
      id: "uuid",
      page_id: "string",
      locale: "string",
      message: "string",
      created_at: "timestamp",
    },
  },
  operations: {
    submit: async ({ query }, data) => query.insert("greetings", data),
    list: async ({ query }, args) => query.list("greetings", args),
  },
});
`;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN_SLUG})`;
      await tx`DELETE FROM plugins WHERE slug = ${PLUGIN_SLUG}`;
      await tx`DELETE FROM import_pages WHERE source_url LIKE ${`${IMPORT_HOST}%`}`;
      await tx`DELETE FROM import_runs WHERE source_url LIKE ${`${IMPORT_HOST}%`}`;
      await tx`DELETE FROM user_pending_actions WHERE payload::text LIKE ${`%${PROPOSE_EMAIL}%`}`;
      await tx`DELETE FROM plugin_rate_limit_proposals WHERE plugin_slug = ${PLUGIN_SLUG}`;
    });
  } finally {
    await sql.end();
  }
  const pub = new SQL(PUBLIC_URL!);
  try {
    await pub.unsafe(`DROP SCHEMA IF EXISTS plugin_test_gm_hello CASCADE`);
  } finally {
    await pub.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("tune_rate_limit", () => {
  it("queues a gateway rate-limit proposal", async () => {
    const r = await tuneRateLimitTool.handler(
      SYSTEM,
      {
        pluginSlug: PLUGIN_SLUG,
        operation: "submit",
        proposedMax: 30,
        proposedWindowSec: 60,
      },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    // The proposal row is now in the gateway proposals table.
    const rows = await inspect(
      (tx) =>
        tx`SELECT count(*)::int AS n FROM plugin_rate_limit_proposals WHERE plugin_slug = ${PLUGIN_SLUG}` as unknown as Promise<
          { n: number }[]
        >,
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
  });
});

describe("cancel_proposal", () => {
  it("withdraws a proposal the same actor queued", async () => {
    const proposed = await execute(registry, adapter, AI, "users.propose_create", {
      email: PROPOSE_EMAIL,
      displayName: "GM Cancel Target",
      roleNames: [],
    });
    if (!proposed.ok) throw new Error("seed proposal");
    const proposalId = (proposed.value as { proposalId: string }).proposalId;

    const r = await cancelProposalTool.handler(AI, { proposalId }, toolCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain("cancelled");
  });

  it("refuses to cancel a non-existent proposal", async () => {
    const r = await cancelProposalTool.handler(
      AI,
      { proposalId: "aaaa1111-2222-4333-8444-555566667777" },
      toolCtx(),
    );
    expect(r.ok).toBe(false);
  });
});

describe("revert_chat_changes", () => {
  it("refuses cleanly for an unknown chat session (no throw)", async () => {
    const r = await revertChatChangesTool.handler(
      SYSTEM,
      { chatSessionId: "bbbb1111-2222-4333-8444-555566667777" },
      toolCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("revert_chat_changes");
  });
});

describe("add_plugin_to_page", () => {
  it("refuses cleanly when the plugin is not loaded", async () => {
    const r = await addPluginToPageTool.handler(
      SYSTEM,
      {
        pageId: "cccc1111-2222-4333-8444-555566667777",
        pluginSlug: "no-such-plugin-zzz",
        blockName: "content",
        position: "bottom",
      },
      toolCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not loaded");
  });
});

describe("submit_plugin", () => {
  it("submits a clean Tier-2 plugin and lands awaiting_activation", async () => {
    const r = await submitPluginTool.handler(
      AI,
      {
        slug: PLUGIN_SLUG,
        version: "0.0.1",
        manifest: helloManifest,
        source: helloSource,
      },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("awaiting_activation");
  });
});

describe("add_import_page_notes", () => {
  it("records notes on a staged import page", async () => {
    const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
      sourceUrl: `${IMPORT_HOST}/`,
      depth: 1,
      maxPages: 10,
    });
    if (!run.ok) throw new Error("create_run");
    const runId = (run.value as { runId: string }).runId;
    await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
      runId,
      pages: [
        {
          sourceUrl: `${IMPORT_HOST}/alte-seite.html`,
          proposedSlug: "gm-import-a",
          proposedTitle: "A",
          proposedModules: [],
          proposedThemeTokens: {},
          signature: "/x/*|s1",
        },
      ],
    });
    const idRows = await inspect(
      (tx) =>
        tx`SELECT id::text AS id FROM import_pages WHERE run_id = ${runId}::uuid LIMIT 1` as unknown as Promise<
          { id: string }[]
        >,
    );
    const importPageId = idRows[0]?.id;
    expect(importPageId).toBeTruthy();

    const r = await addImportPageNotesTool.handler(
      SYSTEM,
      {
        importPageId: importPageId as string,
        notes: [
          { category: "improvement", note: "Consider a stronger hero headline.", applied: false },
          { category: "typo", note: "Fixed 'teh' → 'the' in the intro.", applied: true },
        ],
      },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("2 note");
  });
});
