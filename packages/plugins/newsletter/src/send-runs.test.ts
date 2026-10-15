// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 — a newsletter send is exactly what the operator approved:
 * the approved subject, body and recipient bound, snapshotted into private
 * storage, sent once, never re-read from the public side.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1, PluginQuery, PluginQueryFilter } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";
import { SENDS_PER_TICK } from "./send-runs.js";

type Row = Record<string, unknown> & { id: string };

/** An in-memory stand-in for a plugin storage handle. */
class FakeStore {
  readonly tables = new Map<string, Row[]>();
  private seq = 0;

  rows(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  handle(): PluginQuery {
    return {
      insert: async (table, data) => {
        this.seq += 1;
        const id = `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
        this.rows(table).push({
          id,
          created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)).toISOString(),
          ...structuredClone(data),
        });
        return { id };
      },
      list: async <T>(table: string, filter: PluginQueryFilter = {}) => {
        const { limit = 100, orderBy, orderDir = "desc", since: _since, ...equals } = filter;
        let rows = this.rows(table).filter((r) =>
          Object.entries(equals).every(([k, v]) => r[k] === v),
        );
        if (orderBy) {
          const dir = orderDir === "asc" ? 1 : -1;
          rows = [...rows].sort(
            (a, b) => dir * String(a[orderBy]).localeCompare(String(b[orderBy])),
          );
        }
        return structuredClone(rows.slice(0, limit)) as T[];
      },
      update: async (table, id, patch) => {
        const row = this.rows(table).find((r) => r.id === id);
        if (!row) throw new Error(`${table}/${id} not found`);
        Object.assign(row, structuredClone(patch));
      },
      delete: async (table, id) => {
        this.tables.set(
          table,
          this.rows(table).filter((r) => r.id !== id),
        );
      },
      compareAndSwap: async (table, id, expected, patch) => {
        const row = this.rows(table).find((r) => r.id === id);
        if (!row) return false;
        if (!Object.entries(expected).every(([k, v]) => row[k] === v)) return false;
        Object.assign(row, structuredClone(patch));
        return true;
      },
    };
  }
}

function harness(opts: { withAdmin?: boolean } = {}) {
  const pub = new FakeStore();
  const priv = new FakeStore();
  const mails: Array<{ to: string; subject: string; html: string }> = [];
  const ctx = {
    invocation: { origin: "approved", actorId: "11111111-1111-4111-8111-111111111111" },
    query: pub.handle(),
    ...(opts.withAdmin === false ? {} : { adminQuery: priv.handle() }),
    email: {
      send: async (m: { to: string; subject: string; html: string }) => {
        mails.push(m);
        return { messageId: `m-${mails.length}` };
      },
    },
  } as unknown as PluginContextTier1;
  return { ctx, pub, priv, mails };
}

async function op(ctx: PluginContextTier1, name: string, args: unknown = {}): Promise<unknown> {
  const fn = plugin.operations[name];
  if (!fn) throw new Error(`no operation ${name}`);
  return fn(ctx, args);
}

async function seed(
  h: ReturnType<typeof harness>,
  emails: string[],
  campaign = { subject: "Spring news", body_html: "<p>Sale</p>" },
): Promise<string> {
  for (const [i, email] of emails.entries()) {
    await h.ctx.query.insert("subscribers", {
      email,
      email_hash: `h${i}`,
      confirm_token: `c${i}`,
      unsub_token: `u${i}`,
      confirmed_at: "2026-01-01T00:00:00.000Z",
      unsubscribed_at: null,
    });
  }
  const { id } = await h.ctx.query.insert("campaigns", { slug: "s", status: "draft", ...campaign });
  return id;
}

/** The approval exactly as get_newsletter_campaign hands it to the AI. */
async function approval(ctx: PluginContextTier1, campaignId: string) {
  const c = (await op(ctx, "get_campaign", { campaignId })) as {
    subject: string;
    bodyHtml: string;
    recipientCount: number;
  };
  return { campaignId, subject: c.subject, bodyHtml: c.bodyHtml, recipientCount: c.recipientCount };
}

async function drainAll(ctx: PluginContextTier1): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = (await op(ctx, "_drain_sends")) as { attempted: number; superseded: number };
    if (r.attempted === 0 && r.superseded === 0) return;
  }
}

describe("send_campaign (#635)", () => {
  it("fails before any read or write when private storage is missing", async () => {
    const h = harness({ withAdmin: false });
    const id = await seed(h, ["a@example.com"]);
    const before = structuredClone([...h.pub.tables]);
    await expect(
      op(h.ctx, "send_campaign", {
        campaignId: id,
        subject: "Spring news",
        bodyHtml: "<p>Sale</p>",
        recipientCount: 1,
      }),
    ).rejects.toThrow("cms_admin_schema");
    expect([...h.pub.tables]).toEqual(before);
  });

  it("refuses when the public draft no longer matches what was approved", async () => {
    const h = harness();
    const id = await seed(h, ["a@example.com"]);
    const approved = await approval(h.ctx, id);
    await h.ctx.query.update("campaigns", id, {
      body_html: '<a href="https://evil.example">x</a>',
    });
    await expect(op(h.ctx, "send_campaign", approved)).rejects.toThrow(
      "changed after it was shown",
    );
    expect(h.priv.rows("send_runs")).toEqual([]);
  });

  it("refuses when more subscribers would receive it than the approval covers", async () => {
    const h = harness();
    const id = await seed(h, ["a@example.com"]);
    const approved = await approval(h.ctx, id);
    await seed(h, ["forged@example.com"]);
    await expect(op(h.ctx, "send_campaign", approved)).rejects.toThrow("covers at most 1");
    expect(h.priv.rows("send_runs")).toEqual([]);
  });

  it("is single-use: a second approval of the same campaign is refused", async () => {
    const h = harness();
    const id = await seed(h, ["a@example.com"]);
    const approved = await approval(h.ctx, id);
    await op(h.ctx, "send_campaign", approved);
    await expect(op(h.ctx, "send_campaign", approved)).rejects.toThrow("used once");
    expect(h.priv.rows("send_runs")).toHaveLength(1);
  });

  it("records the approval as one private row and touches nothing public", async () => {
    const h = harness();
    const id = await seed(h, ["a@example.com", "A@Example.com", "not-an-address"]);
    const publicBefore = structuredClone([...h.pub.tables]);
    const r = (await op(h.ctx, "send_campaign", {
      ...(await approval(h.ctx, id)),
    })) as { queued: number; skippedInvalidAddresses: number };
    expect(r).toMatchObject({ queued: 1, skippedInvalidAddresses: 1 });
    expect([...h.pub.tables]).toEqual(publicBefore);
    const runs = h.priv.rows("send_runs");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      campaign_id: id,
      subject: "Spring news",
      body_html: "<p>Sale</p>",
      recipient_count: 1,
      status: "approved",
    });
  });
});

describe("_drain_sends (#635)", () => {
  it("sends the approved snapshot, never the public draft rewritten after approval", async () => {
    const h = harness();
    const id = await seed(h, ["a@example.com"]);
    await op(h.ctx, "send_campaign", await approval(h.ctx, id));
    await h.ctx.query.update("campaigns", id, {
      subject: "Verify your account",
      body_html: '<a href="https://evil.example">verify</a>',
    });
    await drainAll(h.ctx);
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0]?.subject).toBe("Spring news");
    expect(h.mails[0]?.html.startsWith("<p>Sale</p>")).toBe(true);
    expect(h.mails[0]?.html).not.toContain("evil.example");
  });

  it("mails only the approval's recipients: forged subscribers and forged queue rows send nothing", async () => {
    const h = harness();
    const id = await seed(h, ["a@example.com"]);
    await op(h.ctx, "send_campaign", await approval(h.ctx, id));
    // The public side adds a confirmed subscriber and queue rows for it.
    await seed(h, ["victim@example.com"]);
    const forged = h.pub.rows("subscribers").find((r) => r.email === "victim@example.com");
    for (let i = 0; i < 3; i++) {
      await h.ctx.query.insert("sends", {
        campaign_id: id,
        subscriber_id: forged?.id,
        status: "pending",
      });
    }
    await drainAll(h.ctx);
    expect(h.mails.map((m) => m.to)).toEqual(["a@example.com"]);
    const stray = h.pub.rows("sends").filter((r) => r.run_id === undefined);
    expect(stray.map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
  });

  it("never mails an address twice, even if the public send log is wiped", async () => {
    const h = harness();
    const id = await seed(h, ["a@example.com", "b@example.com"]);
    await op(h.ctx, "send_campaign", await approval(h.ctx, id));
    await drainAll(h.ctx);
    h.pub.tables.set("sends", []);
    await h.ctx.query.update("campaigns", id, { status: "draft" });
    await drainAll(h.ctx);
    expect(h.mails.map((m) => m.to).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("sends only the oldest run of a campaign; a second run is superseded", async () => {
    const h = harness();
    const id = await seed(h, ["a@example.com"]);
    const approved = await approval(h.ctx, id);
    await op(h.ctx, "send_campaign", approved);
    // A concurrent second approval that got past the single-use check.
    const { id: _firstId, created_at: _at, ...first } = h.priv.rows("send_runs")[0] as Row;
    await h.priv.handle().insert("send_runs", first);
    await drainAll(h.ctx);
    expect(h.mails).toHaveLength(1);
    expect(h.priv.rows("send_runs").map((r) => r.status)).toEqual(["done", "superseded"]);
  });

  it("skips a recipient who unsubscribed after the approval", async () => {
    const h = harness();
    const id = await seed(h, ["a@example.com", "b@example.com"]);
    await op(h.ctx, "send_campaign", await approval(h.ctx, id));
    const b = h.pub.rows("subscribers").find((r) => r.email === "b@example.com") as Row;
    await h.ctx.query.update("subscribers", b.id, { unsubscribed_at: "2026-02-01T00:00:00.000Z" });
    await drainAll(h.ctx);
    expect(h.mails.map((m) => m.to)).toEqual(["a@example.com"]);
  });

  it("is not starved by stray queue rows: an approved run sends on the first tick", async () => {
    const h = harness();
    const id = await seed(h, ["a@example.com"]);
    for (let i = 0; i < 15; i++) {
      await h.ctx.query.insert("sends", { campaign_id: id, subscriber_id: "x", status: "pending" });
    }
    await op(h.ctx, "send_campaign", await approval(h.ctx, id));
    const r = (await op(h.ctx, "_drain_sends")) as { sent: number; quarantined: number };
    expect(r).toMatchObject({ sent: 1, quarantined: 15 });
  });

  it("sends a large run in batches, claimed before mailing, and finishes it", async () => {
    const h = harness();
    const emails = Array.from({ length: SENDS_PER_TICK + 3 }, (_, i) => `r${i}@example.com`);
    const id = await seed(h, emails);
    await op(h.ctx, "send_campaign", await approval(h.ctx, id));
    const first = (await op(h.ctx, "_drain_sends")) as { sent: number };
    expect(first.sent).toBe(SENDS_PER_TICK);
    expect(h.priv.rows("send_runs")[0]).toMatchObject({ status: "approved" });
    expect(h.priv.rows("send_progress")[0]?.cursor).toBe(SENDS_PER_TICK);
    await drainAll(h.ctx);
    expect(h.mails).toHaveLength(emails.length);
    expect(h.priv.rows("send_runs")[0]).toMatchObject({ status: "done" });
    expect(h.pub.rows("campaigns")[0]).toMatchObject({ status: "sent" });
  });

  it("does not mail a batch another worker claimed first", async () => {
    const h = harness();
    const id = await seed(h, ["a@example.com"]);
    await op(h.ctx, "send_campaign", await approval(h.ctx, id));
    const admin = h.priv.handle();
    // The other worker's claim lands between our read of the cursor and
    // our swap.
    await admin.insert("send_progress", { id: (h.priv.rows("send_runs")[0] as Row).id, cursor: 0 });
    const raced = {
      ...admin,
      list: async <T>(table: string, filter?: PluginQueryFilter) => {
        const rows = await admin.list<string, T>(table, filter);
        if (table === "send_progress") {
          (h.priv.rows("send_progress")[0] as Row).cursor = 1;
        }
        return rows;
      },
    };
    const ctx = { ...h.ctx, adminQuery: raced } as unknown as PluginContextTier1;
    const r = (await op(ctx, "_drain_sends")) as { sent: number };
    expect(r.sent).toBe(0);
    expect(h.mails).toEqual([]);
  });

  it("finishes a run whose last batch was claimed before a crash, without mailing it again", async () => {
    const h = harness();
    const id = await seed(h, ["a@example.com"]);
    await op(h.ctx, "send_campaign", await approval(h.ctx, id));
    const run = h.priv.rows("send_runs")[0] as Row;
    await h.priv.handle().insert("send_progress", { id: run.id, cursor: 1 });
    await op(h.ctx, "_drain_sends");
    expect(h.mails).toEqual([]);
    expect(h.priv.rows("send_runs")[0]).toMatchObject({ status: "done" });
    expect(h.pub.rows("campaigns")[0]).toMatchObject({ status: "sent" });
  });
});
