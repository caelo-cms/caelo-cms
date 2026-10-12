// SPDX-License-Identifier: MPL-2.0

/**
 * The agent's view of Firebase Hosting custom domains: list_domains and
 * verify_domains append the live state from `domains.hosting_status`, a
 * stuck domain names `propose_reconnect_domain`, and that tool is
 * approval-gated through domains.propose_reconnect → domains.execute_proposal.
 * Stub ops, same harness shape as agent-parity-tools.test.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  type DatabaseAdapter,
  defineOperation,
  type OperationDefinition,
  OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { z } from "zod";
import type { CustomDomainHealth } from "../../../deploy/firebase-custom-domain-health.js";
import type { ToolContext } from "../dispatch.js";
import { verifyDomainsTool } from "../dns-verification.js";
import { formatHostingStatus } from "../domain-hosting-status.js";
import { createDefaultToolRegistry } from "../index.js";
import { proposeDomainReconnectTool } from "../propose-tools-batch.js";
import { listDomainsTool } from "../state-read-tools.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "domain-hosting-status-test",
};

function harness(stubs: Record<string, () => unknown>): ToolContext {
  const registry = new OperationRegistry();
  for (const [name, fn] of Object.entries(stubs)) {
    registry.register(
      defineOperation({
        name,
        actorScope: ["human", "ai", "system"],
        database: "cms_admin",
        input: z.any(),
        output: z.any(),
        handler: async () => ok(fn()) as never,
      }),
    );
  }
  const adapter = {
    runOperation: (op: OperationDefinition, ctx: ExecutionContext, input: unknown) =>
      op.handler(ctx, input, {} as never),
  } as unknown as DatabaseAdapter;
  return { adapter, registry };
}

const STUCK: CustomDomainHealth = {
  hostname: "example.com",
  status: "stuck",
  hostState: "HOST_MISMATCH",
  ownershipState: "OWNERSHIP_PENDING",
  certState: "CERT_ACTIVE",
  dnsChanges: [],
  checkTime: "2026-10-10T14:56:00Z",
  updateTime: "2026-09-29T09:00:00Z",
  summary: "stuck — reconnect recommended: every DNS record is in place …",
};
const ACTIVE: CustomDomainHealth = {
  ...STUCK,
  hostname: "www.example.com",
  status: "active",
  summary: "active — Firebase serves the site on www.example.com (certificate CERT_ACTIVE).",
};

const hosting = (domains: CustomDomainHealth[], extra: Record<string, unknown> = {}) => ({
  supported: true,
  domains,
  cdnPurge: null,
  error: null,
  ...extra,
});

describe("formatHostingStatus", () => {
  it("renders nothing on providers without hosting custom domains", () => {
    expect(
      formatHostingStatus({ supported: false, domains: [], cdnPurge: null, error: null }),
    ).toBe("");
  });

  it("points a stuck domain at propose_reconnect_domain", () => {
    const text = formatHostingStatus(hosting([STUCK, ACTIVE]));
    expect(text).toContain("example.com: stuck — reconnect recommended");
    expect(text).toContain('propose_reconnect_domain {"hostname":"example.com"}');
    expect(text).toContain("www.example.com: active");
    expect(text.match(/propose_reconnect_domain/g)).toHaveLength(1);
  });

  it("reports a CDN purge and a status failure", () => {
    expect(
      formatHostingStatus(
        hosting([ACTIVE], {
          cdnPurge: { versionName: "sites/s/versions/v", hostnames: ["www.example.com"] },
        }),
      ),
    ).toContain("CDN cache cleared: www.example.com");
    expect(formatHostingStatus(hosting([], { error: "403 Forbidden" }))).toContain(
      "Status unavailable: 403 Forbidden",
    );
  });
});

describe("list_domains / verify_domains carry the hosting state", () => {
  it("list_domains appends it even when the domains table is empty", async () => {
    const toolCtx = harness({
      "domains.list": () => ({ domains: [] }),
      "domains.hosting_status": () => hosting([STUCK]),
    });
    const r = await listDomainsTool.handler(AI, {}, toolCtx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("No domains configured.");
    expect(r.content).toContain("example.com: stuck");
  });

  it("list_domains is unchanged on other providers", async () => {
    const toolCtx = harness({
      "domains.list": () => ({ domains: [] }),
      "domains.hosting_status": () => ({
        supported: false,
        domains: [],
        cdnPurge: null,
        error: null,
      }),
    });
    const r = await listDomainsTool.handler(AI, {}, toolCtx);
    expect(r.content).not.toContain("Firebase");
  });

  it("verify_domains reports the hosting state instead of 'nothing to verify'", async () => {
    const toolCtx = harness({
      "domains.list": () => ({ domains: [] }),
      "domains.hosting_status": () => hosting([STUCK]),
    });
    const r = await verifyDomainsTool.handler(AI, {}, toolCtx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("propose_reconnect_domain");
  });
});

describe("propose_reconnect_domain", () => {
  it("is approval-gated through the domains propose/execute pair", () => {
    expect(proposeDomainReconnectTool.approvalMode).toBe("user-approval");
    expect(proposeDomainReconnectTool.gated).toEqual({
      proposeOp: "domains.propose_reconnect",
      executeOp: "domains.execute_proposal",
      pendingQueuePath: "/security/domains/pending",
    });
    expect(proposeDomainReconnectTool.schema.safeParse({ hostname: "example.com" }).success).toBe(
      true,
    );
  });

  it("is registered in the default tool registry", () => {
    const names = createDefaultToolRegistry()
      .catalogue()
      .map((t) => t.name);
    expect(names).toContain("propose_reconnect_domain");
  });
});
