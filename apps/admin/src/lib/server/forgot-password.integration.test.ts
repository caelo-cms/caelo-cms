// SPDX-License-Identifier: MPL-2.0

/**
 * #769 — `/forgot` against a real Postgres.
 *
 *  - The action, posted while the install cannot send mail, answers 409 and
 *    writes no reset token (a form posted before the page knew, or a script).
 *  - When the mail config stops being able to deliver between the up-front
 *    check and the send, a known address gets the same answer as an unknown
 *    one — not a 500 — and the log line carries neither the link nor the
 *    token.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { actions } from "../../routes/(auth)/forgot/+page.server.js";
import { requestPasswordResetLink } from "./forgot-password.js";
import { getQueryContext } from "./query.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "forgot-route-test",
};

const KNOWN = "forgot-route-known@example.test";
const UNKNOWN = "forgot-route-nobody@example.test";
let knownUserId = "";
let savedEmailConfig: { transport: string; fromAddress: string; config: Record<string, unknown> };

async function tokenCount(userId: string): Promise<number> {
  const sql = new SQL(ADMIN_URL!);
  try {
    let n = 0;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows =
        (await tx`SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = ${userId}::uuid`) as unknown as {
          n: number;
        }[];
      n = rows[0]?.n ?? 0;
    });
    return n;
  } finally {
    await sql.end();
  }
}

async function setEmailConfig(cfg: typeof savedEmailConfig): Promise<void> {
  const { registry, adapter } = getQueryContext();
  const r = await execute(registry, adapter, systemCtx, "email_config.set", cfg);
  if (!r.ok) throw new Error(`email_config.set: ${JSON.stringify(r.error)}`);
}

/** Post the form the way SvelteKit hands it to the action. */
async function postForgot(email: string, clientAddress: string): Promise<unknown> {
  const body = new FormData();
  body.set("email", email);
  const request = new Request("http://admin.test/forgot", { method: "POST", body });
  const event = {
    request,
    locals: { ctx: systemCtx },
    url: new URL("http://admin.test/forgot"),
    getClientAddress: () => clientAddress,
  };
  const action = actions.default;
  if (!action) throw new Error("/forgot has no default action");
  return action(event as unknown as Parameters<typeof action>[0]);
}

beforeAll(async () => {
  const { registry, adapter } = getQueryContext();
  const got = await execute(registry, adapter, systemCtx, "email_config.get", {});
  if (!got.ok) throw new Error(`email_config.get: ${JSON.stringify(got.error)}`);
  const c = (got.value as { config: typeof savedEmailConfig }).config;
  savedEmailConfig = { transport: c.transport, fromAddress: c.fromAddress, config: c.config };
  await setEmailConfig({ transport: "none", fromAddress: "", config: {} });

  const created = await execute(registry, adapter, systemCtx, "users.create", {
    email: KNOWN,
    password: "purple-hatstand-92",
    displayName: "Forgot Route Known",
    roleNames: [],
  });
  if (!created.ok) throw new Error(`users.create: ${JSON.stringify(created.error)}`);
  knownUserId = (created.value as { userId: string }).userId;
});

afterAll(async () => {
  await setEmailConfig(savedEmailConfig);
  await getQueryContext().adapter.close();
});

describe("/forgot action", () => {
  it("answers 409 and issues no token when the install cannot send mail", async () => {
    const res = (await postForgot(KNOWN, "198.51.100.1")) as {
      status: number;
      data: { emailUnavailable?: boolean };
    };
    expect(res.status).toBe(409);
    expect(res.data.emailUnavailable).toBe(true);
    expect(await tokenCount(knownUserId)).toBe(0);
  });

  it("answers an unknown address the same way (409, not a hint about the account)", async () => {
    const res = (await postForgot(UNKNOWN, "198.51.100.2")) as { status: number };
    expect(res.status).toBe(409);
  });
});

describe("requestPasswordResetLink when delivery fails after the check", () => {
  it("answers a known address exactly like an unknown one and logs no credential", async () => {
    const { registry, adapter } = getQueryContext();
    // The check passed (mail looked deliverable), then the config can no
    // longer deliver: the real deliver reads transport `none` and throws.
    const deps = {
      registry,
      adapter,
      ctx: systemCtx,
      origin: "http://admin.test",
      emailProblem: async () => null,
    };
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const known = await requestPasswordResetLink(deps, KNOWN);
      const unknown = await requestPasswordResetLink(deps, UNKNOWN);
      expect(known).toEqual({ kind: "sent" });
      expect(unknown).toEqual(known);

      // The known address did get a token; delivery is what failed.
      expect(await tokenCount(knownUserId)).toBe(1);
      const logged = errors.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      expect(logged).toContain("[password-reset]");
      expect(logged).not.toContain("/reset?token=");
      expect(logged).not.toContain(KNOWN);
    } finally {
      errors.mockRestore();
    }
  });

  it("does the same when the delivery step throws for any other reason", async () => {
    const { registry, adapter } = getQueryContext();
    let leaked = "";
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await requestPasswordResetLink(
        {
          registry,
          adapter,
          ctx: systemCtx,
          origin: "http://admin.test",
          emailProblem: async () => null,
          deliver: async ({ resetUrl }) => {
            leaked = resetUrl;
            throw new Error(`transport echoed ${resetUrl}`);
          },
        },
        KNOWN,
      );
      expect(out).toEqual({ kind: "sent" });
      const token = new URL(leaked).searchParams.get("token") ?? "";
      expect(token.length).toBeGreaterThan(0);
      const logged = errors.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      expect(logged).toContain("[reset link]");
      expect(logged).not.toContain(token);
    } finally {
      errors.mockRestore();
    }
  });
});
