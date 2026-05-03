// SPDX-License-Identifier: MPL-2.0

/**
 * P9 — locales propose/execute split (CLAUDE.md §11.A). Asserts:
 *   - AI can propose every locale change.
 *   - The propose row lands in locale_pending_actions.
 *   - The execute path rejects AI actors (ActorScopeRejected).
 *   - A human can execute → the locale row mutates.
 *   - Rejecting the proposal closes it without applying.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "locales-test",
};
const aiCtx: ExecutionContext = {
  ...systemCtx,
  actorKind: "ai",
  requestId: "locales-test-ai",
};

const TEST_LOCALES = ["xx", "yy", "zz", "ab"];

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // Strip is_default off any test locale, delete them, then make
      // sure 'en' is back to default (no UNIQUE-violating overlap).
      for (const code of TEST_LOCALES) {
        await tx`UPDATE locales SET is_default = false WHERE code = ${code}`;
        await tx`DELETE FROM locale_pending_actions WHERE payload->>'code' = ${code}`;
        await tx`DELETE FROM pages WHERE locale = ${code}`;
        await tx`DELETE FROM locales WHERE code = ${code}`;
      }
      // Clean redirects emitted by the redirect-creation tests.
      await tx`DELETE FROM redirects WHERE from_path LIKE '/zz/%' OR from_path LIKE '/ab/%' OR from_path LIKE '/yy/%'`;
      await tx`UPDATE locales SET is_default = true WHERE code = 'en'`;
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

describe("locales propose/execute split", () => {
  it("AI proposes a create; human executes; locale appears", async () => {
    const propose = await execute(registry, adapter, aiCtx, "locales.propose_create", {
      code: "xx",
      displayName: "Test XX",
      urlStrategy: "subdirectory",
    });
    expect(propose.ok).toBe(true);
    if (!propose.ok) return;
    const { proposalId } = propose.value as { proposalId: string };

    // AI cannot execute — ActorScopeRejected at the validator.
    const aiExec = await execute(registry, adapter, aiCtx, "locales.execute_proposal", {
      proposalId,
    });
    expect(aiExec.ok).toBe(false);
    if (!aiExec.ok) {
      expect(aiExec.error.kind).toBe("ActorScopeRejected");
    }

    // Human (system here) can execute.
    const exec = await execute(registry, adapter, systemCtx, "locales.execute_proposal", {
      proposalId,
    });
    expect(exec.ok).toBe(true);

    const list = await execute(registry, adapter, systemCtx, "locales.list", {});
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const codes = (list.value as { locales: { code: string }[] }).locales.map((l) => l.code);
    expect(codes).toContain("xx");
  });

  it("rejecting a proposal closes it without applying the change", async () => {
    const propose = await execute(registry, adapter, aiCtx, "locales.propose_create", {
      code: "yy",
      displayName: "Test YY",
      urlStrategy: "subdirectory",
    });
    expect(propose.ok).toBe(true);
    if (!propose.ok) return;
    const { proposalId } = propose.value as { proposalId: string };

    const reject = await execute(registry, adapter, systemCtx, "locales.reject_proposal", {
      proposalId,
      note: "not now",
    });
    expect(reject.ok).toBe(true);

    // Subsequent execute on a rejected proposal fails.
    const exec = await execute(registry, adapter, systemCtx, "locales.execute_proposal", {
      proposalId,
    });
    expect(exec.ok).toBe(false);

    const list = await execute(registry, adapter, systemCtx, "locales.list", {});
    if (!list.ok) return;
    const codes = (list.value as { locales: { code: string }[] }).locales.map((l) => l.code);
    expect(codes).not.toContain("yy");
  });

  it("propose_delete refuses to queue removing the default locale", async () => {
    const propose = await execute(registry, adapter, aiCtx, "locales.propose_delete", {
      code: "en",
    });
    expect(propose.ok).toBe(false);
    if (!propose.ok) {
      expect(propose.error.kind).toBe("HandlerError");
      const message = "message" in propose.error ? propose.error.message : "";
      expect(message).toMatch(/default/);
    }
  });

  it("set_default proposal flips is_default atomically on execute", async () => {
    // Add a second locale first so we have somewhere to set default.
    const addSecond = await execute(registry, adapter, aiCtx, "locales.propose_create", {
      code: "zz",
      displayName: "Test ZZ",
      urlStrategy: "subdirectory",
    });
    if (!addSecond.ok) throw new Error("propose_create failed");
    const proposalId1 = (addSecond.value as { proposalId: string }).proposalId;
    await execute(registry, adapter, systemCtx, "locales.execute_proposal", {
      proposalId: proposalId1,
    });

    // Now propose set_default to zz.
    const swap = await execute(registry, adapter, aiCtx, "locales.propose_set_default", {
      code: "zz",
    });
    expect(swap.ok).toBe(true);
    if (!swap.ok) return;
    const { proposalId } = swap.value as { proposalId: string };
    const exec = await execute(registry, adapter, systemCtx, "locales.execute_proposal", {
      proposalId,
    });
    expect(exec.ok).toBe(true);

    const list = await execute(registry, adapter, systemCtx, "locales.list", {});
    if (!list.ok) return;
    const locales = (list.value as { locales: { code: string; isDefault: boolean }[] }).locales;
    const def = locales.find((l) => l.isDefault);
    expect(def?.code).toBe("zz");
  });

  it("update_strategy proposal applies new strategy + url_host on execute", async () => {
    // Add a locale then propose changing its strategy.
    const add = await execute(registry, adapter, aiCtx, "locales.propose_create", {
      code: "ab",
      displayName: "Test AB",
      urlStrategy: "subdirectory",
    });
    if (!add.ok) throw new Error("propose_create failed");
    await execute(registry, adapter, systemCtx, "locales.execute_proposal", {
      proposalId: (add.value as { proposalId: string }).proposalId,
    });

    const propose = await execute(registry, adapter, aiCtx, "locales.propose_update_strategy", {
      code: "ab",
      urlStrategy: "subdomain",
      urlHost: "ab.example.com",
    });
    expect(propose.ok).toBe(true);
    if (!propose.ok) return;
    const exec = await execute(registry, adapter, systemCtx, "locales.execute_proposal", {
      proposalId: (propose.value as { proposalId: string }).proposalId,
    });
    expect(exec.ok).toBe(true);

    const get = await execute(registry, adapter, systemCtx, "locales.get", { code: "ab" });
    if (!get.ok) return;
    const { locale } = get.value as {
      locale: { urlStrategy: string; urlHost: string | null } | null;
    };
    expect(locale?.urlStrategy).toBe("subdomain");
    expect(locale?.urlHost).toBe("ab.example.com");
  });

  it("AI cannot reject a proposal either (Owner-only too)", async () => {
    const propose = await execute(registry, adapter, aiCtx, "locales.propose_create", {
      code: "xx",
      displayName: "X",
      urlStrategy: "subdirectory",
    });
    if (!propose.ok) throw new Error("propose failed");
    const { proposalId } = propose.value as { proposalId: string };
    const aiReject = await execute(registry, adapter, aiCtx, "locales.reject_proposal", {
      proposalId,
    });
    expect(aiReject.ok).toBe(false);
    if (!aiReject.ok) {
      expect(aiReject.error.kind).toBe("ActorScopeRejected");
    }
  });

  // P9 review pass — execute path now creates redirects to honour the
  // propose-time preview's `redirectsToCreate` count.
  it("update_strategy execute creates 301 redirects for affected published pages", async () => {
    // Seed a 'zz' locale on subdirectory + a published page.
    const add = await execute(registry, adapter, aiCtx, "locales.propose_create", {
      code: "zz",
      displayName: "Test ZZ",
      urlStrategy: "subdirectory",
    });
    if (!add.ok) throw new Error("propose_create failed");
    await execute(registry, adapter, systemCtx, "locales.execute_proposal", {
      proposalId: (add.value as { proposalId: string }).proposalId,
    });

    // Seed one published page via raw SQL (skipping the page op chain
    // for test isolation; we just need a row to drive redirect emission).
    const sqlClient = new SQL(ADMIN_URL);
    try {
      await sqlClient.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`
          INSERT INTO pages (slug, locale, name, title, template_id, status)
          SELECT 'about', 'zz', 'About', 'About',
                 (SELECT id FROM templates LIMIT 1), 'published'
        `;
      });
    } finally {
      await sqlClient.end();
    }

    // Now propose subdirectory → none and execute. The 'about' page's
    // URL goes from /zz/about/ to /about/ — one same-host redirect.
    const propose = await execute(registry, adapter, aiCtx, "locales.propose_update_strategy", {
      code: "zz",
      urlStrategy: "none",
    });
    if (!propose.ok) throw new Error("propose_update_strategy failed");
    const exec = await execute(registry, adapter, systemCtx, "locales.execute_proposal", {
      proposalId: (propose.value as { proposalId: string }).proposalId,
    });
    expect(exec.ok).toBe(true);
    if (!exec.ok) return;
    const { redirectsCreated, crossHostShifts } = exec.value as {
      redirectsCreated: number;
      crossHostShifts: number;
    };
    expect(redirectsCreated).toBe(1);
    expect(crossHostShifts).toBe(0);

    // Verify the redirect row landed. resolveLocaleUrl emits trailing-
    // slash paths so the row matches what the static host serves.
    const lookup = await execute(registry, adapter, systemCtx, "redirects.lookup", {
      fromPath: "/zz/about/",
    });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    const row = (lookup.value as { match: { fromPath: string; toPath: string } | null }).match;
    expect(row?.toPath).toBe("/about/");
  });

  it("delete execute soft-deletes pages AND emits one redirect per page → '/'", async () => {
    // Seed 'yy' locale + two published pages.
    const add = await execute(registry, adapter, aiCtx, "locales.propose_create", {
      code: "yy",
      displayName: "Test YY",
      urlStrategy: "subdirectory",
    });
    if (!add.ok) throw new Error("propose_create failed");
    await execute(registry, adapter, systemCtx, "locales.execute_proposal", {
      proposalId: (add.value as { proposalId: string }).proposalId,
    });
    const sqlClient = new SQL(ADMIN_URL);
    try {
      await sqlClient.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`
          INSERT INTO pages (slug, locale, name, title, template_id, status)
          SELECT 'about-yy', 'yy', 'About', 'About',
                 (SELECT id FROM templates LIMIT 1), 'published'
        `;
        await tx`
          INSERT INTO pages (slug, locale, name, title, template_id, status)
          SELECT 'contact-yy', 'yy', 'Contact', 'Contact',
                 (SELECT id FROM templates LIMIT 1), 'published'
        `;
      });
    } finally {
      await sqlClient.end();
    }

    const propose = await execute(registry, adapter, aiCtx, "locales.propose_delete", {
      code: "yy",
    });
    if (!propose.ok) throw new Error("propose_delete failed");
    const exec = await execute(registry, adapter, systemCtx, "locales.execute_proposal", {
      proposalId: (propose.value as { proposalId: string }).proposalId,
    });
    expect(exec.ok).toBe(true);
    if (!exec.ok) return;
    const { redirectsCreated } = exec.value as { redirectsCreated: number };
    expect(redirectsCreated).toBe(2);

    // Locale row gone, both redirects exist with toPath='/'.
    const get = await execute(registry, adapter, systemCtx, "locales.get", { code: "yy" });
    if (!get.ok) return;
    expect((get.value as { locale: unknown }).locale).toBeNull();
    const lookup = await execute(registry, adapter, systemCtx, "redirects.lookup", {
      fromPath: "/yy/about-yy/",
    });
    if (!lookup.ok) return;
    const row = (lookup.value as { match: { fromPath: string; toPath: string } | null }).match;
    expect(row?.toPath).toBe("/");
  });

  it("translation_status_matrix synthesises not_started for missing variants", async () => {
    // Seed a 'zz' locale + a source-locale page on 'en'.
    const add = await execute(registry, adapter, aiCtx, "locales.propose_create", {
      code: "zz",
      displayName: "Test ZZ",
      urlStrategy: "subdirectory",
    });
    if (!add.ok) throw new Error("propose_create failed");
    await execute(registry, adapter, systemCtx, "locales.execute_proposal", {
      proposalId: (add.value as { proposalId: string }).proposalId,
    });

    const sqlClient = new SQL(ADMIN_URL);
    try {
      await sqlClient.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`
          INSERT INTO pages (slug, locale, name, title, template_id, status, translation_status)
          SELECT 'matrix-test', 'en', 'M', 'M',
                 (SELECT id FROM templates LIMIT 1), 'draft', 'source'
        `;
      });
    } finally {
      await sqlClient.end();
    }

    const matrix = await execute(registry, adapter, systemCtx, "pages.translation_status_matrix", {
      slug: "matrix-test",
    });
    expect(matrix.ok).toBe(true);
    if (!matrix.ok) return;
    const rows = (
      matrix.value as {
        rows: { slug: string; locale: string; status: string; pageId: string | null }[];
      }
    ).rows;

    // EN row exists (source); ZZ row synthesised (not_started); EN's row
    // has a real pageId, ZZ's pageId is null.
    const en = rows.find((r) => r.locale === "en");
    const zz = rows.find((r) => r.locale === "zz");
    expect(en?.status).toBe("source");
    expect(en?.pageId).not.toBeNull();
    expect(zz?.status).toBe("not_started");
    expect(zz?.pageId).toBeNull();

    // Cleanup the test row.
    const cleanup = new SQL(ADMIN_URL);
    try {
      await cleanup.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`DELETE FROM pages WHERE slug = 'matrix-test'`;
      });
    } finally {
      await cleanup.end();
    }
  });

  it("translation_status enum accepts spec values, rejects legacy fresh/stale", async () => {
    const sqlClient = new SQL(ADMIN_URL);
    try {
      await sqlClient.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`
          INSERT INTO pages (slug, locale, name, title, template_id, status, translation_status)
          SELECT 'enum-test', 'en', 'X', 'X',
                 (SELECT id FROM templates LIMIT 1), 'draft', 'up_to_date'
        `;
      });
      // Cleanup: delete the test row.
      await sqlClient.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`DELETE FROM pages WHERE slug = 'enum-test' AND locale = 'en'`;
      });
      // Verify the legacy value is rejected.
      let rejected = false;
      try {
        await sqlClient.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          await tx`
            INSERT INTO pages (slug, locale, name, title, template_id, status, translation_status)
            SELECT 'enum-test-bad', 'en', 'X', 'X',
                   (SELECT id FROM templates LIMIT 1), 'draft', 'fresh'
          `;
        });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    } finally {
      await sqlClient.end();
    }
  });
});
