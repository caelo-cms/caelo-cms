// SPDX-License-Identifier: MPL-2.0

/**
 * #1654 — the manifest lint of `ai-chat` operations: the grant and the
 * requirement are declared, the prompt is visitor-visible configuration,
 * and every tool is a search or read operation (of this plugin, or of one
 * it requires).
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_AI_CHAT_LIMITS,
  manifestFromDefinition,
  parseConfigSchema,
  pluginManifest,
  visitorVisibleLeaves,
  type z,
} from "./index.js";

const COLLECTIONS = {
  pages: {
    description: "The site's pages.",
    maxDocuments: 1000,
    maxDocumentBytes: 4096,
    fields: {
      url: { kind: "keyword" as const },
      title: { kind: "text" as const, prefix: true },
      sections: { kind: "passages" as const },
    },
  },
};

const CONFIG = {
  assistant: {
    type: "group" as const,
    label: "Assistant",
    description: "How the assistant answers.",
    fields: {
      instructions: {
        type: "string" as const,
        label: "Instructions",
        description: "What the assistant is for.",
        effect: "query" as const,
        maxLength: 2000,
        multiline: true,
        default: "Answer questions about this site.",
        visitorVisible: true,
      },
      secret_note: {
        type: "string" as const,
        label: "Note",
        description: "Not for visitors.",
        effect: "none" as const,
        maxLength: 200,
        default: "",
      },
    },
  },
};

function definition(over: Record<string, unknown> = {}) {
  return {
    slug: "assistant",
    version: "1.0.0",
    tier: 1 as const,
    schema: {},
    requestedCapabilities: ["collections", "visitor_ai"],
    requires: ["visitor-ai"],
    operations: { noop: async () => null },
    config: CONFIG,
    collections: COLLECTIONS,
    collectionOperations: [
      {
        name: "search",
        kind: "search",
        collection: "pages",
        description: "Search the pages.",
        returns: ["url", "title"],
        snippet: "sections",
      },
      {
        name: "suggest",
        kind: "suggest",
        collection: "pages",
        description: "Complete a title.",
        returns: ["url", "title"],
      },
    ],
    aiChatOperations: [
      {
        name: "ask",
        kind: "ai-chat",
        description: "Answer a visitor's question from the site's pages.",
        prompt: { fields: ["assistant.instructions"] },
        tools: [{ plugin: "assistant", operation: "search" }],
      },
    ],
    ...over,
  };
}

function lint(over: Record<string, unknown> = {}): string[] {
  try {
    manifestFromDefinition(definition(over) as never);
    return [];
  } catch (e) {
    return (e as z.ZodError).issues.map((i) => i.message);
  }
}

describe("ai-chat operations (#1654)", () => {
  it("accepts a conversation over its own search, with the defaults filled in", () => {
    expect(lint()).toEqual([]);
    const m = manifestFromDefinition(definition() as never);
    const op = m.aiChatOperations?.[0];
    expect(op?.maxSteps).toBe(3);
    expect(op?.limits).toEqual(DEFAULT_AI_CHAT_LIMITS);
    expect(op?.captcha).toBe("pow");
    expect(pluginManifest.safeParse(m).success).toBe(true);
  });

  it("needs the visitor_ai grant and the visitor-ai requirement", () => {
    expect(lint({ requestedCapabilities: ["collections"] }).join("\n")).toContain("visitor_ai");
    expect(lint({ requires: [] }).join("\n")).toContain('requires: ["visitor-ai"]');
  });

  it("takes the prompt only from visitor-visible config leaves", () => {
    const op = definition().aiChatOperations[0];
    expect(
      lint({ aiChatOperations: [{ ...op, prompt: { fields: ["assistant.secret_note"] } }] }).join(
        "\n",
      ),
    ).toContain("not visitor-visible");
    expect(
      lint({ aiChatOperations: [{ ...op, prompt: { fields: ["assistant.missing"] } }] }).join("\n"),
    ).toContain("not a leaf");
  });

  it("refuses a tool that is not a search or read operation", () => {
    const op = definition().aiChatOperations[0];
    expect(
      lint({
        aiChatOperations: [{ ...op, tools: [{ plugin: "assistant", operation: "suggest" }] }],
      }).join("\n"),
    ).toContain("a tool must be a search or read operation");
    expect(
      lint({
        aiChatOperations: [{ ...op, tools: [{ plugin: "assistant", operation: "noop" }] }],
      }).join("\n"),
    ).toContain("not one of this plugin's collection operations");
  });

  it("needs another plugin's tools to be required plugins", () => {
    const op = definition().aiChatOperations[0];
    const tools = [{ plugin: "site-search", operation: "search" }];
    expect(lint({ aiChatOperations: [{ ...op, tools }] }).join("\n")).toContain(
      "must be in requiresPlugins",
    );
    expect(
      lint({ aiChatOperations: [{ ...op, tools }], requiresPlugins: ["site-search"] }),
    ).toEqual([]);
  });

  it("refuses a name another operation has, more than four steps and too many conversations", () => {
    const op = definition().aiChatOperations[0];
    expect(lint({ aiChatOperations: [{ ...op, name: "search" }] }).join("\n")).toContain(
      "already an operation name",
    );
    expect(lint({ aiChatOperations: [{ ...op, maxSteps: 5 }] }).length).toBeGreaterThan(0);
    expect(
      lint({
        aiChatOperations: [op, { ...op, name: "b" }, { ...op, name: "c" }],
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe("visitor-visible config leaves (#1654)", () => {
  it("lists only the marked leaves", () => {
    expect(visitorVisibleLeaves(parseConfigSchema(CONFIG)).map((l) => l.path)).toEqual([
      "assistant.instructions",
    ]);
  });

  it("refuses a visitor-visible reference or immediate field", () => {
    const withField = (field: Record<string, unknown>) =>
      lint({ config: { ...CONFIG, extra: field }, aiChatOperations: [] });
    expect(
      withField({
        type: "pageRef",
        label: "Page",
        description: "A page.",
        effect: "pages",
        default: null,
        visitorVisible: true,
      }).join("\n"),
    ).toContain("cannot be visitor-visible");
    expect(
      withField({
        type: "bool",
        label: "Flag",
        description: "A flag.",
        effect: "none",
        scope: "immediate",
        default: false,
        visitorVisible: true,
      }).join("\n"),
    ).toContain('needs scope "release"');
  });
});
