// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1461 — static files: the §11.A gate (the AI proposes, an Owner's
 * click writes), the refusals, and that a write leaves a snapshot and a
 * journal row and restores with a site revert.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, STATIC_FILE_MAX_COUNT } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "static-files-system",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000aaaa",
  actorKind: "ai",
  requestId: "static-files-ai",
};
/** A human without any role: may click, may not decide. */
const NO_ROLE: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000bbbb",
  actorKind: "human",
  requestId: "static-files-human",
};

const IPS = {
  path: "/bot/ips.json",
  contentType: "application/json",
  body: '{"ips":["192.0.2.1"]}',
  purpose: "searchVIU's Cloudflare Verified Bots registration reads this list.",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM static_file_pending_actions`;
    await tx`DELETE FROM static_files`;
    await tx`DELETE FROM redirects WHERE from_path LIKE '/sf-test%'`;
  });
}

const run = (ctx: ExecutionContext, op: string, input: unknown) =>
  execute(registry, adapter, ctx, op, input as Record<string, unknown>);

function message(r: Awaited<ReturnType<typeof run>>): string {
  if (r.ok) throw new Error("expected a refusal");
  return "message" in r.error ? String(r.error.message) : r.error.kind;
}

async function propose(files: unknown[]): Promise<string> {
  const r = await run(AI, "static_files.propose_set", { files });
  if (!r.ok) throw new Error(`propose: ${JSON.stringify(r.error)}`);
  return (r.value as { proposalId: string }).proposalId;
}

beforeAll(async () => {
  await wipe();
  await asSystem(async (tx) => {
    for (const [c, kind] of [
      [SYSTEM, "human"],
      [AI, "ai"],
      [NO_ROLE, "human"],
    ] as const) {
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${c.actorId}::uuid, ${kind}, ${c.requestId}) ON CONFLICT DO NOTHING`;
    }
  });
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("the gate", () => {
  it("does not let the AI write or approve", async () => {
    const write = await run(AI, "static_files.set_many", { files: [IPS] });
    expect(write.ok).toBe(false);
    const del = await run(AI, "static_files.delete_many", { paths: ["/x.txt"] });
    expect(del.ok).toBe(false);
    const proposalId = await propose([IPS]);
    expect((await run(AI, "static_files.execute_proposal", { proposalId })).ok).toBe(false);
    const rows = await asSystem((tx) => tx`SELECT 1 FROM static_files`);
    expect(rows).toHaveLength(0);
    expect((await run(SYSTEM, "static_files.reject_proposal", { proposalId })).ok).toBe(true);
  });

  it("leaves the proposal pending when the approver lacks settings.write", async () => {
    const proposalId = await propose([IPS]);
    const r = await run(NO_ROLE, "static_files.execute_proposal", { proposalId });
    expect(message(r)).toContain("permission_denied");
    const rows = await asSystem(
      (tx) => tx`SELECT status FROM static_file_pending_actions WHERE id = ${proposalId}::uuid`,
    );
    expect((rows as { status: string }[])[0]?.status).toBe("pending");
    await run(SYSTEM, "static_files.reject_proposal", { proposalId });
  });

  it("rejects a second identical pending proposal and shows up in the shared queue", async () => {
    const proposalId = await propose([IPS]);
    const again = await run(AI, "static_files.propose_set", { files: [IPS] });
    expect(again.ok).toBe(false);
    const queue = await run(SYSTEM, "pending_proposals.list", {});
    if (!queue.ok) throw new Error(JSON.stringify(queue.error));
    expect(JSON.stringify(queue.value)).toContain(proposalId);
    const cancel = await run(AI, "pending_proposals.cancel", { proposalId });
    expect(cancel.ok).toBe(true);
  });

  it("shows the Owner the file's text and what approving means", async () => {
    const r = await run(AI, "static_files.preview_set", { files: [IPS] });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { preview } = r.value as { preview: string };
    expect(preview).toContain("/bot/ips.json");
    expect(preview).toContain(IPS.body);
    expect(preview).toContain(IPS.purpose);
    expect(preview).toContain("prove");
  });
});

