// SPDX-License-Identifier: MPL-2.0

/**
 * Visitor-facing dispatch: default deny, and the declared contract of each
 * public operation (#1332).
 *
 * Until default deny landed, every operation a plugin declared was
 * reachable by anyone through `POST /api/plugin/<slug>/<op>` — with the
 * plugin's full granted capabilities. Since #1332 a public operation is a
 * declared object, and dispatch enforces it before the handler runs: the
 * captcha it requires, its input schema, and the tables `ctx.query` may
 * touch. What a visitor reads of a failure is only what the handler worded
 * for them.
 *
 * The checks live in `runPluginOperation` rather than at the gateway
 * route, so these tests exercise the invariant itself: a visitor context
 * cannot get past them regardless of which entry point supplies it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import {
  definePlugin,
  type PublicOperationDef,
  PublicOperationError,
  z,
} from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import fc from "fast-check";
import { bootstrap, type PluginHostInfra, resetPluginHost, runPluginOperation } from "./index.js";
import { GENERIC_VISITOR_FAILURE } from "./public-contract.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "test-public-ops";

/** A visitor whose request carried a verified proof bound to the operation. */
const VISITOR = {
  visitorId: "v-1",
  sessionToken: null,
  captcha: { enforced: true, proofVerified: true },
};
const NO_PROOF = { ...VISITOR, captcha: { enforced: true, proofVerified: false } };

let adapter: DatabaseAdapter;
let infra: PluginHostInfra;

async function wipe(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (
          SELECT id FROM plugins WHERE slug LIKE 'test-public-ops%'
        )
      )`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 'test-public-ops%')`;
      await tx`DELETE FROM plugins WHERE slug LIKE 'test-public-ops%'`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry };
});

afterEach(async () => {
  await wipe();
});

afterAll(async () => {
  await adapter.close();
});

const noteInput = z.object({ text: z.string().min(1).max(100), stars: z.number().int() }).strict();

/** What the handlers received, to prove what never reached them. */
const received: unknown[] = [];

async function load(publicOperations?: PublicOperationDef[]): Promise<void> {
  received.length = 0;
  const def = definePlugin({
    slug: SLUG,
    version: "0.1.0",
    tier: 1,
    schema: {
      notes: { text: "string", stars: "int" },
      secrets: { value: "string" },
    },
    tableKinds: { notes: "visitor-state", secrets: "visitor-state" },
    ...(publicOperations ? { publicOperations } : {}),
    operations: {
      submit: async (_ctx, args) => {
        received.push(args);
        // A handler that trusts its typed input, as handlers do.
        const a = args as { text: string; stars: number };
        return { length: a.text.length, stars: a.stars.toFixed(0) };
      },
      moderate: async () => ({ moderated: true }),
      // A handler bug: it reads a field its (empty) input never has, and the
      // runtime's TypeError text must not reach the visitor.
      crash: async (_ctx, args) => {
        const { missing } = args as { missing: { length: number } };
        return { length: missing.length };
      },
      refuse: async () => {
        throw new PublicOperationError("this form is closed");
      },
      peek: async (ctx) => ({ rows: await ctx.query.list("secrets", { limit: 1 }) }),
    },
  });
  const report = await bootstrap({
    infra,
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: def }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
}

const SUBMIT: PublicOperationDef = {
  name: "submit",
  kind: "write",
  input: noteInput,
  writes: ["notes"],
};
const open = (name: string, extra: Partial<PublicOperationDef> = {}): PublicOperationDef => ({
  name,
  kind: "write",
  captcha: "none",
  input: z.object({}).strict(),
  ...extra,
});

function call(operationName: string, args: unknown, visitorContext = VISITOR) {
  return runPluginOperation({
    invocation: { origin: "visitor", actorId: "visitor" },
    pluginSlug: SLUG,
    operationName,
    args,
    visitorContext,
  });
}

describe("visitor-facing dispatch", () => {
  it("allows a declared public operation", async () => {
    await load([SUBMIT]);
    const r = await call("submit", { text: "hi", stars: 4 });
    expect(r).toEqual({ ok: true, value: { length: 2, stars: "4" } });
  });

  it("refuses an operation that is not declared public", async () => {
    await load([SUBMIT]);
    const r = await call("moderate", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("OperationNotPublic");
  });

  it("refuses everything when the plugin declares no public surface", async () => {
    // The default matters more than the allowlist: a plugin author who
    // never thinks about the gateway exposes nothing.
    await load();
    for (const operationName of ["submit", "moderate"]) {
      const r = await call(operationName, {});
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("OperationNotPublic");
    }
  });

  it("leaves internal dispatch untouched", async () => {
    // Workers, the chat-runner and the render passes all dispatch
    // without a visitor; gating them would break every plugin.
    await load([SUBMIT]);
    const r = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: SLUG,
      operationName: "moderate",
      args: {},
    });
    expect(r.ok).toBe(true);
  });

  it("refuses to load a plugin whose public list names a missing operation", async () => {
    // A typo here silently 404s the visitor surface, or advertises one
    // that does not exist. Both are caught at load.
    const def = definePlugin({
      slug: `${SLUG}-typo`,
      version: "0.1.0",
      tier: 1,
      schema: {},
      publicOperations: [open("submitt")],
      operations: { submit: async () => ({}) },
    });
    const report = await bootstrap({
      infra,
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: def }],
    });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.reason).toContain("publicOperations");
  });
});

