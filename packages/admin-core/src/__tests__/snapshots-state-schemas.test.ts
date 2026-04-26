// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  parseAndUpgradeModuleState,
  parseAndUpgradePageLayoutState,
  parseAndUpgradePageState,
  parseAndUpgradeTemplateState,
  SnapshotSchemaError,
} from "../snapshots/state-schemas.js";

describe("parseAndUpgradeModuleState", () => {
  it("accepts a valid v1 payload", () => {
    const r = parseAndUpgradeModuleState({
      schemaVersion: 1,
      slug: "hero",
      displayName: "Hero",
      html: "<p>x</p>",
      css: "",
      js: "",
      deletedAt: null,
    });
    expect(r.slug).toBe("hero");
  });

  it("throws SnapshotSchemaError when a required field is missing", () => {
    expect(() =>
      parseAndUpgradeModuleState({
        schemaVersion: 1,
        slug: "hero",
        // displayName missing
        html: "<p>x</p>",
        css: "",
        js: "",
        deletedAt: null,
      }),
    ).toThrow(SnapshotSchemaError);
  });

  it("throws on an unknown schemaVersion", () => {
    expect(() =>
      parseAndUpgradeModuleState({
        schemaVersion: 99,
        slug: "hero",
        displayName: "Hero",
        html: "<p>x</p>",
        css: "",
        js: "",
        deletedAt: null,
      }),
    ).toThrow(SnapshotSchemaError);
  });

  it("throws when schemaVersion is missing entirely", () => {
    expect(() =>
      parseAndUpgradeModuleState({
        slug: "hero",
        displayName: "Hero",
        html: "<p>x</p>",
        css: "",
        js: "",
        deletedAt: null,
      } as never),
    ).toThrow(SnapshotSchemaError);
  });
});

describe("parseAndUpgradeTemplateState", () => {
  it("accepts a v1 payload with blocks", () => {
    const r = parseAndUpgradeTemplateState({
      schemaVersion: 1,
      slug: "main",
      displayName: "Main",
      html: "<body></body>",
      css: "",
      deletedAt: null,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    expect(r.blocks).toHaveLength(1);
  });

  it("rejects an extra unknown key on a block", () => {
    expect(() =>
      parseAndUpgradeTemplateState({
        schemaVersion: 1,
        slug: "main",
        displayName: "Main",
        html: "<body></body>",
        css: "",
        deletedAt: null,
        blocks: [
          {
            name: "content",
            displayName: "Content",
            position: 0,
            extra: "noop",
          },
        ],
      }),
    ).toThrow(SnapshotSchemaError);
  });
});

describe("parseAndUpgradePageState", () => {
  it("accepts a v1 payload", () => {
    const r = parseAndUpgradePageState({
      schemaVersion: 1,
      slug: "home",
      locale: "en",
      title: "Home",
      templateId: "11111111-1111-4111-8111-111111111111",
      status: "draft",
      version: 0,
      deletedAt: null,
    });
    expect(r.status).toBe("draft");
  });

  it("rejects a non-uuid templateId", () => {
    expect(() =>
      parseAndUpgradePageState({
        schemaVersion: 1,
        slug: "home",
        locale: "en",
        title: "Home",
        templateId: "not-a-uuid",
        status: "draft",
        version: 0,
        deletedAt: null,
      }),
    ).toThrow(SnapshotSchemaError);
  });
});

describe("parseAndUpgradePageLayoutState", () => {
  it("accepts an empty layout", () => {
    const r = parseAndUpgradePageLayoutState({
      schemaVersion: 1,
      blocks: [],
    });
    expect(r.blocks).toEqual([]);
  });
});
