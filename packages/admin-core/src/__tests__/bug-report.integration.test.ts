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
        kind: "defect",
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
    // #902 — nothing forwards yet: the result must not let the AI claim
    // the Caelo team was told.
    expect(r.content).toContain("stored on this site only");
    expect(r.content).toContain("NOT notified");
  });

  it("a blockedTask report instructs the model to stop that line of work", async () => {
    const r = await bugReportTool.handler(
      SYSTEM,
      bugReportToolInput.parse({
        kind: "defect",
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

  it("every report records where it went — local_only until forwarding ships (#902)", async () => {
    const created = await execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
      kind: "defect",
      title: "BRT forwarding state",
      whatHappened: "x",
      expected: "y",
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    expect((created.value as { forwardingState: string }).forwardingState).toBe("local_only");
    const listed = await execute(registry, adapter, SYSTEM, "ai_bug_reports.list", { limit: 200 });
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const rows = (listed.value as { reports: { title: string; forwardingState: string }[] })
      .reports;
    expect(rows.find((r) => r.title === "BRT forwarding state")?.forwardingState).toBe(
      "local_only",
    );
  });

  it("stamps source 'ai' by default and 'auto' when set, surfaced by list", async () => {
    const a = await execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
      kind: "defect",
      title: "BRT source default",
      whatHappened: "x",
      expected: "y",
    });
    const b = await execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
      kind: "defect",
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

  it("stores the failing tool's INPUT as evidence, surfaced by list (2026-07 auto-capture)", async () => {
    // The chat-runner auto-capture serializes the tool call's arguments into
    // `evidence` so a detected-bug row is reproducible. Prove the field
    // round-trips through create → list (what the bugs UI + export consume).
    const toolInput = 'Tool input (build_page):\n{\n  "page": { "slug": "pricing" }\n}';
    const created = await execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
      kind: "defect",
      title: "BRT with input evidence",
      whatHappened: "build_page returned an error",
      expected: "z",
      suspectedTool: "build_page",
      evidence: toolInput,
      source: "auto",
    });
    expect(created.ok).toBe(true);
    const listed = await execute(registry, adapter, SYSTEM, "ai_bug_reports.list", { limit: 200 });
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const rows = (listed.value as { reports: { title: string; evidence: string | null }[] })
      .reports;
    expect(rows.find((r) => r.title === "BRT with input evidence")?.evidence).toBe(toolInput);
  });

  it("auto-captured reports dedupe within a session by (tool, message)", async () => {
    const sess = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      title: "BRT dedup session",
    });
    if (!sess.ok) throw new Error(JSON.stringify(sess.error));
    const chatSessionId = (sess.value as { chatSessionId: string }).chatSessionId;
    const mk = (whatHappened: string) =>
      execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
        kind: "defect",
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

describe("bug_report kind (#1192)", () => {
  type Row = { id: string; title: string; kind: string; severity: string | null };
  async function listed(input: Record<string, unknown> = {}): Promise<Row[]> {
    const r = await execute(registry, adapter, SYSTEM, "ai_bug_reports.list", {
      limit: 200,
      ...input,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (r.value as { reports: Row[] }).reports.filter((x) => x.title.startsWith("BRT "));
  }

  it("stores a suggestion from bug_report without severity and lists it as one", async () => {
    const r = await bugReportTool.handler(
      SYSTEM,
      bugReportToolInput.parse({
        kind: "suggestion",
        title: "BRT add_tracking_tag has no page/locale filter",
        whatHappened:
          "Leadinfo had to run on German product pages only; add_tracking_tag has no page, path or locale scope, so it loads site-wide.",
        expected: "add_tracking_tag accepts a scope (pages, path prefixes, locales).",
        suspectedTool: "add_tracking_tag",
      }),
      { adapter, registry } as ToolContext,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toStartWith("Suggestion ");
    expect(r.content).toContain("do not re-file this suggestion");

    const all = await listed();
    expect(
      all.find((x) => x.title === "BRT add_tracking_tag has no page/locale filter"),
    ).toMatchObject({ kind: "suggestion", severity: null });
    expect(all.find((x) => x.title === "BRT deploy op 500s")).toMatchObject({
      kind: "defect",
      severity: "blocking",
    });
    const onlySuggestions = await listed({ kind: "suggestion" });
    expect(onlySuggestions.map((x) => x.title)).toEqual([
      "BRT add_tracking_tag has no page/locale filter",
    ]);
    expect((await listed({ kind: "defect" })).every((x) => x.kind === "defect")).toBe(true);
  });

  it("refuses a graded suggestion and an auto-captured suggestion at the op", async () => {
    const base = { kind: "suggestion", title: "BRT refused", whatHappened: "x", expected: "y" };
    const graded = await execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
      ...base,
      severity: "cosmetic",
    });
    expect(graded.ok).toBe(false);
    expect(JSON.stringify(graded.ok ? null : graded.error)).toContain(
      "severity grades defects only",
    );
    const auto = await execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
      ...base,
      source: "auto",
    });
    expect(auto.ok).toBe(false);
    expect(JSON.stringify(auto.ok ? null : auto.error)).toContain(
      "an auto-captured failure is always a defect",
    );
    const noKind = await execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
      title: "BRT refused",
      whatHappened: "x",
      expected: "y",
      source: "auto",
    });
    expect(noKind.ok).toBe(false);
    expect((await listed()).some((x) => x.title === "BRT refused")).toBe(false);
  });

  it("a defect without severity is degraded; the table refuses rows that break the kind shape", async () => {
    const d = await execute(registry, adapter, SYSTEM, "ai_bug_reports.create", {
      kind: "defect",
      title: "BRT defect default severity",
      whatHappened: "x",
      expected: "y",
    });
    expect(d.ok).toBe(true);
    expect((await listed()).find((x) => x.title === "BRT defect default severity")?.severity).toBe(
      "degraded",
    );

    // Migration 0391's check, below the op: whatever writes the table.
    const sql = new SQL(ADMIN_URL!);
    try {
      for (const [kind, severity, source] of [
        ["suggestion", "degraded", "ai"],
        ["defect", null, "ai"],
        ["suggestion", null, "auto"],
        ["idea", null, "ai"],
      ] as const) {
        await expect(
          sql.begin(async (tx) => {
            await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
            await tx`INSERT INTO ai_bug_reports (actor_id, kind, severity, source, title, what_happened, expected)
              VALUES (${SYSTEM.actorId}::uuid, ${kind}, ${severity}, ${source}, 'BRT raw', 'x', 'y')`;
          }),
        ).rejects.toThrow(/violates check constraint/);
      }
      // A row written the way the previous release writes (no kind) is a graded defect.
      const [legacy] = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return tx`INSERT INTO ai_bug_reports (actor_id, title, what_happened, expected)
          VALUES (${SYSTEM.actorId}::uuid, 'BRT previous release', 'x', 'y')
          RETURNING kind, severity`;
      })) as Array<{ kind: string; severity: string }>;
      expect(legacy).toEqual({ kind: "defect", severity: "degraded" });
    } finally {
      await sql.end();
    }
  });
});
