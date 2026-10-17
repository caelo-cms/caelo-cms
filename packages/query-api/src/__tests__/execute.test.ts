// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import { DatabaseAdapter } from "../adapter.js";
import { canonicalHash } from "../audit.js";
import { execute } from "../execute.js";
import { OperationRegistry } from "../registry.js";

const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000000",
  actorKind: "system",
  requestId: "test-req",
};

// An unknown op is rejected before the adapter is touched, so a stub that
// throws on any use proves the lookup failure never reaches the database.
const unreachableAdapter = new Proxy(
  {},
  {
    get() {
      throw new Error("adapter must not be used for an unknown operation");
    },
  },
) as unknown as DatabaseAdapter;

describe("execute() — unknown operation", () => {
  it("returns a fresh Err carrying only the lookup error", async () => {
    const result = await execute(new OperationRegistry(), unreachableAdapter, ctx, "nope.nope", {});
    // Exactly `{ ok, error }`: the lookup Result is re-wrapped, never passed
    // through, so no op definition can ride along in the output union
    // (the CodeQL js/clear-text-logging cascade, docs/dev/codeql.md).
    expect(result).toEqual({ ok: false, error: { kind: "UnknownOperation", name: "nope.nope" } });
    expect(Object.keys(result).sort()).toEqual(["error", "ok"]);
  });
});

describe("canonicalHash() — sensitive field redaction", () => {
  it("redacts newPassword, currentPassword, apiKey, and secret fields so different secrets produce identical hashes", async () => {
    const h1 = await canonicalHash({
      userId: "u1",
      currentPassword: "old-password-1",
      newPassword: "new-password-1",
      apiKey: "sk-111",
      clientSecret: "sec-111",
    });
    const h2 = await canonicalHash({
      userId: "u1",
      currentPassword: "old-password-2",
      newPassword: "new-password-2",
      apiKey: "sk-222",
      clientSecret: "sec-222",
    });
    expect(h1).toBe(h2);
  });
});

describe("DatabaseAdapter — pluginId UUID validation", () => {
  it("rejects non-UUID pluginId before opening a transaction in provisionPluginPublicSchema and provisionPluginAdminSchema", async () => {
    const proto = DatabaseAdapter.prototype;
    await expect(
      proto.provisionPluginPublicSchema.call({}, { pluginId: "not-a-uuid", sql: "SELECT 1" }),
    ).rejects.toThrow("not a UUID");
    await expect(
      proto.provisionPluginAdminSchema.call({}, { pluginId: "not-a-uuid", sql: "SELECT 1" }),
    ).rejects.toThrow("not a UUID");
  });
});
