// SPDX-License-Identifier: MPL-2.0

/**
 * #1454 — the site's response-header policy against a real Postgres: the
 * stored default, what the AI may read and propose, the Owner's apply, and
 * what each environment is recorded to send.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import {
  composeSiteHeaders,
  DEFAULT_SITE_SECURITY_POLICY,
  EMPTY_CSP_FACTS,
  type ExecutionContext,
  type SiteSecurityPolicy,
} from "@caelo-cms/shared";
import { SQL } from "bun";
import { securityHeadersOutput } from "../ops/security_headers.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

/** Rows the ops do not write, under the RLS context a system actor has. */
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

const OWNER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000014e1",
  actorKind: "human",
  requestId: "security-headers-test-owner",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000014e2",
  actorKind: "ai",
  requestId: "security-headers-test-ai",
};

function value<T>(r: { ok: boolean; value?: unknown; error?: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value as T;
}

const get = async () =>
  securityHeadersOutput.parse(
    value(await execute(registry, adapter, AI, "security_headers.get", {})),
  );

const resetPolicy = () =>
  asSystem(async (tx) => {
    await tx`UPDATE site_settings SET security_headers = ${JSON.stringify(DEFAULT_SITE_SECURITY_POLICY)}::text::jsonb WHERE id = 1`;
    await tx`DELETE FROM owner_settings_pending_actions WHERE kind = 'set_security_headers'`;
  });

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await asSystem(
    (tx) => tx`
      INSERT INTO actors (id, kind, display_name) VALUES
        (${OWNER.actorId}, 'human', 'Security Owner'),
        (${AI.actorId}, 'ai', 'Security AI')
      ON CONFLICT (id) DO NOTHING
    `,
  );
  await asSystem(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER.actorId}::uuid, ${`${OWNER.actorId}@security-headers.test`}, 'test-only') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER.actorId}::uuid, id FROM roles WHERE name = 'owner' ON CONFLICT DO NOTHING`;
  });
});

afterAll(async () => {
  await resetPolicy();
  await adapter.close();
});

beforeEach(resetPolicy);

describe("security_headers", () => {
  it("every install has the report-only default, open for the AI to read", async () => {
    const state = await get();
    expect(state.policy).toEqual(DEFAULT_SITE_SECURITY_POLICY);
    expect(state.host.served).toBe(true);
  });

  it("the AI cannot write the policy", async () => {
    const r = await execute(registry, adapter, AI, "security_headers.set", {
      ...DEFAULT_SITE_SECURITY_POLICY,
      cspMode: "enforce",
    });
    expect(r.ok).toBe(false);
    expect((await get()).policy.cspMode).toBe("report_only");
  });

  it("a proposal changes nothing until the Owner approves; then only the named settings", async () => {
    const proposed = value<{
      proposalId: string;
      preview: { changes: Record<string, unknown>; headersAfter: Record<string, string> };
    }>(
      await execute(registry, adapter, AI, "owner_settings.propose_set_security_headers", {
        frameAncestors: ["https://partner.example.com"],
      }),
    );
    expect(Object.keys(proposed.preview.changes)).toEqual(["frameAncestors"]);
    expect(proposed.preview.headersAfter["Content-Security-Policy"]).toContain(
      "frame-ancestors 'self' https://partner.example.com",
    );
    expect((await get()).policy.frameAncestors).toEqual([]);

    const denied = await execute(registry, adapter, AI, "owner_settings.execute_proposal", {
      proposalId: proposed.proposalId,
    });
    expect(denied.ok).toBe(false);

    // An Owner edit between proposal and approval is not reverted by it.
    const edited: SiteSecurityPolicy = {
      ...DEFAULT_SITE_SECURITY_POLICY,
      referrerPolicy: "no-referrer",
    };
    value(await execute(registry, adapter, OWNER, "security_headers.set", edited));

    const applied = value<{ nextStep?: string }>(
      await execute(registry, adapter, OWNER, "owner_settings.execute_proposal", {
        proposalId: proposed.proposalId,
      }),
    );
    expect(applied.nextStep).toContain("Publish live");
    const { policy } = await get();
    expect(policy.frameAncestors).toEqual(["https://partner.example.com"]);
    expect(policy.referrerPolicy).toBe("no-referrer");
  });

  it("the approval card shows each changed header before and after", async () => {
    const { preview } = value<{ preview: string }>(
      await execute(registry, adapter, AI, "security_headers.preview_set", {
        cspMode: "enforce",
      }),
    );
    expect(preview).toContain("CSP report_only → enforce");
    expect(preview).toContain("Content-Security-Policy-Report-Only");
    expect(preview).toContain("(not sent)");
  });

  it("refuses a keyword as an origin and a change that changes nothing", async () => {
    const keyword = await execute(
      registry,
      adapter,
      AI,
      "owner_settings.propose_set_security_headers",
      { extraSources: { script: ["'unsafe-inline'"] } },
    );
    expect(keyword.ok).toBe(false);
    const noop = await execute(
      registry,
      adapter,
      AI,
      "owner_settings.propose_set_security_headers",
      { cspMode: "report_only" },
    );
    expect(noop.ok).toBe(false);
    expect(JSON.stringify(noop)).toContain("get_security_headers");
  });

  it("refuses on a host that cannot serve the headers, saying why", async () => {
    const before = process.env.CAELO_PROVIDER;
    process.env.CAELO_PROVIDER = "aws";
    try {
      const r = await execute(
        registry,
        adapter,
        AI,
        "owner_settings.propose_set_security_headers",
        { cspMode: "enforce" },
      );
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).toContain("#749");
    } finally {
      if (before === undefined) delete process.env.CAELO_PROVIDER;
      else process.env.CAELO_PROVIDER = before;
    }
  });

  it("reads what staging and the live site serve from their runs, a promote by its build_id", async () => {
    const set = composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, {
      ...EMPTY_CSP_FACTS,
      origins: { frame: ["https://www.youtube-nocookie.com"] },
      blockers: [{ kind: "inline-handler", detail: "onclick", pages: ["/a"], pageCount: 1 }],
    });
    const targets = (await asSystem(
      (tx) => tx`SELECT id, env FROM deploy_targets WHERE env IN ('staging', 'production')`,
    )) as { id: string; env: string }[];
    const staging = targets.find((t) => t.env === "staging");
    const production = targets.find((t) => t.env === "production");
    if (!staging || !production) throw new Error("the seed has both targets");
    const stageId = crypto.randomUUID();
    const promoteId = crypto.randomUUID();
    await asSystem(async (tx) => {
      await tx`
        INSERT INTO deploy_runs (id, target_id, actor_id, status, started_at, finished_at, build_id, security_headers)
        VALUES (${stageId}, ${staging.id}, ${OWNER.actorId}, 'succeeded', now(), now(), ${stageId},
                ${JSON.stringify(set)}::text::jsonb)
      `;
      await tx`
        INSERT INTO deploy_runs (id, target_id, actor_id, status, started_at, finished_at, build_id)
        VALUES (${promoteId}, ${production.id}, ${OWNER.actorId}, 'succeeded', now(), now(), ${stageId})
      `;
    });
    try {
      const state = await get();
      expect(state.staged?.headers).toEqual(set.headers);
      expect(state.live?.headers).toEqual(set.headers);
      expect(state.stageNeeded).toBe(false);
      expect(state.derivedOrigins.frame).toEqual(["https://www.youtube-nocookie.com"]);
      expect(state.enforceBlockers[0]).toContain("onclick");

      value(
        await execute(registry, adapter, OWNER, "security_headers.set", {
          ...DEFAULT_SITE_SECURITY_POLICY,
          cspMode: "enforce",
        }),
      );
      expect((await get()).stageNeeded).toBe(true);
      const { preview } = value<{ preview: string }>(
        await execute(registry, adapter, AI, "security_headers.preview_set", {
          referrerPolicy: "no-referrer",
        }),
      );
      expect(preview).toContain("Would stop working: inline-handler onclick");
    } finally {
      await asSystem((tx) => tx`DELETE FROM deploy_runs WHERE id IN (${promoteId}, ${stageId})`);
    }
  });
});
