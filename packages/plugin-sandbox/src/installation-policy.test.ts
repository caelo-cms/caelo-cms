// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { pluginManifest } from "@caelo-cms/plugin-sdk";
import { validateInstallationPolicy, validateSelectedGrants } from "./installation-policy.js";

function manifest() {
  return pluginManifest.parse({
    slug: "external-notes",
    version: "1.0.0",
    tier: 2,
    schema: {},
    adminSchema: { notes: { body: "text" } },
    operations: ["save"],
    requestedCapabilities: ["cms_admin_schema"],
    capabilityReasons: { cms_admin_schema: "Store private authoring notes" },
  });
}
describe("explicit external installation grants", () => {
  it("does not treat a declaration as approval", () => {
    expect(() => validateSelectedGrants(manifest(), [])).toThrow("explicitly");
    expect(() => validateSelectedGrants(manifest(), ["cms_admin_schema"])).not.toThrow();
    expect(() => validateSelectedGrants(manifest(), ["cms_admin_schema", "email"])).toThrow(
      "explicitly",
    );
  });
  it("requires reasons and operation scopes", () => {
    expect(() => validateInstallationPolicy({ ...manifest(), capabilityReasons: {} })).toThrow(
      "Explain",
    );
    expect(() =>
      validateInstallationPolicy({
        ...manifest(),
        requestedCapabilities: ["cms_admin"],
        adminSchema: {},
        capabilityReasons: { cms_admin: "Edit pages" },
      }),
    ).toThrow("allowlist");
  });
  it("requires reviewed capabilities for browser assets", () => {
    expect(() => validateInstallationPolicy({ ...manifest(), hasBuildAssets: true })).toThrow(
      "client_assets",
    );
  });
});

it("refuses unbounded host-side tool schemas and ambiguous approval declarations", () => {
  const tool = {
    name: "external_notes__save",
    operationName: "save",
    description: "Save notes",
    inputJsonSchema: { type: "object", additionalProperties: false } as Record<string, unknown>,
  };
  const withTools = {
    ...manifest(),
    requestedCapabilities: ["cms_admin_schema", "chat_runner_tools"] as const,
    capabilityReasons: {
      cms_admin_schema: "Private notes",
      chat_runner_tools: "Author notes in chat",
    },
    tools: [tool],
  };
  const check = (tools: (typeof tool)[]) =>
    validateInstallationPolicy(pluginManifest.parse({ ...withTools, tools }));
  expect(() => check([tool])).not.toThrow();
  expect(() => check([tool, { ...tool, name: "external_notes__other" }])).toThrow("exactly one");
  expect(() =>
    check([{ ...tool, inputJsonSchema: { type: "string", pattern: "(a+)+$" } }]),
  ).toThrow("keyword");
  expect(() => check([{ ...tool, inputJsonSchema: { $ref: "#" } }])).toThrow("keyword");
  for (const schema of [
    { type: "not-a-json-schema-type" },
    { type: "object", enum: "invalid" },
    { type: "object", minimum: "zero" },
    { type: "object", required: "body" },
    { type: "object", required: ["missing"], properties: {} },
    { type: "object", properties: { list: { type: "array" } } },
    { type: "object", properties: { text: { type: "string", minLength: -1 } } },
    { type: "object", properties: { n: { type: "number", minimum: 3, maximum: 2 } } },
  ])
    expect(() => check([{ ...tool, inputJsonSchema: schema }])).toThrow();
  expect(() => check([{ ...tool, inputJsonSchema: { type: "string" } }])).toThrow("object root");
  expect(() =>
    check([{ ...tool, inputJsonSchema: { type: "object", additionalProperties: true } }]),
  ).toThrow("object root");
  let nested: Record<string, unknown> = { type: "object" };
  for (let depth = 0; depth < 15; depth++) nested = { type: "object", properties: { nested } };
  expect(() => check([{ ...tool, inputJsonSchema: nested }])).toThrow("schema shape");
});

describe("installed plugins stay inside their own namespace (#515 review)", () => {
  it("refuses foreign keys into core tables", () => {
    expect(() =>
      validateInstallationPolicy({
        ...manifest(),
        adminSchema: { notes: { body: "text", page_id: "ref:pages" } },
      }),
    ).toThrow("cannot reference core tables");
  });

  it("refuses a slug whose schema name Postgres would truncate", () => {
    expect(() => pluginManifest.parse({ ...manifest(), slug: `a${"b".repeat(55)}` })).toThrow();
    expect(() => pluginManifest.parse({ ...manifest(), slug: `a${"b".repeat(54)}` })).not.toThrow();
  });

  it("keeps tool names in an unambiguous per-slug namespace", () => {
    const withTool = (name: string) => ({
      ...manifest(),
      requestedCapabilities: ["cms_admin_schema", "chat_runner_tools"] as const,
      capabilityReasons: { cms_admin_schema: "notes", chat_runner_tools: "save notes" },
      tools: [
        {
          name,
          description: "Save a note",
          operationName: "save",
          inputJsonSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    expect(() => validateInstallationPolicy(withTool("external_notes__save"))).not.toThrow();
    // "external_notes___save" belongs to slug "external-notes-".
    expect(() => validateInstallationPolicy(withTool("external_notes___save"))).toThrow(
      "starting with a letter",
    );
  });
});
