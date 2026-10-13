// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { appliedAdminMigrationsOp } from "../platform_health.js";

describe("platform_health applied migrations", () => {
  it("sorts by code-unit order whatever order the database returns", async () => {
    // A locale collation returns "0198_plugin_…" before "0198_p_mcp_…".
    const tx = {
      execute: async () => [
        { hash: "0198_plugin_v2_drop_translation.sql" },
        { hash: "0198_p_mcp_token_scope.sql" },
        { hash: "0001_init.sql" },
      ],
    } as unknown as TransactionRunner;
    const r = await appliedAdminMigrationsOp.handler(
      {} as Parameters<typeof appliedAdminMigrationsOp.handler>[0],
      {},
      tx,
    );
    expect(r.ok).toBe(true);
    expect((r as { value: { applied: string[] } }).value.applied).toEqual([
      "0001_init.sql",
      "0198_p_mcp_token_scope.sql",
      "0198_plugin_v2_drop_translation.sql",
    ]);
  });
});
