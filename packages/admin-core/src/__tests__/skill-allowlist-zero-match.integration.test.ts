// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (step-13 round-3 root cause) — an engaged skill whose
 * allowlist matches ZERO live tools must NOT strand the AI with an empty
 * tool catalogue.
 *
 * The step-13 footer walk failed because "add a footer with navigation
 * links" auto-engaged the `menu-auditor` skill, whose `allowlistedTools`
 * list Query-API op names (`structured_sets.list`, `pages.list`, …) rather
 * than the AI tool names the catalogue uses (`list_structured_sets`,
 * `list_pages`, …). The intersection was empty, the AI got ZERO tools,
 * couldn't call add_module_to_layout, and narrated the footer instead of
 * building it. The chat-runner now treats a zero-match allowlist as absent
 * (full catalogue) and warns — while a VALID partial allowlist still
 * narrows surgically.
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
import { isOrchestrationToolName, isReadOnlyToolName } from "../ai/chat-runner/tool-catalogue.js";
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

describe("skill allowlist zero-match guard (issue #106)", () => {
  it("a zero-match allowlist (op-names not tool-names) falls back to the full catalogue", async () => {
    // Mirrors menu-auditor's broken shape: Query-API op names that match no
    // AI tool. Without the guard this strands the AI with zero tools.
    await seedSkill(
      ZERO_SLUG,
      ["structured_sets.list", "pages.list", "redirects.list"],
      "zzbogusaudit",
    );
    const tools = await captureToolsForTurn("zzbogusaudit");
    expect(tools.length).toBeGreaterThan(50); // full catalogue, not zero
    expect(tools.some((t) => t.name === "add_module_to_layout")).toBe(true);
  });

  it("a VALID partial allowlist still narrows WRITE tools surgically (reads always stay — run #8 R2b/R5)", async () => {
    await seedSkill(VALID_SLUG, ["edit_module"], "zzscopededit");
    const tools = await captureToolsForTurn("zzscopededit");
    const names = tools.map((t) => t.name);
    // The allowlisted write tool is present…
    expect(names).toContain("edit_module");
    // …every OTHER write tool is narrowed away…
    expect(names).not.toContain("add_module_to_layout");
    expect(names).not.toContain("add_module_to_page");
    expect(names).not.toContain("create_page");
    expect(names).not.toContain("set_page_module_content");
    // …and every remaining tool is read-only by the naming convention
    // (run #8 R2b/R5: skill allowlists never strip the AI's read surface)
    // or an orchestration tool (run #9 R7: skill allowlists never strip
    // the fan-out primitive from a main session either).
    for (const name of names) {
      if (name === "edit_module") continue;
      expect(isReadOnlyToolName(name) || isOrchestrationToolName(name)).toBe(true);
    }
    // The read surface is genuinely still there, not vacuously empty.
    expect(names).toContain("list_modules");
    expect(names).toContain("inspect_page_render");
    // Run #9 R7 — the orchestrator keeps its spawn tools under a
    // co-engaged write allowlist (this is a MAIN session: no subagent
    // exclusion, so both spawn tools must survive).
    expect(names).toContain("spawn_subagent");
    expect(names).toContain("spawn_subagents");
  });
});
