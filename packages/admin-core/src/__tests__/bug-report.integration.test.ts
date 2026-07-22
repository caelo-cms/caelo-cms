// SPDX-License-Identifier: MPL-2.0

/**
 * 2026-07 — `bug_report`, the AI's defect channel. The tool persists a
 * triageable row via ai_bug_reports.create and instructs the model to
 * either continue (workaround) or stop (blockedTask). Real Postgres
 * (§6); the rows double as an e2e metric, so shape stability matters.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { bugReportTool, bugReportToolInput } from "../ai/tools/bug-report.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "bug-report-test",
};

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM ai_bug_reports WHERE title LIKE ${"BRT %"}`;
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

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("bug_report tool + ai_bug_reports ops", () => {
  it("persists a workaround report and tells the model to continue", async () => {
    const r = await bugReportTool.handler(
      SYSTEM,
      bugReportToolInput.parse({
        title: "BRT selector crop ignored",
        whatHappened:
          "screenshot_page({selector: '.grid'}) returned the full page render, twice, with two different selectors.",
        expected: "A cropped screenshot of only the matched element.",
        suspectedTool: "screenshot_page",
        evidence: "image dimensions equal full viewport on both calls",
      }),
      { adapter, registry } as ToolContext,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Continue the task");
    expect(r.content).not.toContain("stop this line of work");
  });

  it("a blockedTask report instructs the model to stop that line of work", async () => {
    const r = await bugReportTool.handler(
      SYSTEM,
      bugReportToolInput.parse({
        title: "BRT deploy op 500s",
        whatHappened: "deploy.trigger returns HandlerError on every attempt.",
        expected: "A staged build.",
        severity: "blocking",
        blockedTask: true,
      }),
      { adapter, registry } as ToolContext,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("task blocked");
    expect(r.content).toContain("stop this line of work");
  });

  it("ai_bug_reports.list returns the rows newest-first with a total", async () => {
    const listed = await execute(registry, adapter, SYSTEM, "ai_bug_reports.list", {
      status: "new",
    });
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const { reports, total } = listed.value as {
      reports: { title: string; severity: string; blockedTask: boolean; status: string }[];
      total: number;
    };
    const mine = reports.filter((x) => x.title.startsWith("BRT "));
    expect(mine.length).toBe(2);
    expect(total).toBeGreaterThanOrEqual(2);
    // Newest first: the blocking report was filed second.
    expect(mine[0]?.title).toBe("BRT deploy op 500s");
    expect(mine[0]?.blockedTask).toBe(true);
    expect(mine[0]?.severity).toBe("blocking");
    expect(mine[1]?.blockedTask).toBe(false);
    expect(mine.every((x) => x.status === "new")).toBe(true);
  });

  it("stamps source 'ai' by default and 'auto' when set, surfaced by list", async () => {
    const a = await execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
      title: "BRT source default",
      whatHappened: "x",
      expected: "y",
    });
    const b = await execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
      title: "BRT source auto",
      whatHappened: "x",
      expected: "y",
      source: "auto",
    });
    expect(a.ok && b.ok).toBe(true);
    const listed = await execute(registry, adapter, SYSTEM, "ai_bug_reports.list", { limit: 200 });
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const rows = (listed.value as { reports: { title: string; source: string }[] }).reports;
    expect(rows.find((r) => r.title === "BRT source default")?.source).toBe("ai");
    expect(rows.find((r) => r.title === "BRT source auto")?.source).toBe("auto");
  });

  it("auto-captured reports dedupe within a session by (tool, message)", async () => {
    const sess = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      title: "BRT dedup session",
    });
    if (!sess.ok) throw new Error(JSON.stringify(sess.error));
    const chatSessionId = (sess.value as { chatSessionId: string }).chatSessionId;
    const mk = (whatHappened: string) =>
      execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
        title: "BRT auto dedup",
        whatHappened,
        expected: "ok",
        suspectedTool: "get_import_page_screenshot",
        severity: "degraded",
        source: "auto",
        chatSessionId,
      });
    const first = await mk("import page not found");
    const again = await mk("import page not found"); // identical → deduped
    const other = await mk("a different failure"); // distinct → new row
    if (!first.ok || !again.ok || !other.ok) throw new Error("create failed");
    const id1 = (first.value as { id: string }).id;
    expect((again.value as { id: string }).id).toBe(id1); // deduped
    expect((other.value as { id: string }).id).not.toBe(id1); // distinct failure
  });
});
