// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #68 — jsonb writes must store structured values, not double-encoded
 * JSON-string scalars.
 *
 * bun's SQL adapter binds a JS string param under a bare `::jsonb` cast as a
 * jsonb *string scalar*, so the old `${JSON.stringify(obj)}::jsonb` idiom stored
 * `"{...}"` (jsonb_typeof = `string`). The `jsonbParam()` helper routes the text
 * through `::text` first so Postgres parses the JSON into an array/object.
 *
 * These tests assert the fix at the DB level — reading the raw column with a
 * jsonb path expression (`->`, `->>`, `@>`) and `jsonb_typeof`, which the
 * production read-side compensation (`typeof v === 'string' ? JSON.parse` in
 * rowToModule etc.) would have masked. Before the fix `jsonb_typeof` returns
 * `string` and every path expression returns NULL; after the fix they return
 * the structured value.
 *
 * CI-only: requires the real compose Postgres (never run locally — it truncates
 * the dev DB per repo policy).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "jsonb68-test",
};

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM modules WHERE slug = 'jsonb68-hero'`;
      await tx`DELETE FROM subagent_runs WHERE role = 'jsonb68_role'`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterEach(async () => {
  await wipe();
});

afterAll(async () => {
  await adapter.close();
});

describe("jsonb double-encoding fix (issue #68)", () => {
  it("modules.create stores fields as a jsonb array reachable by path + @>", async () => {
    const created = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: "jsonb68-hero",
      displayName: "JSONB68 Hero",
      html: "<h1>{{headline}}</h1>",
      fields: [
        { name: "headline", kind: "text", label: "Headline", default: "Original headline" },
        { name: "cta_href", kind: "text", label: "CTA href", default: "/signup" },
      ] as never,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const moduleId = (created.value as { moduleId: string }).moduleId;

    const sql = new SQL(ADMIN_URL);
    try {
      const rows = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return await tx`
          SELECT
            jsonb_typeof(fields) AS typ,
            fields->0->>'name' AS first_name,
            fields->0->>'label' AS first_label,
            (fields @> '[{"name":"cta_href"}]'::jsonb) AS has_cta
          FROM modules
          WHERE id = ${moduleId}::uuid
          LIMIT 1
        `;
      })) as unknown as {
        typ: string;
        first_name: string;
        first_label: string;
        has_cta: boolean;
      }[];

      const row = rows[0];
      // The bug: this would be 'string', and every path below would be NULL.
      expect(row?.typ).toBe("array");
      expect(row?.first_name).toBe("headline");
      expect(row?.first_label).toBe("Headline");
      // jsonb containment only matches when the column is a real array/object.
      expect(row?.has_cta).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("subagent_runs.finish stores result_json as a jsonb object reachable by path", async () => {
    const sub = await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "[subagent] jsonb68",
      subagentRole: "jsonb68_role",
    });
    if (!sub.ok) throw new Error("session create failed");
    const subId = (sub.value as { chatSessionId: string }).chatSessionId;

    const create = await execute(registry, adapter, systemCtx, "subagent_runs.create_pending", {
      parentChatSessionId: null,
      parentMessageId: null,
      subagentChatSessionId: subId,
      batchId: null,
      role: "jsonb68_role",
      task: "jsonb68 task",
    });
    if (!create.ok) throw new Error("run create failed");
    const runId = (create.value as { id: string }).id;

    const finish = await execute(registry, adapter, systemCtx, "subagent_runs.finish", {
      id: runId,
      status: "completed",
      resultJson: { pass: true, issues: ["a", "b"], nested: { score: 7 } },
      costMicrocents: 100,
      durationMs: 200,
      errorMessage: null,
    });
    expect(finish.ok).toBe(true);

    const sql = new SQL(ADMIN_URL);
    try {
      const rows = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return await tx`
          SELECT
            jsonb_typeof(result_json) AS typ,
            result_json->>'pass' AS pass,
            result_json#>>'{nested,score}' AS score,
            jsonb_array_length(result_json->'issues') AS issue_count
          FROM subagent_runs
          WHERE id = ${runId}::uuid
          LIMIT 1
        `;
      })) as unknown as { typ: string; pass: string; score: string; issue_count: number }[];

      const row = rows[0];
      expect(row?.typ).toBe("object");
      expect(row?.pass).toBe("true");
      expect(row?.score).toBe("7");
      expect(row?.issue_count).toBe(2);
    } finally {
      await sql.end();
    }
  });
});