describe("the declared captcha (#1332, E4)", () => {
  it("refuses a write without a verified proof before the handler runs", async () => {
    await load([SUBMIT]);
    const r = await call("submit", { text: "hi", stars: 4 }, NO_PROOF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("CaptchaRequired");
    expect(received).toHaveLength(0);
  });

  it("lets an operation declared captcha none through on its rate limit alone", async () => {
    await load([{ ...SUBMIT, captcha: "none" }]);
    expect((await call("submit", { text: "hi", stars: 4 }, NO_PROOF)).ok).toBe(true);
  });

  it("follows the Owner's site-wide off switch", async () => {
    await load([SUBMIT]);
    const off = { ...VISITOR, captcha: { enforced: false, proofVerified: false } };
    expect((await call("submit", { text: "hi", stars: 4 }, off)).ok).toBe(true);
  });
});

describe("the declared input (#1332, M3)", () => {
  it("refuses a body of the wrong shape before the handler runs", async () => {
    await load([SUBMIT]);
    for (const body of [{ text: 7, stars: 1 }, { text: "x" }, { text: "x", stars: 1, extra: 1 }]) {
      const r = await call("submit", body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("InvalidInput");
    }
    expect(received).toHaveLength(0);
  });

  it("removes the gateway's proof field before validating", async () => {
    await load([SUBMIT]);
    const r = await call("submit", {
      text: "hi",
      stars: 2,
      _caelo_captcha: { challenge: "c", nonce: "n" },
    });
    expect(r.ok).toBe(true);
    expect(received).toEqual([{ text: "hi", stars: 2 }]);
  });

  it("never hands a handler a value its schema refuses (fuzz)", async () => {
    await load([SUBMIT]);
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.anything(), fc.object(), fc.jsonValue()), async (body) => {
        received.length = 0;
        const r = await call("submit", body);
        for (const args of received) expect(noteInput.safeParse(args).success).toBe(true);
        if (!r.ok) {
          expect(["InvalidInput"]).toContain(r.error.kind);
          expect(r.error.message).not.toMatch(/TypeError|undefined is not|Cannot read/);
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe("what a visitor reads of a failure (#1332, M3)", () => {
  it("answers a crashing handler generically, never with its TypeError", async () => {
    await load([open("crash")]);
    const r = await call("crash", {});
    expect(r).toEqual({
      ok: false,
      error: { kind: "OperationFailed", message: GENERIC_VISITOR_FAILURE },
    });
  });

  it("passes a refusal the handler worded for the visitor", async () => {
    await load([open("refuse")]);
    const r = await call("refuse", {});
    expect(r).toEqual({ ok: false, error: { kind: "Rejected", message: "this form is closed" } });
  });
});

describe("the declared table access (#1332)", () => {
  it("refuses a read of a table the operation does not declare", async () => {
    await load([open("peek", { kind: "read" })]);
    const r = await call("peek", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("OperationFailed");
  });

  it("serves a read of a declared table", async () => {
    await load([open("peek", { kind: "read", reads: ["secrets"] })]);
    expect((await call("peek", {})).ok).toBe(true);
  });
});
