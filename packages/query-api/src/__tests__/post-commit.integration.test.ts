// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #585 — `afterCommit` effects run only after the op's transaction
 * committed, never on rollback, and a failing effect is loud: an error
 * result saying the change is saved, plus a failed `<op>.post_commit`
 * audit row.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  afterCommit,
  DatabaseAdapter,
  defineOperation,
  execute,
  OperationRegistry,
} from "../index.js";
import { deleteActors, seedActors } from "./_seed.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB urls required");

let adapter: DatabaseAdapter;
const registry = new OperationRegistry();
const actorId = "00000000-0000-0000-0000-000000000585";
const ctx: ExecutionContext = { actorId, actorKind: "system", requestId: "post-commit-test" };

/** What the effects observed: the label of each run, and whether the
 *  op's own row was visible to a separate connection at that moment. */
const ran: { label: string; rowVisible: boolean }[] = [];

async function markerVisible(marker: string): Promise<boolean> {
  const rows = (await adapter.rawAdmin().begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    return tx`SELECT 1 FROM audit_events WHERE operation = 'post_commit.write' AND input_hash = ${marker}`;
  })) as unknown[];
  return rows.length > 0;
}

const writeInput = z.object({
  marker: z.string(),
  mode: z.enum(["ok", "throw", "fail_effect", "fail_with_step"]),
});

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  await seedActors(adapter.rawAdmin(), [
    { id: actorId, kind: "system", displayName: "post-commit-test" },
  ]);
  registry.register(
    defineOperation({
      name: "post_commit.write",
      actorScope: ["system"],
      database: "cms_admin",
      input: writeInput,
      output: z.object({}),
      handler: async (c, input, tx) => {
        await tx.execute(sql`
          INSERT INTO audit_events (actor_id, operation, input_hash, succeeded)
          VALUES (${c.actorId}::uuid, 'post_commit.write', ${input.marker}, true)
        `);
        afterCommit(tx, {
          label: `effect ${input.marker}`,
          run: async () => {
            ran.push({ label: input.marker, rowVisible: await markerVisible(input.marker) });
            if (input.mode === "fail_effect" || input.mode === "fail_with_step") {
              throw new Error("host refused");
            }
          },
          ...(input.mode === "fail_with_step"
            ? { nextStep: "It is retried automatically; Settings shows its status." }
            : {}),
        });
        if (input.mode === "throw") throw new Error("statement after the effect failed");
        return ok({});
      },
    }),
  );
});

afterAll(async () => {
  await deleteActors(adapter.rawAdmin(), [actorId]);
  await adapter.close();
});

describe("afterCommit", () => {
  it("runs the effect after the commit, when the write is visible to other connections", async () => {
    const r = await execute(registry, adapter, ctx, "post_commit.write", {
      marker: "committed",
      mode: "ok",
    });
    expect(r.ok).toBe(true);
    expect(ran.filter((e) => e.label === "committed")).toEqual([
      { label: "committed", rowVisible: true },
    ]);
  });

  it("drops the effect when the transaction rolls back", async () => {
    const r = await execute(registry, adapter, ctx, "post_commit.write", {
      marker: "rolled-back",
      mode: "throw",
    });
    expect(r.ok).toBe(false);
    expect(ran.some((e) => e.label === "rolled-back")).toBe(false);
    expect(await markerVisible("rolled-back")).toBe(false);
  });

  it("a failing effect keeps the write, returns a loud error and audits the failure", async () => {
    const r = await execute(registry, adapter, ctx, "post_commit.write", {
      marker: "effect-fails",
      mode: "fail_effect",
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "HandlerError") {
      expect(r.error.message).toContain("The change is saved");
      expect(r.error.message).toContain("effect effect-fails (host refused)");
    } else {
      throw new Error(`expected a HandlerError, got ${JSON.stringify(r)}`);
    }
    expect(await markerVisible("effect-fails")).toBe(true);
    const audited = (await adapter.rawAdmin().begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return tx`
        SELECT succeeded, result_summary FROM audit_events
        WHERE actor_id = ${actorId}::uuid AND operation = 'post_commit.write.post_commit'
      `;
    })) as { succeeded: boolean; result_summary: string }[];
    expect(audited).toEqual([
      { succeeded: false, result_summary: "effect effect-fails: host refused" },
    ]);
  });

  it("a failing effect with its own next step names that step instead of a restart (#1157)", async () => {
    const r = await execute(registry, adapter, ctx, "post_commit.write", {
      marker: "effect-own-step",
      mode: "fail_with_step",
    });
    if (r.ok || r.error.kind !== "HandlerError") {
      throw new Error(`expected a HandlerError, got ${JSON.stringify(r)}`);
    }
    expect(r.error.message).toContain("The change is saved");
    expect(r.error.message).toContain("It is retried automatically; Settings shows its status.");
    expect(r.error.message).not.toContain("Restart the admin server");
  });

  it("withAdminTransaction runs effects after its commit and drops them on a throw", async () => {
    const seen: string[] = [];
    await adapter.withAdminTransaction(ctx, async (tx) => {
      afterCommit(tx, { label: "kept", run: () => void seen.push("kept") });
      expect(seen).toEqual([]);
    });
    await expect(
      adapter.withAdminTransaction(ctx, async (tx) => {
        afterCommit(tx, { label: "dropped", run: () => void seen.push("dropped") });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(seen).toEqual(["kept"]);
  });

  it("refuses a transaction the adapter did not open, instead of guessing", async () => {
    await expect(
      adapter.admin.transaction(async (tx) => {
        afterCommit(tx, { label: "orphan", run: () => undefined });
      }),
    ).rejects.toThrow("not opened by the Database Adapter");
  });
});
