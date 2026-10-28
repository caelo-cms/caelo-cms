// SPDX-License-Identifier: MPL-2.0

/**
 * #1216 — which callers may load a chat's history.
 *
 * `chat.get_session` reads the transcript; `chat.resolve_session` reads the
 * session row alone. Callers that only need the branch, the owner or the
 * open/closed state must use the light read (the MCP surface used to load a
 * whole transcript on every tool call), and only the chat runner may ask for
 * the SDK `response_messages` — the heaviest column, needed only to replay.
 * Read as source so the guard also covers the SvelteKit routes (bun cannot
 * import their `#lib` aliases).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const read = (path: string): string => readFileSync(resolve(repo, path), "utf8");

/** Callers that need no transcript — they must never run chat.get_session. */
const LIGHT_CALLERS = [
  "packages/admin-core/src/ops/security/mcp_power.ts",
  "packages/admin-core/src/ops/security/mcp_tokens.ts",
  "packages/admin-core/src/stage/stage-chats.ts",
  "apps/admin/src/lib/server/agent-runs.ts",
  "apps/admin/src/routes/(authed)/edit/+page.server.ts",
  "apps/admin/src/routes/(authed)/content/chat/[sessionId]/+page.server.ts",
];

describe("chat session read callers (#1216)", () => {
  for (const path of LIGHT_CALLERS) {
    it(`${path} does not load the chat history op directly`, () => {
      expect(read(path)).not.toContain('"chat.get_session"');
    });
  }

  it("the transcript views read a bounded page without response_messages", () => {
    const src = read("apps/admin/src/lib/server/chat-transcript.ts");
    expect(src).toContain('"chat.get_session"');
    expect(src).toContain("limit: CHAT_TRANSCRIPT_PAGE");
    expect(src).not.toContain("includeResponseMessages");
  });

  it("only the chat runner asks for response_messages", () => {
    expect(read("packages/admin-core/src/ai/chat-runner/persistence.ts")).toContain(
      "includeResponseMessages: true",
    );
    for (const path of [...LIGHT_CALLERS, "packages/admin-core/src/ai/tools/spawn-subagent.ts"]) {
      expect(read(path)).not.toContain("includeResponseMessages");
    }
  });
});
