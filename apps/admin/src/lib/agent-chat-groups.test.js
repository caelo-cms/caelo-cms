// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { groupAgentChats } from "./agent-chat-groups.js";
describe("groupAgentChats (#1253)", () => {
    it("keeps the operator's chats apart and groups agent chats per client, newest first", () => {
        const { own, agents } = groupAgentChats([
            { id: "mine", lastActiveAt: "2026-10-30T10:00:00Z", agentClient: null },
            { id: "cc-1", lastActiveAt: "2026-10-30T09:00:00Z", agentClient: "Claude Code" },
            { id: "gpt-1", lastActiveAt: "2026-10-30T11:00:00Z", agentClient: "ChatGPT" },
            { id: "cc-2", lastActiveAt: "2026-10-30T12:00:00Z", agentClient: "Claude Code" },
            { id: "legacy" },
        ]);
        expect(own.map((c) => c.id)).toEqual(["mine", "legacy"]);
        expect(agents.map((g) => [g.client, g.chats.map((c) => c.id)])).toEqual([
            ["Claude Code", ["cc-2", "cc-1"]],
            ["ChatGPT", ["gpt-1"]],
        ]);
    });
    it("lists a chat once when two source lists both carry it", () => {
        const chat = { id: "cc-1", lastActiveAt: "2026-10-30T09:00:00Z", agentClient: "Claude Code" };
        const { agents } = groupAgentChats([chat, chat]);
        expect(agents[0]?.chats).toHaveLength(1);
    });
});
