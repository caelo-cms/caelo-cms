// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario (#1275) — a failed write call is fixed with a patch, not resent.
 *
 * The operator asks for a long page of a kind the site has no page type
 * for yet, and asks for it right away. The AI's first `build_page` names
 * a page type that does not exist, so it fails with the page types to
 * choose from and the call is kept. The fix is `retry_tool_call` with a
 * patch of `page.pageType` (after creating the type, or picking one) —
 * never a second `build_page` that re-emits the whole page.
 *
 * Assertions read the chat's own tool calls and the kept-call rows.
 *
 * Coverage map:
 *   • #1275 — kept failure → retry_tool_call, no resend
 *   • #1276 — a page type is a decision the create carries
 */

import { expect, test } from "./fixtures.js";
import {
  assertNoChatRunnerDiagWarnings,
  attachChatSessionTracker,
  loginAsDevOwner,
  primePostOnboarding,
  resetLiveditFixtures,
  runBunInline,
  seedMinimalSite,
  sendChatPromptAndWait,
} from "./helpers.js";

const SLUG = "our-story";

const PROMPT =
  "Create our 'Our story' page at /our-story right away: one long section that tells how the company was founded, " +
  "about 500 words in three paragraphs. Its page type is `story`. " +
  "Build it straight away without looking anything up first.";

interface ChatCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

interface ChatFacts {
  /** Every tool call of the session, in order. */
  readonly calls: readonly ChatCall[];
  /** Tool result text per call id. */
  readonly results: Record<string, string>;
  /** Kept-call rows still holding arguments (call id → tool name). */
  readonly stillKept: Record<string, string>;
  /** The page's page type slug, or null when the page was not built. */
  readonly pageType: string | null;
}

function chatFacts(chatSessionId: string): ChatFacts {
  const out = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    let facts;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx\`
        SELECT role, content, tool_calls, tool_call_id, response_messages
        FROM chat_messages WHERE chat_session_id = \${process.env.SESSION_ID}::uuid
        ORDER BY created_at, id
      \`;
      const calls = [];
      const seen = new Set();
      const results = {};
      for (const r of rows) {
        if (r.role === "tool" && r.tool_call_id) results[r.tool_call_id] = r.content;
        const push = (id, name, args) => {
          if (!id || seen.has(id)) return;
          seen.add(id);
          calls.push({ id, name, args: args ?? {} });
        };
        for (const c of Array.isArray(r.tool_calls) ? r.tool_calls : []) push(c.id, c.name, c.arguments);
        for (const m of Array.isArray(r.response_messages) ? r.response_messages : []) {
          for (const part of Array.isArray(m?.content) ? m.content : []) {
            if (part?.type === "tool-call") push(part.toolCallId, part.toolName, part.input);
          }
        }
      }
      const kept = await tx\`
        SELECT tool_call_id, tool_name FROM chat_tool_results
        WHERE chat_session_id = \${process.env.SESSION_ID}::uuid AND args IS NOT NULL
      \`;
      const page = await tx\`
        SELECT pt.slug FROM pages p JOIN page_types pt ON pt.id = p.page_type_id
        WHERE p.slug = \${process.env.SLUG} AND p.deleted_at IS NULL LIMIT 1
      \`;
      facts = {
        calls,
        results,
        stillKept: Object.fromEntries(kept.map((k) => [k.tool_call_id, k.tool_name])),
        pageType: page[0]?.slug ?? null,
      };
    });
    console.log(JSON.stringify(facts));
    await sql.end();
  `,
    { SESSION_ID: chatSessionId, SLUG },
  );
  return JSON.parse(out) as ChatFacts;
}

/** The slug a build_page call creates (`page.slug`), if any. */
function builtSlug(call: ChatCall): string | null {
  const page = call.args.page as { slug?: unknown } | undefined;
  return typeof page?.slug === "string" ? page.slug : null;
}

test("#1275: a kept build_page failure is fixed with retry_tool_call, not a resend", async ({
  page,
}) => {
  await resetLiveditFixtures();
  seedMinimalSite();
  primePostOnboarding();
  const tracker = attachChatSessionTracker(page);
  await loginAsDevOwner(page);
  await page.goto("/edit");

  await sendChatPromptAndWait(page, PROMPT, 480_000);
  const sessionId = tracker.currentSessionId();
  expect(sessionId, "no chat session was started").not.toBeNull();
  const facts = chatFacts(sessionId ?? "");
  console.log(
    `[scenario-retry-tool-call] calls ${JSON.stringify(facts.calls.map((c) => c.name))} pageType=${facts.pageType}`,
  );

  // The first build_page of the page that failed and was kept.
  const builds = facts.calls.filter((c) => c.name === "build_page" && builtSlug(c) === SLUG);
  const kept = builds.find((c) =>
    (facts.results[c.id] ?? "").includes(`retry_tool_call({toolCallId:"${c.id}"`),
  );
  test.skip(
    kept === undefined,
    "the AI's first build_page did not fail (it chose an existing page type) — nothing to retry",
  );
  if (!kept) return;

  const retries = facts.calls.filter(
    (c) => c.name === "retry_tool_call" && c.args.toolCallId === kept.id,
  );
  expect(retries.length, "the kept build_page was not fixed with retry_tool_call").toBeGreaterThan(
    0,
  );
  const resends = builds.filter((c) => c.id !== kept.id);
  expect(
    resends.map((c) => c.id),
    "the AI resent the whole build_page instead of patching the kept call",
  ).toEqual([]);
  expect(facts.pageType, "the page was not built").not.toBeNull();
  expect(facts.stillKept[kept.id], "the fixed call is still kept").toBeUndefined();

  assertNoChatRunnerDiagWarnings();
});
