// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 / issue #301 — skill-allowlist resolution end-to-end
 * through runChatTurn.
 *
 * issue #106 (step-13 round-3): an op-notation allowlist zero-matched
 * the tool-name catalogue and stranded the AI with ZERO tools. The fix
 * then was "treat zero-match as absent" — which issue #301 exposed as
 * a hidden fallback (CLAUDE.md §2): run #15 logged
 * `skill-allowlist-zero-match` 5× while the reviewer skills' allowlists
 * were silently ignored and the FULL catalogue (write tools included)
 * shipped on turns the skill meant to narrow.
 *
 * The #301 contract asserted here:
 *   - op-notation entries TRANSLATE via the explicit table
 *     (allowlist-mapping.ts) and the allowlist APPLIES;
 *   - an allowlist that resolves to zero live tools is a
 *     skill-definition DEFECT: the catalogue stays full (never zero
 *     tools — the #106 guarantee) and a `skill-allowlist-defect` event
 *     fires; save-time validation makes such rows unreachable except
 *     via pre-0157 data or raw SQL (as seeded below).
 *
 * Run #8 R2b/R5 amended the narrowing contract: a skill allowlist
 * narrows WRITE tools only; read-only tools (list_/get_/inspect_/find_/
 * screenshot_/check_ by naming convention) always stay in the catalogue,
 * because stripping them blinded the AI mid-session (wrong-module edits)
 * and inside rebuild subagents. Run #9 R7 amended it again: the
 * orchestration tools (spawn_subagent / spawn_subagents) are
 * allowlist-immune too — no allowlist predates the 0132 subagent
 * contract lists them, so a co-engaged skill's write allowlist was
 * stripping the migration orchestrator's fan-out primitive. The "valid
 * partial allowlist" case below asserts the amended contract.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { runChatTurn } from "../ai/chat-runner.js";
import type { AIProvider, GenerateInput, ProviderEvent, ProviderName } from "../ai/provider.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue106-allowlist",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue106-allowlist-ai",
};

const ZERO_SLUG = "issue106-zero-allow";
const VALID_SLUG = "issue106-valid-allow";

interface CapturedTool {
  name: string;
}
/** Captures the `tools` array the chat-runner hands the provider, then ends the turn. */
class CapturingProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model = "claude-test-1";
  capturedTools: CapturedTool[] | null = null;
  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    this.capturedTools = input.tools as unknown as CapturedTool[];
    yield { kind: "text-delta", text: "ok" };
    yield { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

async function seedSkill(slug: string, allowlist: string[], keyword: string): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`
        INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
        VALUES (${slug}, ${slug}, 'test', 'test body',
                ${JSON.stringify(allowlist)}::jsonb,
                ${JSON.stringify({ keywords: [keyword], chipTrigger: false, alwaysOn: false })}::jsonb,
                'active')
        ON CONFLICT (slug) DO UPDATE SET
          allowlisted_tools = EXCLUDED.allowlisted_tools,
          auto_engagement_hints = EXCLUDED.auto_engagement_hints,
          status = 'active'
      `;
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'issue106-allow-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'issue106-allow-%'`;
      await tx`DELETE FROM skills WHERE slug IN (${ZERO_SLUG}, ${VALID_SLUG})`;
    });
  } finally {
    await sql.end();
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

async function captureToolsForTurn(skillKeyword: string): Promise<CapturedTool[]> {
  const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
    title: `issue106-allow-${skillKeyword}`,
  });
  if (!session.ok) throw new Error("session");
  const { chatSessionId } = session.value as { chatSessionId: string };
  const provider = new CapturingProvider();
  for await (const _ev of runChatTurn(
    {
      adapter,
      registry,
      provider,
      tools: createDefaultToolRegistry(),
      aiCtx: AI,
      humanCtx: HUMAN,
    },
    { chatSessionId, content: `please ${skillKeyword} this`, chips: [] },
  )) {
    // drain
  }
  if (!provider.capturedTools) throw new Error("no tools captured");
  return provider.capturedTools;
}

describe("skill allowlist resolution (issue #106 / issue #301)", () => {
  it("an op-notation allowlist TRANSLATES and PRELOADS — nothing drops (run #15 regression)", async () => {
    // The pre-0157 menu-auditor shape, seeded via raw SQL exactly like
    // migration 0033 did. The entries still translate (structured_sets.list
    // → list_structured_sets, pages.list → list_pages, redirects.list →
    // find_redirects); post-Tool-Search they PRELOAD those tools rather
    // than narrowing the catalogue. Every other tool stays reachable via
    // search — a skill can no longer strand the model.
    await seedSkill(
      ZERO_SLUG,
      ["structured_sets.list", "pages.list", "redirects.list"],
      "zzbogusaudit",
    );
    const tools = await captureToolsForTurn("zzbogusaudit");
    const byName = new Map(tools.map((t) => [t.name, t]));
    // The translated entries are present AND preloaded (alwaysLoaded).
    expect(byName.get("list_structured_sets")?.alwaysLoaded).toBe(true);
    expect(byName.get("find_redirects")?.alwaysLoaded).toBe(true);
    expect(byName.has("list_pages")).toBe(true); // core, always loaded
    // Writes are NOT dropped anymore — reachable via Tool Search.
    expect(byName.has("add_module")).toBe(true);
    expect(byName.has("edit_module")).toBe(true);
    expect(byName.has("set_structured_set")).toBe(true);
  });

  it("an allowlist resolving to ZERO live tools keeps the full catalogue (defect, never zero tools)", async () => {
    // Unreachable through skills.set/propose (issue #301 validation) —
    // seeded via raw SQL to simulate hand-edited or pre-validation data.
    // The keyword must not substring-match any seeded skill's
    // auto-engagement keywords: "zzbogusaudit" contains "audit" and
    // co-engaged menu-auditor, whose (post-0157, live) allowlist made
    // the union resolve to >0 tools — narrowing the catalogue and
    // breaking the ZERO-live-tools premise this test exists to pin.
    await seedSkill(ZERO_SLUG, ["totally.bogus_op", "nope.not_a_tool"], "zzbogusnix");
    const tools = await captureToolsForTurn("zzbogusnix");
    expect(tools.length).toBeGreaterThan(50); // full catalogue, not zero
    expect(tools.some((t) => t.name === "add_module")).toBe(true);
  });

  it("a VALID partial allowlist PRELOADS the named write; nothing else is removed (run #8 R2b/R5)", async () => {
    await seedSkill(VALID_SLUG, ["edit_module"], "zzscopededit");
    const tools = await captureToolsForTurn("zzscopededit");
    const byName = new Map(tools.map((t) => [t.name, t]));
    // The allowlisted write is preloaded (schema up front).
    expect(byName.get("edit_module")?.alwaysLoaded).toBe(true);
    // Every OTHER write is STILL present — reachable via Tool Search,
    // just not preloaded. Skill allowlists no longer narrow.
    expect(byName.has("add_module")).toBe(true);
    expect(byName.has("build_page")).toBe(true);
    expect(byName.has("set_page_module_content")).toBe(true);
    // Reads + the orchestrator's spawn tools are obviously present too.
    expect(byName.has("list_modules")).toBe(true);
    expect(byName.has("inspect_page_render")).toBe(true);
    expect(byName.has("spawn_subagent")).toBe(true);
    expect(byName.has("spawn_subagents")).toBe(true);
  });
});
