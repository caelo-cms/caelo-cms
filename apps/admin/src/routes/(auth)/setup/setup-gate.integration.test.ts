// SPDX-License-Identifier: MPL-2.0

/**
 * #1476 — `/setup` itself: on a cloud install both the page and the form post
 * stop at the token gate before anything else, and an install with an Owner
 * never reaches it. `azure` stands in for "a cloud provider whose token cannot
 * be read" without a network; the Google path is covered with a fake Secret
 * Manager in admin-core's owner-bootstrap-secret.integration.test.ts.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { actions, load } from "./+page.server.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const EMAIL = "setup-gate@example.com";
const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "setup-gate-test",
};

async function asSystem(fn: (tx: SQL) => Promise<unknown>): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

/** The event `load` and the action read; both ignore the rest. */
function event(): Parameters<typeof load>[0] & Parameters<typeof actions.default>[0] {
  const body = new FormData();
  body.set("email", EMAIL);
  body.set("password", "harbor-violet-lantern-58");
  body.set("displayName", "First Owner");
  return {
    locals: { ctx },
    url: new URL("https://admin.example.test/setup"),
    request: new Request("https://admin.example.test/setup", { method: "POST", body }),
  } as unknown as Parameters<typeof load>[0] & Parameters<typeof actions.default>[0];
}

/** What a route threw: SvelteKit's `error()` and `redirect()` throw plain objects. */
async function thrownBy(
  run: () => unknown,
): Promise<{ status?: number; location?: string; body?: { message?: string } }> {
  try {
    await run();
  } catch (e) {
    return e as { status?: number };
  }
  throw new Error("the route answered instead of refusing");
}

const providerBefore = process.env.CAELO_PROVIDER;

beforeEach(async () => {
  process.env.CAELO_PROVIDER = "azure";
  await asSystem(async (tx) => {
    await tx`DELETE FROM owner_bootstrap_tokens`;
    await tx`UPDATE users SET deleted_at = now() WHERE deleted_at IS NULL`;
  });
});

afterEach(async () => {
  await asSystem(async (tx) => {
    await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`;
    await tx`DELETE FROM users WHERE email = ${EMAIL}`;
  });
});

afterAll(() => {
  if (providerBefore === undefined) delete process.env.CAELO_PROVIDER;
  else process.env.CAELO_PROVIDER = providerBefore;
});

describe("/setup on a cloud install without an Owner", () => {
  it("refuses the page when the token cannot be read", async () => {
    const refused = await thrownBy(() => load(event()));
    expect(refused.status).toBe(503);
    expect(refused.body?.message).toContain("#1483");
  });

  it("refuses the form post too, and creates nobody", async () => {
    const refused = await thrownBy(() => actions.default(event()));
    expect(refused.status).toBe(503);
    const sql = new SQL(ADMIN_URL as string);
    try {
      const count = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return tx`SELECT count(*)::int AS n FROM users WHERE email = ${EMAIL}`;
      });
      expect((count[0] as { n: number }).n).toBe(0);
    } finally {
      await sql.end();
    }
  });
});

describe("/setup on an install with an Owner", () => {
  beforeEach(async () => {
    await asSystem(async (tx) => {
      const actors = await tx`
        INSERT INTO actors (kind, display_name) VALUES ('human', 'Owner') RETURNING id::text AS id`;
      const id = (actors[0] as { id: string }).id;
      await tx`
        INSERT INTO users (id, email, password_hash, is_first_owner)
        VALUES (${id}::uuid, ${EMAIL}, 'x', true)`;
      await tx`
        INSERT INTO user_roles (user_id, role_id)
        SELECT ${id}::uuid, r.id FROM roles r WHERE r.name = 'owner'`;
    });
  });

  it("goes to sign-in without touching the token: an existing install cannot start failing", async () => {
    expect((await thrownBy(() => load(event()))).location).toBe("/login");
    expect((await thrownBy(() => actions.default(event()))).location).toBe("/login");
  });
});

describe("/setup on a checkout or self-hosted install", () => {
  it.each(["", "self-hosted"])("provider %p keeps its form", async (provider) => {
    process.env.CAELO_PROVIDER = provider;
    expect(await load(event())).toEqual({ tokenRequired: false, tokenFromQuery: "" });
  });
});
