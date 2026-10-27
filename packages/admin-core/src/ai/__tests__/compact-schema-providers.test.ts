// SPDX-License-Identifier: MPL-2.0

/**
 * The compact tool schemas (`compactInputSchema`) go to every provider
 * through the Vercel AI SDK. These tests push the WHOLE default catalogue
 * through each real SDK request builder (fetch stubbed, nothing leaves the
 * process) and check what lands on the wire:
 *
 * - Anthropic and OpenAI take JSON Schema as sent: type lists
 *   (`["string", "null"]`) and combined patterns arrive unchanged, and the
 *   OpenAI SDK's normalizer — which throws on a `propertyNames` it cannot
 *   express — accepts every tool.
 * - Google gets the schema through `googleToolSchema`: no type lists, only
 *   string enums, and each nullable field as an anyOf with a bare null branch.
 */

import { describe, expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { AIProvider } from "../provider.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { GeminiProvider } from "../providers/gemini.js";
import { OpenAiProvider } from "../providers/openai.js";
import { createDefaultToolRegistry } from "../tools/index.js";

const tools = createDefaultToolRegistry().catalogue();
const byName = new Map(tools.map((t) => [t.name, t]));

/** A fetch that records the request body and answers with a plain 400. */
function recordingFetch(): { fetch: typeof fetch; body: () => Record<string, unknown> } {
  let captured = "";
  const stub = (async (_url: unknown, init?: RequestInit) => {
    captured ||= String(init?.body);
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "stub" } }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  return { fetch: stub, body: () => JSON.parse(captured) as Record<string, unknown> };
}

async function send(provider: AIProvider): Promise<void> {
  for await (const _ of provider.generate({
    systemPrompt: "Build the site",
    messages: [{ role: "user", content: "Add a pricing page" }],
    tools,
  }));
}

/** Every schema node reachable from `node` (values of any key, recursively). */
function* nodes(node: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(node)) for (const v of node) yield* nodes(v);
  else if (node && typeof node === "object") {
    yield node as Record<string, unknown>;
    for (const v of Object.values(node)) yield* nodes(v);
  }
}

/** `set_site_identity`'s nullable `designBrief` property in a wire schema. */
function designBriefOf(schema: unknown): Record<string, unknown> {
  const properties = (schema as { properties?: Record<string, Record<string, unknown>> })
    .properties;
  const designBrief = properties?.designBrief;
  if (!designBrief) throw new Error("set_site_identity has no designBrief property");
  return designBrief;
}

describe("compact schemas on each provider's wire", () => {
  test("the catalogue really uses type lists (what the Google path must split)", () => {
    expect(designBriefOf(byName.get("set_site_identity")?.inputSchema).type).toEqual([
      "object",
      "null",
    ]);
  });

  test("Anthropic receives every compact schema verbatim", async () => {
    const wire = recordingFetch();
    const model = createAnthropic({ apiKey: "test-key", fetch: wire.fetch })("claude-opus-4-7");
    await send(
      new AnthropicProvider({
        apiKey: "test-key",
        model: "claude-opus-4-7",
        _modelOverride: model,
      }),
    );
    const sent = wire.body().tools as { name: string; input_schema: unknown }[];
    expect(sent.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
    for (const t of sent) expect(t.input_schema).toEqual(byName.get(t.name)?.inputSchema);
  });

  test("OpenAI accepts every compact schema (non-strict functions, type lists intact)", async () => {
    const wire = recordingFetch();
    const model = createOpenAI({ apiKey: "test-key", fetch: wire.fetch })("gpt-5");
    await send(new OpenAiProvider({ apiKey: "test-key", model: "gpt-5", _modelOverride: model }));
    const sent = wire.body().tools as {
      name: string;
      parameters: Record<string, unknown>;
      strict: boolean;
    }[];
    expect(sent.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
    expect(sent.every((t) => t.strict === false)).toBe(true);
    const identity = sent.find((t) => t.name === "set_site_identity");
    expect(designBriefOf(identity?.parameters).type).toEqual(["object", "null"]);
  });

  test("Google gets no type lists, only string enums, and bare null branches", async () => {
    const wire = recordingFetch();
    await send(
      new GeminiProvider({ apiKey: "test-key", model: "gemini-3.8-flash", fetchImpl: wire.fetch }),
    );
    const declarations = (wire.body().tools as { functionDeclarations: { name: string }[] }[])[0]
      ?.functionDeclarations as { name: string; parametersJsonSchema: Record<string, unknown> }[];
    expect(declarations.map((d) => d.name).sort()).toEqual(tools.map((t) => t.name).sort());
    for (const node of nodes(declarations.map((d) => d.parametersJsonSchema))) {
      if (Array.isArray(node.type))
        throw new Error(`type list on the Google wire: ${JSON.stringify(node)}`);
      if (Array.isArray(node.enum))
        expect(node.enum.every((v) => typeof v === "string")).toBe(true);
      if (Array.isArray(node.anyOf))
        for (const branch of node.anyOf as Record<string, unknown>[])
          if (branch.type === "null") expect(branch).toEqual({ type: "null" });
    }
    const identity = declarations.find((d) => d.name === "set_site_identity");
    const branches = designBriefOf(identity?.parametersJsonSchema).anyOf as Record<
      string,
      unknown
    >[];
    expect(branches[0]?.type).toBe("object");
    expect(branches[1]).toEqual({ type: "null" });
  });
});
