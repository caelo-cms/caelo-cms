// SPDX-License-Identifier: MPL-2.0

/**
 * #1591 — Settings → Deployments → Promote answered every refusal with a
 * bare "Promote staging → production failed." (HTTP 500), so an Owner could
 * not tell an empty staging from a closed quality gate. Against a real
 * Postgres, the action now answers a refusal with 409 and its reason:
 *
 *  - before the first Stage: "no succeeded build to promote from 'staging'
 *    — run Stage first";
 *  - a staged build the quality gate keeps closed: the gate's reason, for
 *    the never-audited (`missing`) and the cannot-render (`render`, #1608)
 *    states alike.
 *
 * The carried build answers the first refusals ahead of the op
 * (build-carrier/preflight.ts); `deploy.promote` itself, which an approved
 * proposal runs, marks the same refusals as refusals too.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { signCsrfToken } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { publishLiveFailureText } from "#lib/server/publish-live-failure.js";
import { getQueryContext } from "#lib/server/query.js";
import { actions } from "./+page.server.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const OPERATOR_ID = "00000000-0000-4000-8000-000000001591";
const ctx: ExecutionContext = {
  actorId: OPERATOR_ID,
  actorKind: "human",
  requestId: "promote-refusal-1591",
};
const CSRF_SECRET = "promote-refusal-1591-secret";

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

const promote = actions.promote;
if (!promote) throw new Error("Settings → Deployments has no promote action");

/** Post the Promote form as the signed-in operator, as the page does. */
async function postPromote(fromTarget: string, toTarget: string): Promise<unknown> {
  const body = new FormData();
  body.set("_csrf", await signCsrfToken(CSRF_SECRET));
  body.set("fromTarget", fromTarget);
  body.set("toTarget", toTarget);
  const event = {
    request: new Request("https://admin.example.test/settings/deployments?/promote", {
      method: "POST",
      body,
    }),
    locals: {
      ctx,
      user: {
        id: OPERATOR_ID,
        email: "promote-refusal@example.test",
        roles: ["owner"],
        permissions: new Set(["deploy.trigger", "ops.view"]),
        csrfSecret: CSRF_SECRET,
        onboardedAt: null,
      },
    },
    url: new URL("https://admin.example.test/settings/deployments"),
  };
  return promote?.(event as unknown as Parameters<NonNullable<typeof promote>>[0]);
}

/** What `fail()` returned (an ActionFailure: status + data). */
function failureOf(answer: unknown): { status: number; error: string } {
  const a = answer as { status?: number; data?: { error?: string } };
  if (typeof a?.status !== "number" || typeof a.data?.error !== "string") {
    throw new Error(`expected a failed action, got ${JSON.stringify(answer)}`);
  }
  return { status: a.status, error: a.data.error };
}

let stagedRunId: string | null = null;

/** A succeeded Stage of the staging target, as a finished build records it. */
async function seedStagedRun(renderReport: unknown = null): Promise<void> {
  await asSystem(async (tx) => {
    const rows = (await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id, render_report)
      SELECT id, ${OPERATOR_ID}::uuid, 'succeeded', now(), now(), ${`build-1591-${crypto.randomUUID()}`},
             ${renderReport === null ? null : JSON.stringify(renderReport)}::text::jsonb
      FROM deploy_targets WHERE name = 'staging'
      RETURNING id::text AS id
    `) as unknown as { id: string }[];
    stagedRunId = rows[0]?.id ?? null;
  });
}

async function dropStagedRun(): Promise<void> {
  if (stagedRunId === null) return;
  const id = stagedRunId;
  stagedRunId = null;
  await asSystem((tx) => tx`DELETE FROM deploy_runs WHERE id = ${id}::uuid`);
}

let savedBaseUrl: string | null = null;

beforeAll(async () => {
  await asSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name)
             VALUES (${OPERATOR_ID}::uuid, 'human', 'promote-refusal operator')
             ON CONFLICT (id) DO NOTHING`;
    // Each case starts from "nothing staged yet".
    await tx`DELETE FROM deploy_runs WHERE target_id IN (SELECT id FROM deploy_targets WHERE name = 'staging')`;
    // Publish live reads the live host before its gates (a seeded row; restored after).
    const rows = (await tx`SELECT site_base_url FROM site_defaults WHERE id = 1`) as unknown as {
      site_base_url: string | null;
    }[];
    savedBaseUrl = rows[0]?.site_base_url ?? null;
    await tx`UPDATE site_defaults SET site_base_url = 'https://promote-refusal.example' WHERE id = 1`;
  });
});

afterAll(async () => {
  await dropStagedRun();
  await asSystem((tx) => tx`UPDATE site_defaults SET site_base_url = ${savedBaseUrl} WHERE id = 1`);
});

describe("Settings → Deployments → Promote shows why it was refused (#1591)", () => {
  it("before the first Stage: 409 with 'run Stage first'", async () => {
    const { status, error } = failureOf(await postPromote("staging", "production"));
    expect(status).toBe(409);
    expect(error).toStartWith("Promote staging → production refused: ");
    expect(error).toContain("no succeeded build to promote from 'staging' — run Stage first");
  });

  it("a staged build that was never quality-checked: 409 with the gate's reason", async () => {
    await seedStagedRun();
    try {
      const { status, error } = failureOf(await postPromote("staging", "production"));
      expect(status).toBe(409);
      expect(error).toStartWith("Promote staging → production refused: ");
      expect(error).toContain(
        "Publish live is blocked: the staged build has not been quality-checked",
      );
    } finally {
      await dropStagedRun();
    }
  });

  it("a staged build with content it could not render (#1608): 409 with that reason", async () => {
    await seedStagedRun({
      total: 1,
      failures: [
        {
          pageId: "00000000-0000-4000-8000-0000000015a1",
          pageTitle: "Pricing",
          pagePath: "/pricing",
          blockName: "hero",
          moduleSlug: "hero",
          field: null,
          reason: "module-missing:hero",
          target: null,
          line: "module-missing:hero on /pricing",
        },
      ],
      operatorText: "The hero of Pricing (/pricing) could not be rendered.",
      aiText: "module-missing:hero on /pricing",
    });
    try {
      const { status, error } = failureOf(await postPromote("staging", "production"));
      expect(status).toBe(409);
      expect(error).toContain(
        "Publish live is blocked: the staged build has 1 spot it could not render",
      );
      expect(error).toContain("the hero of Pricing (/pricing) could not be rendered");
    } finally {
      await dropStagedRun();
    }
  });

  it("deploy.promote itself marks the same answers as refusals (an approved proposal runs it)", async () => {
    const { registry, adapter } = getQueryContext();
    const empty = await execute(registry, adapter, ctx, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error).toMatchObject({ kind: "HandlerError", refusal: true });
    expect(publishLiveFailureText("Publish live", empty.error)).toMatchObject({ status: 409 });

    // The quality gate (a staging build, published to a target the
    // production-only checks do not apply to).
    await seedStagedRun();
    try {
      const gated = await execute(registry, adapter, ctx, "deploy.promote", {
        fromTarget: "staging",
        toTarget: "dev",
      });
      expect(gated.ok).toBe(false);
      if (gated.ok) return;
      expect(gated.error).toMatchObject({ kind: "HandlerError", refusal: true });
      expect((gated.error as { message: string }).message).toContain(
        "the staged build has not been quality-checked",
      );
    } finally {
      await dropStagedRun();
    }
  });
});
