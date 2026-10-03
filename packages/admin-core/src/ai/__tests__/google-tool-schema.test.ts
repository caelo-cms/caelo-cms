// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "bun:test";
import { toSDKMessages } from "../providers/_sdk-shared.js";
import { GeminiProvider } from "../providers/gemini.js";
import { googleToolSchema } from "../providers/google-tool-schema.js";
import { bulkCreateRedirectsTool } from "../tools/bulk-create-redirects.js";
import { findRedirectsTool } from "../tools/find-redirects.js";
import { setSiteIdentityTool } from "../tools/set-site-identity.js";
import { setStructuredSetTool } from "../tools/set-structured-set.js";

test("Google tool schemas retain types without mutating canonical enum validation", () => {
  const schema = {
    type: "object",
    properties: {
      enum: { type: "integer", enum: [301, 302] },
      nested: {
        type: "array",
        items: {
          anyOf: [
            { type: "integer", const: 410 },
            { type: "string", enum: ["keep"] },
          ],
        },
      },
    },
  };
  const converted = googleToolSchema(schema) as typeof schema;
  expect(converted.properties.enum).toEqual({
    type: "integer",
    description: "Allowed values: 301, 302.",
  });
  expect(converted.properties.nested.items.anyOf[0]).toEqual({
    type: "integer",
    description: "Allowed values: 410.",
  });
  expect(converted.properties.nested.items.anyOf[1]).toEqual(
    schema.properties.nested.items.anyOf[1],
  );
  expect(schema.properties.enum.enum).toEqual([301, 302]);
});

test("actual Google SDK sends redirect tools without non-string enums", async () => {
  let captured = "";
  const provider = new GeminiProvider({
    apiKey: "test-key",
    model: "gemini-3.8-flash",
    fetchImpl: (async (_url, init) => {
      captured = String(init?.body);
      return new Response(
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"What book would you like to create?"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch,
  });
  const events = [];
  for await (const event of provider.generate({
    systemPrompt: "Help the author",
    messages: [
      { role: "user", content: "Start Pictbook" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "find_redirects", arguments: {} }],
      },
      { role: "tool", toolCallId: "call-1", content: "[]" },
    ],
    tools: [findRedirectsTool, bulkCreateRedirectsTool, setStructuredSetTool, setSiteIdentityTool],
  }))
    events.push(event);
  expect(
    events.some((event) => event.kind === "text-delta" && event.text.includes("What book")),
  ).toBe(true);
  expect(
    bulkCreateRedirectsTool.schema.safeParse({
      redirects: [{ fromPath: "/a", toPath: "/b", statusCode: 301 }],
    }).success,
  ).toBe(true);
  expect(findRedirectsTool.schema.safeParse({ statusCode: 999 }).success).toBe(false);
  expect(captured).toContain("find_redirects");
  expect(captured).toContain("bulk_create_redirects");
  expect(captured).toContain("Allowed values: 301");
  const body = JSON.parse(captured);
  expect(body.contents[2].parts[0].functionResponse.name).toBe("find_redirects");
  function check(node: unknown) {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum")
        expect((value as unknown[]).every((item) => typeof item === "string")).toBe(true);
      else check(value);
    }
  }
  check(body.tools);
  const declarations = body.tools[0].functionDeclarations;
  const structured = declarations.find(
    (tool: { name: string }) => tool.name === "set_structured_set",
  );
  expect(structured.parametersJsonSchema.properties.items.items).toEqual({ type: "object" });
  const identity = declarations.find((tool: { name: string }) => tool.name === "set_site_identity");
  // The SDK now sends JSON Schema as-is (parametersJsonSchema). A nullable
  // object stays an anyOf of the object and null, with its properties
  // inside the object branch rather than beside the anyOf.
  const designBrief = identity.parametersJsonSchema.properties.designBrief;
  expect(designBrief.anyOf[0].type).toBe("object");
  expect(designBrief.anyOf[1]).toEqual({ type: "null" });
  expect(designBrief.anyOf[0].properties.audience.type).toBe("string");
  expect(events.some((event) => event.kind === "error")).toBe(false);
  expect(
    bulkCreateRedirectsTool.schema.safeParse({
      redirects: [{ fromPath: "/a", toPath: "/b", statusCode: 999 }],
    }).success,
  ).toBe(false);
});

test("tool results resolve canonical SDK call names without rebuilding history", () => {
  const sdkMessages = [
    {
      role: "assistant" as const,
      content: [
        { type: "tool-call" as const, toolCallId: "sdk-call", toolName: "load_skill", input: {} },
      ],
    },
  ];
  const result = toSDKMessages([
    { role: "assistant", content: "", sdkMessages },
    { role: "tool", toolCallId: "sdk-call", content: "guide" },
  ]);
  expect(result[0]).toBe(sdkMessages[0]);
  expect(result[1]).toMatchObject({ role: "tool", content: [{ toolName: "load_skill" }] });
  expect(() => toSDKMessages([{ role: "tool", toolCallId: "missing", content: "guide" }])).toThrow(
    "no matching call",
  );
});
