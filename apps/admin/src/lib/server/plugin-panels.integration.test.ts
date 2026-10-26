// SPDX-License-Identifier: MPL-2.0

/**
 * The generic plugin-panel renderer against a real plugin host: a panel
 * exists exactly while its plugin runs (inactive = absent, CLAUDE.md §2),
 * its permission gates the load and every action, and an action can only
 * run what the declaration names, with fixed arguments the operator cannot
 * replace.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { signCsrfToken } from "@caelo-cms/admin-core";
import { bootstrap, resetPluginHost, setPluginDisabled } from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { SQL } from "bun";
import { actions, load } from "../../routes/(authed)/plugins/[slug]/[panel]/+page.server.js";
import { activePluginPanels, requirePanel } from "./plugin-panels.js";
import { getQueryContext } from "./query.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "test-panels";
const CSRF_SECRET = "panel-test-secret";

/** The plugin's data, kept in memory: the panel is what is under test. */
let rows: { id: string; title: string; status: string }[] = [];
const calls: { op: string; args: unknown }[] = [];

const plugin = definePlugin({
  slug: SLUG,
  version: "0.1.0",
  tier: 1,
  schema: {},
  operations: {
    list: async (_ctx, args) => {
      calls.push({ op: "list", args });
      return { items: rows };
    },
    set_status: async (_ctx, args) => {
      calls.push({ op: "set_status", args });
      const { id, status } = args as { id: string; status: string };
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("no such row");
      row.status = status;
      return { status };
    },
  },
  adminPanels: [
    {
      slug: "inbox",
      title: "Test inbox",
      description: "Rows of the test plugin.",
      icon: "inbox",
      permission: "settings.write",
      sections: [
        {
          kind: "table",
          id: "rows",
          title: "Rows",
          operation: "list",
          rowsKey: "items",
          rowKey: "id",
          emptyMessage: "Nothing here.",
          columns: [
            { key: "title", label: "Title", format: "text" },
            { key: "status", label: "Status", format: "badge" },
          ],
          rowActions: [
            {
              id: "archive",
              label: "Archive",
              operation: "set_status",
              args: { status: "archived" },
              variant: "outline",
              rowArgs: { id: "id" },
              when: [{ key: "status", notIn: ["archived"] }],
              successMessage: "Now {status}.",
            },
          ],
        },
      ],
    },
  ],
});

function locals(permissions: string[]) {
  return {
    user: { permissions: new Set(permissions), csrfSecret: CSRF_SECRET },
    ctx: { actorId: SYSTEM_ACTOR_ID, actorKind: "human", requestId: "panel-test" },
  } as unknown as App.Locals;
}

const URL_BASE = `http://admin.test/plugins/${SLUG}/inbox`;

function loadEvent(permissions: string[]) {
  return {
    locals: locals(permissions),
    params: { slug: SLUG, panel: "inbox" },
    url: new URL(URL_BASE),
  } as unknown as Parameters<typeof load>[0];
}

async function postRow(permissions: string[], fields: Record<string, string>) {
  const body = new FormData();
  body.set("_csrf", await signCsrfToken(CSRF_SECRET));
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const event = {
    request: new Request(`${URL_BASE}?/row`, { method: "POST", body }),
    locals: locals(permissions),
    params: { slug: SLUG, panel: "inbox" },
    url: new URL(`${URL_BASE}?/row`),
  };
  const action = actions.row;
  if (!action) throw new Error("no row action");
  return action(event as unknown as Parameters<typeof action>[0]);
}

/** SvelteKit's `error()` throws an HttpError carrying `status`. */
async function statusOf(fn: () => unknown): Promise<number | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

async function wipePluginRows(): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG}))`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
      await tx`DELETE FROM plugins WHERE slug = ${SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

beforeEach(async () => {
  resetPluginHost();
  await wipePluginRows();
  rows = [
    { id: "r1", title: "<b>first</b>", status: "new" },
    { id: "r2", title: "second", status: "archived" },
  ];
  calls.length = 0;
  const { adapter, registry } = getQueryContext();
  const report = await bootstrap({
    infra: { adapter, registry },
    systemActorId: SYSTEM_ACTOR_ID,
    // Not read: `testPlugins` replaces the disk walk.
    pluginsRoot: "",
    testPlugins: [{ definition: plugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterEach(async () => {
  setPluginDisabled(SLUG, false);
  resetPluginHost();
  await wipePluginRows();
});

afterAll(async () => {
  await getQueryContext().adapter.close();
});

describe("plugin panels follow the running plugin", () => {
  it("lists the panel while the plugin runs and drops it when it stops", async () => {
    expect(
      activePluginPanels()
        .find((p) => p.slug === SLUG)
        ?.panels.map((p) => p.slug),
    ).toEqual(["inbox"]);
    setPluginDisabled(SLUG, true);
    expect(activePluginPanels().some((p) => p.slug === SLUG)).toBe(false);
    expect(await statusOf(() => requirePanel(locals(["settings.write"]), SLUG, "inbox"))).toBe(404);
    setPluginDisabled(SLUG, false);
    resetPluginHost();
    expect(activePluginPanels().some((p) => p.slug === SLUG)).toBe(false);
    expect(await statusOf(() => load(loadEvent(["settings.write"])))).toBe(404);
  });

  it("404s a panel the plugin does not declare", async () => {
    expect(await statusOf(() => requirePanel(locals(["settings.write"]), SLUG, "other"))).toBe(404);
  });
});

describe("the panel's permission", () => {
  it("gates the load and every action", async () => {
    expect(await statusOf(() => load(loadEvent(["content.read"])))).toBe(403);
    expect(
      await statusOf(() =>
        postRow(["content.read"], { section: "rows", action: "archive", args: '{"id":"r1"}' }),
      ),
    ).toBe(403);
    expect(calls.filter((c) => c.op === "set_status")).toEqual([]);
  });
});

describe("rendering and actions", () => {
  it("projects rows to the declared columns and offers actions by condition", async () => {
    const data = (await load(loadEvent(["settings.write"]))) as {
      sections: { kind: string; rows: { key: unknown; cells: unknown[]; actions: unknown[] }[] }[];
    };
    const table = data.sections[0];
    expect(table?.kind).toBe("table");
    expect(table?.rows).toEqual([
      // Values travel as data; the page renders them as text.
      {
        key: "r1",
        cells: ["<b>first</b>", "new"],
        actions: [{ id: "archive", args: { id: "r1" } }],
      },
      { key: "r2", cells: ["second", "archived"], actions: [] },
    ]);
  });

  it("runs a row action with its fixed arguments, which the post cannot replace", async () => {
    const res = (await postRow(["settings.write"], {
      section: "rows",
      action: "archive",
      args: '{"id":"r1"}',
    })) as { ok?: string };
    expect(res.ok).toBe("Now archived.");
    expect(rows.find((r) => r.id === "r1")?.status).toBe("archived");

    // An extra argument in the post is refused, not merged.
    expect(
      await statusOf(() =>
        postRow(["settings.write"], {
          section: "rows",
          action: "archive",
          args: '{"id":"r2","status":"new"}',
        }),
      ),
    ).toBe(400);
    expect(rows.find((r) => r.id === "r2")?.status).toBe("archived");
  });

  it("refuses an action the panel does not declare", async () => {
    expect(
      await statusOf(() =>
        postRow(["settings.write"], { section: "rows", action: "delete", args: '{"id":"r1"}' }),
      ),
    ).toBe(400);
  });
});
