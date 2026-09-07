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
    inputJsonSchema: { type: "object" } as Record<string, unknown>,
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
  let nested: Record<string, unknown> = { type: "object" };
  for (let depth = 0; depth < 15; depth++) nested = { type: "object", properties: { nested } };
  expect(() => check([{ ...tool, inputJsonSchema: nested }])).toThrow("schema shape");
});