describe("a write", () => {
  it("applies on approval, with a snapshot on main and a journal row, and stays not_staged", async () => {
    const proposalId = await propose([IPS]);
    const applied = await run(SYSTEM, "static_files.execute_proposal", { proposalId });
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));
    expect((applied.value as { nextStep: string }).nextStep).toContain("Stage");
    const again = await run(SYSTEM, "static_files.execute_proposal", { proposalId });
    expect(message(again)).toContain("already applied");

    const listed = await run(AI, "static_files.list", {});
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const { files } = listed.value as {
      files: { path: string; id: string; sizeBytes: number; releaseState: string }[];
    };
    expect(files.map((f) => f.path)).toEqual([IPS.path]);
    expect(files[0]?.sizeBytes).toBe(IPS.body.length);
    expect(files[0]?.releaseState).toBe("not_staged");

    const id = files[0]?.id as string;
    const snapshots = (await asSystem(
      (tx) => tx`
        SELECT s.state, h.chat_branch_id, h.op_kind
        FROM static_file_snapshots s JOIN site_snapshots h ON h.id = s.site_snapshot_id
        WHERE s.static_file_id = ${id}::uuid`,
    )) as { state: { body: string }; chat_branch_id: string | null; op_kind: string }[];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.state.body).toBe(IPS.body);
    expect(snapshots[0]?.chat_branch_id).toBeNull();
    expect(snapshots[0]?.op_kind).toBe("static_files.set_many");
    const journal = await asSystem(
      (tx) => tx`SELECT 1 FROM entity_changes WHERE kind = 'static_file' AND row_id = ${id}`,
    );
    expect(journal.length).toBeGreaterThan(0);
  });

  it("replaces by path, and reading returns the text", async () => {
    const body = '{"ips":["192.0.2.2"]}';
    const r = await run(SYSTEM, "static_files.set_many", { files: [{ ...IPS, body }] });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect((r.value as { files: { version: number }[] }).files[0]?.version).toBe(2);
    const got = await run(AI, "static_files.get", { path: IPS.path });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    expect((got.value as { body: string }).body).toBe(body);
    expect(message(await run(AI, "static_files.get", { path: "/nope.txt" }))).toContain(IPS.path);
  });

  it("restores with a site revert, a deleted file included", async () => {
    const rows = (await asSystem(
      (tx) => tx`
        SELECT site_snapshot_id::text AS id FROM static_file_snapshots ORDER BY created_at ASC LIMIT 1`,
    )) as { id: string }[];
    const firstSnapshot = rows[0]?.id as string;
    const del = await run(SYSTEM, "static_files.delete_many", { paths: [IPS.path] });
    expect(del.ok).toBe(true);
    expect((await run(AI, "static_files.get", { path: IPS.path })).ok).toBe(false);
    const revert = await run(SYSTEM, "snapshots.revert_site", { snapshotId: firstSnapshot });
    if (!revert.ok) throw new Error(JSON.stringify(revert.error));
    const got = await run(AI, "static_files.get", { path: IPS.path });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    expect((got.value as { body: string }).body).toBe(IPS.body);
  });

  it("brings a deleted path back on its own row", async () => {
    const before = await asSystem((tx) => tx`SELECT id FROM static_files WHERE path = ${IPS.path}`);
    await run(SYSTEM, "static_files.delete_many", { paths: [IPS.path] });
    const proposalId = await propose([IPS]);
    expect((await run(SYSTEM, "static_files.execute_proposal", { proposalId })).ok).toBe(true);
    const after = await asSystem((tx) => tx`SELECT id FROM static_files WHERE path = ${IPS.path}`);
    expect(after).toEqual(before);
  });

  it("deletes through a proposal, and refuses a path without a file", async () => {
    const missing = await run(AI, "static_files.propose_delete", { paths: ["/nope.txt"] });
    expect(message(missing)).toContain("no static file");
    const proposed = await run(AI, "static_files.propose_delete", { paths: [IPS.path] });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const { proposalId } = proposed.value as { proposalId: string };
    expect((await run(SYSTEM, "static_files.execute_proposal", { proposalId })).ok).toBe(true);
    const listed = await run(AI, "static_files.list", {});
    expect(listed.ok && (listed.value as { files: unknown[] }).files).toEqual([]);
  });
});

describe("the refusals", () => {
  it("names every problem of a proposal before anything costs a click", async () => {
    const r = await run(AI, "static_files.propose_set", {
      files: [
        { ...IPS, path: "/api/ips.json" },
        { ...IPS, path: "/_caelo/ips.json" },
        { ...IPS, path: "/page.html" },
        { ...IPS, path: "/robots.txt", contentType: "text/plain" },
        { ...IPS, path: "/broken.json", body: "{" },
        { ...IPS, path: "/script.txt", contentType: "application/json" },
      ],
    });
    const text = message(r);
    for (const part of ["/api", "/_caelo", ".html", "robots.txt", "valid JSON", "/script.txt"]) {
      expect(text).toContain(part);
    }
  });

  it("refuses a schema-level type outside the allow-list", async () => {
    const r = await run(AI, "static_files.propose_set", {
      files: [{ ...IPS, path: "/x", contentType: "text/html" }],
    });
    expect(r.ok).toBe(false);
  });

  it("refuses a path a redirect starts at, and a redirect from a file's path", async () => {
    const redirect = await run(SYSTEM, "redirects.create", {
      fromPath: "/sf-test-old.json",
      toPath: "/",
    });
    if (!redirect.ok) throw new Error(JSON.stringify(redirect.error));
    const r = await run(AI, "static_files.propose_set", {
      files: [{ ...IPS, path: "/sf-test-old.json" }],
    });
    expect(message(r)).toContain("redirect starts at");

    const written = await run(SYSTEM, "static_files.set_many", {
      files: [{ ...IPS, path: "/sf-test-file.json" }],
    });
    if (!written.ok) throw new Error(JSON.stringify(written.error));
    const one = await run(SYSTEM, "redirects.create", {
      fromPath: "/sf-test-file.json",
      toPath: "/",
    });
    expect(message(one)).toContain("static file");
    const many = await run(SYSTEM, "redirects.create_many", {
      redirects: [{ fromPath: "/sf-test-file.json/", toPath: "/" }],
    });
    expect(message(many)).toContain("static file");
  });

  it("refuses a path another file needs as a folder", async () => {
    const r = await run(AI, "static_files.propose_set", {
      files: [{ ...IPS, path: "/sf-test-file.json/below.json" }],
    });
    expect(message(r)).toContain("needs a folder");
  });

  it("refuses the file past the site's cap, loudly", async () => {
    await asSystem(async (tx) => {
      for (let i = 0; i < STATIC_FILE_MAX_COUNT; i += 1) {
        await tx`INSERT INTO static_files (path, content_type, body, purpose)
                 VALUES (${`/sf-cap/${i}.txt`}, 'text/plain', 'x', 'cap test')`;
      }
    });
    const r = await run(AI, "static_files.propose_set", {
      files: [{ ...IPS, path: "/sf-cap/one-more.json" }],
    });
    expect(message(r)).toContain(`at most ${STATIC_FILE_MAX_COUNT}`);
  });
});
