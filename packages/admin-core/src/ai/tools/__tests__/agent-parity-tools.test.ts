// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the agent-tool-parity tools: Zod schema at the tool
 * boundary + handler logic (target selection, op inputs, result copy,
 * gating), against STUB ops. The ops' own behaviour against Postgres is
 * pinned in `src/__tests__/agent-parity-tools.integration.test.ts`.
 *
 * The stub adapter runs the registered stub handler directly — `execute`
 * still does the real lookup, actorScope check and input validation, so a
 * tool that sends an op an input it would reject fails here too.
 */

import { describe, expect, it } from "bun:test";
import {
  type DatabaseAdapter,
  defineOperation,
  type OperationDefinition,
  OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { z } from "zod";

import { setMediaStorage } from "../../../media/storage.js";
import { deleteMediaManyTool } from "../delete-media-many.js";
import { deleteModulesManyTool } from "../delete-modules-many.js";
import { deployStagingTool } from "../deploy-staging.js";
import { type ToolContext, ToolRegistry, type ToolResult } from "../dispatch.js";
import { verifyDnsRecordsTool, verifyDomainsTool } from "../dns-verification.js";
import {
  createExperimentTool,
  getExperimentResultsTool,
  listExperimentsTool,
} from "../experiments.js";
import { acceptImportPagesTool, cleanupImportRunTool } from "../import-run-actions.js";
import { sendTestEmailTool } from "../send-test-email.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "agent-parity-tools-test",
};
const OWNER: ExecutionContext = { ...AI, actorKind: "human" };

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";

type Call = { op: string; input: unknown; ctx: ExecutionContext };

/** A registry of stub ops + a stub adapter that runs their handlers directly. */
function harness(
  stubs: Record<string, (input: never, ctx: ExecutionContext) => unknown>,
  scopes: Record<string, readonly ("human" | "ai" | "system")[]> = {},
) {
  const calls: Call[] = [];
  const registry = new OperationRegistry();
  for (const [name, fn] of Object.entries(stubs)) {
    registry.register(
      defineOperation({
        name,
        actorScope: scopes[name] ?? ["human", "ai", "system"],
        database: "cms_admin",
        input: z.any(),
        output: z.any(),
        handler: async (ctx, input) => {
          calls.push({ op: name, input, ctx });
          const r = fn(input as never, ctx);
          return (r && typeof r === "object" && "ok" in r ? r : ok(r)) as never;
        },
      }),
    );
  }
  const adapter = {
    runOperation: (op: OperationDefinition, ctx: ExecutionContext, input: unknown) =>
      op.handler(ctx, input, {} as never),
  } as unknown as DatabaseAdapter;
  const toolCtx: ToolContext = { adapter, registry };
  return { calls, toolCtx };
}

async function run(
  tool: Parameters<ToolRegistry["register"]>[0],
  args: unknown,
  toolCtx: ToolContext,
  ctx: ExecutionContext = AI,
): Promise<ToolResult> {
  const reg = new ToolRegistry();
  reg.register(tool);
  return reg.dispatch(tool.name, args, ctx, toolCtx);
}

const TARGETS = {
  targets: [
    { name: "dev", env: "dev" },
    { name: "staging", env: "staging" },
    { name: "production", env: "production" },
  ],
};
const TRIGGERED = {
  runId: U1,
  targetName: "staging",
  pageCount: 4,
  fileCount: 9,
  durationMs: 2100,
  buildId: U1,
};

describe("deploy_staging", () => {
  it("rebuilds the single staging target without the model naming it", async () => {
    const h = harness({ "deploy.list_targets": () => TARGETS, "deploy.trigger": () => TRIGGERED });
    const r = await run(deployStagingTool, {}, h.toolCtx);
    expect(r.ok).toBe(true);
    expect(h.calls.find((c) => c.op === "deploy.trigger")?.input).toEqual({
      targetName: "staging",
    });
    expect(r.content).toContain("Only published content is included");
  });

  it("refuses a production target before any deploy.trigger call", async () => {
    const h = harness({ "deploy.list_targets": () => TARGETS, "deploy.trigger": () => TRIGGERED });
    const r = await run(deployStagingTool, { targetName: "production" }, h.toolCtx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("propose_deploy_promote");
    expect(h.calls.some((c) => c.op === "deploy.trigger")).toBe(false);
  });

  it("asks for a name when several staging targets exist, and fails loud when none do", async () => {
    const two = {
      targets: [
        { name: "staging-a", env: "staging" },
        { name: "staging-b", env: "staging" },
      ],
    };
    const h = harness({ "deploy.list_targets": () => two, "deploy.trigger": () => TRIGGERED });
    const r = await run(deployStagingTool, {}, h.toolCtx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("staging-a, staging-b");
    const none = harness({ "deploy.list_targets": () => ({ targets: [] }) });
    const r2 = await run(deployStagingTool, {}, none.toolCtx);
    expect(r2.ok).toBe(false);
    expect(r2.content).toContain("no staging deploy target");
  });

  it("never exposes repoRoot / changedPageIds to the model", async () => {
    const h = harness({ "deploy.list_targets": () => TARGETS });
    const r = await run(deployStagingTool, { repoRoot: "/etc" }, h.toolCtx);
    expect(r.ok).toBe(false);
    expect(h.calls).toHaveLength(0);
  });
});

describe("experiments tools", () => {
  const variants = [
    { label: "control", weight: 0.5 },
    { label: "b", weight: 0.5, htmlPatches: [{ find: "Sign up", replace: "Try it" }] },
  ];

  it("create_experiment validates the op's own schema at the tool boundary", async () => {
    const h = harness({ "experiments.create": () => ({ experimentId: U3 }) });
    const bad = await run(
      createExperimentTool,
      { slug: "Bad Slug", pageId: U1, variants },
      h.toolCtx,
    );
    expect(bad.ok).toBe(false);
    const one = await run(
      createExperimentTool,
      { slug: "hero-cta", pageId: U1, variants: [variants[0]] },
      h.toolCtx,
    );
    expect(one.ok).toBe(false);
    // A label is a build/URL path segment — traversal never reaches the op.
    for (const label of ["x/../../../../target", "..", "a b", ".hidden"]) {
      const traversal = await run(
        createExperimentTool,
        { slug: "hero-cta", pageId: U1, variants: [variants[0], { label, weight: 0.5 }] },
        h.toolCtx,
      );
      expect(traversal.ok).toBe(false);
    }
    expect(h.calls).toHaveLength(0);
  });

  it("create_experiment returns the draft id and points at the gated activation", async () => {
    const h = harness({ "experiments.create": () => ({ experimentId: U3 }) });
    const r = await run(
      createExperimentTool,
      { slug: "hero-cta", pageId: U1, variants },
      h.toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain(U3);
    expect(r.content).toContain("propose_activate_experiment");
  });

  it("list_experiments forwards the status filter only", async () => {
    const h = harness({
      "experiments.list": () => ({
        experiments: [
          {
            id: U3,
            slug: "hero-cta",
            pageId: U1,
            status: "draft",
            variants,
            startedAt: null,
            completedAt: null,
            winningVariant: null,
            createdAt: "2026-10-07T00:00:00.000Z",
          },
        ],
      }),
    });
    const r = await run(listExperimentsTool, { status: "draft", limit: 5 }, h.toolCtx);
    expect(r.ok).toBe(true);
    expect(h.calls[0]?.input).toEqual({ status: "draft" });
    expect(r.content).toContain("hero-cta");
    expect(r.content).toContain("control:0.5|b:0.5");
  });

  it("get_experiment_results renders per-variant counts and an empty state", async () => {
    const h = harness({
      "experiments.get_results": () => ({
        counts: [{ variantLabel: "b", uniqueVisitors: 3, totalImpressions: 7 }],
      }),
    });
    const r = await run(getExperimentResultsTool, { experimentId: U3 }, h.toolCtx);
    expect(r.content).toContain("b: 3 unique visitor(s), 7 impression(s)");
    const empty = harness({ "experiments.get_results": () => ({ counts: [] }) });
    const r2 = await run(getExperimentResultsTool, { experimentId: U3 }, empty.toolCtx);
    expect(r2.content).toContain("No visitors assigned yet");
  });
});

describe("verify_domains / verify_dns_records", () => {
  const domains = {
    domains: [
      { id: U1, hostname: "example.com", kind: "public" },
      { id: U2, hostname: "admin.example.com", kind: "admin" },
    ],
  };

  it("verify_domains checks every domain by default and only the named ones otherwise", async () => {
    const h = harness({
      "domains.list": () => domains,
      "domains.verify": (input: { domainId: string }) =>
        input.domainId === U1
          ? { hostname: "example.com", a: ["192.0.2.1"], aaaa: [], resolved: true }
          : { hostname: "admin.example.com", a: [], aaaa: [], resolved: false },
    });
    const all = await run(verifyDomainsTool, {}, h.toolCtx);
    expect(all.ok).toBe(true);
    expect(all.content).toContain("example.com (public): resolves → 192.0.2.1");
    expect(all.content).toContain("admin.example.com (admin): not resolved yet");
    const before = h.calls.length;
    await run(verifyDomainsTool, { hostnames: ["ADMIN.example.com."] }, h.toolCtx);
    const verified = h.calls.slice(before).filter((c) => c.op === "domains.verify");
    expect(verified.map((c) => (c.input as { domainId: string }).domainId)).toEqual([U2]);
  });

  it("verify_domains names unknown hostnames instead of guessing", async () => {
    const h = harness({ "domains.list": () => domains });
    const r = await run(verifyDomainsTool, { hostnames: ["other.org"] }, h.toolCtx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("other.org");
    expect(r.content).toContain("example.com, admin.example.com");
  });

  it("verify_dns_records defaults to the installer's required records, deduped", async () => {
    const rec = {
      hostname: "_acme.example.com",
      type: "TXT",
      value: "tok",
      purpose: "certificate",
    };
    const h = harness({
      "provisioning_outputs.get": () => ({
        rows: [{ dnsRecordsRequired: [rec] }, { dnsRecordsRequired: [rec] }],
      }),
      "dns.verify_record": () => ({ status: "pending", observed: [], message: "propagating" }),
    });
    const r = await run(verifyDnsRecordsTool, {}, h.toolCtx);
    expect(r.ok).toBe(true);
    const checks = h.calls.filter((c) => c.op === "dns.verify_record");
    expect(checks.map((c) => c.input)).toEqual([
      { hostname: "_acme.example.com", type: "TXT", expectedValue: "tok" },
    ]);
    expect(r.content).toContain("TXT _acme.example.com (certificate): pending");
  });

  it("verify_dns_records reports a mismatch with both values", async () => {
    const h = harness({
      "dns.verify_record": () => ({ status: "mismatch", observed: ["198.51.100.9"], message: "x" }),
    });
    const r = await run(
      verifyDnsRecordsTool,
      { records: [{ hostname: "example.com", type: "A", expectedValue: "192.0.2.1" }] },
      h.toolCtx,
    );
    expect(r.content).toContain("expected 192.0.2.1, published 198.51.100.9");
  });
});

describe("delete_media_many", () => {
  it("never forces, dedupes ids, and reports in-use assets as blocked", async () => {
    const h = harness({
      "media.delete_many": () => ({
        deleted: 1,
        blocked: [{ assetId: U2, referencingModuleSlugs: ["hero"] }],
      }),
    });
    const r = await run(deleteMediaManyTool, { assetIds: [U1, U2, U1, U3] }, h.toolCtx);
    expect(h.calls[0]?.input).toEqual({ assetIds: [U1, U2, U3], force: false });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Deleted 1 of 3");
    expect(r.content).toContain(`${U2}: still used by hero`);
    expect(r.content).toContain("1 id(s) were not found");
  });

  it("rejects a force flag at the tool boundary", async () => {
    const h = harness({ "media.delete_many": () => ({ deleted: 0, blocked: [] }) });
    const r = await run(deleteMediaManyTool, { assetIds: [U1], force: true }, h.toolCtx);
    expect(r.ok).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("is a failure when nothing was deleted", async () => {
    const h = harness({
      "media.delete_many": () => ({
        deleted: 0,
        blocked: [{ assetId: U1, referencingModuleSlugs: [] }],
      }),
    });
    const r = await run(deleteMediaManyTool, { assetIds: [U1] }, h.toolCtx);
    expect(r.ok).toBe(false);
  });
});

describe("delete_modules_many", () => {
  it("surfaces refused (still placed) modules with the op's reason", async () => {
    const h = harness({
      "modules.delete_many": () => ({
        deleted: 1,
        alreadyDeleted: 0,
        notFound: 0,
        refused: [{ moduleId: U2, reason: 'module "hero" is still placed on 1 page(s) (home)' }],
      }),
    });
    const r = await run(deleteModulesManyTool, { moduleIds: [U1, U2] }, h.toolCtx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Deleted 1 module(s).");
    expect(r.content).toContain(`${U2}: module "hero" is still placed`);
  });

  it("caps the batch at 200 ids", async () => {
    const h = harness({});
    const ids = Array.from({ length: 201 }, () => U1);
    const r = await run(deleteModulesManyTool, { moduleIds: ids }, h.toolCtx);
    expect(r.ok).toBe(false);
  });
});

describe("accept_import_pages", () => {
  it("forwards ids + optional template and lists the created drafts", async () => {
    const h = harness({
      "imports.accept_pages": () => ({
        accepted: [{ importPageId: U1, pageId: U2, slug: "about" }],
      }),
    });
    const r = await run(acceptImportPagesTool, { importPageIds: [U1] }, h.toolCtx);
    expect(h.calls[0]?.input).toEqual({ importPageIds: [U1] });
    expect(r.content).toContain(`about → page ${U2}`);
  });

  it("relays the op's all-or-nothing failure", async () => {
    const h = harness({
      "imports.accept_pages": () =>
        err({
          kind: "HandlerError",
          operation: "imports.accept_pages",
          message: "already accepted",
        }),
    });
    const r = await run(acceptImportPagesTool, { importPageIds: [U1], templateId: U3 }, h.toolCtx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("already accepted");
  });
});

describe("cleanup_import_run — Owner-approval gated", () => {
  it("an AI dispatch only queues the card; the handler does not run", async () => {
    expect(await cleanupImportRunTool.needsApproval?.({ runId: U1 }, AI)).toBe(true);
    // No adapter: reaching the handler would throw, so a clean result proves the gate.
    const r = await run(cleanupImportRunTool, { runId: U1 }, {} as ToolContext);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("[needs-approval, non-persisted]");
  });

  it("the approved (Owner) dispatch deletes exactly the screenshots the op reports dropped", async () => {
    const deletedKeys: string[] = [];
    setMediaStorage({
      delete: async (k: string) => {
        deletedKeys.push(k);
      },
    } as never);
    const h = harness(
      {
        // The pre-read is stale on purpose: a page accepted between the
        // approval and the cleanup must keep its screenshot — only the
        // op's DELETE … RETURNING keys are authoritative.
        "imports.get": () => ({
          run: { id: U1 },
          pages: [
            { acceptedPageId: null, screenshotObjectKey: "shots/a.png" },
            { acceptedPageId: null, screenshotObjectKey: "shots/accepted-meanwhile.png" },
            { acceptedPageId: null, screenshotObjectKey: null },
          ],
        }),
        "imports.cleanup_run": () => ({
          droppedPages: 2,
          droppedScreenshotKeys: ["shots/a.png"],
        }),
      },
      { "imports.cleanup_run": ["human", "system"] },
    );
    const r = await run(cleanupImportRunTool, { runId: U1 }, h.toolCtx, OWNER);
    expect(r.ok).toBe(true);
    expect(deletedKeys).toEqual(["shots/a.png"]);
    expect(r.content).toContain("2 un-built crawled page(s)");
    expect(r.content).toContain("built pages kept");
  });

  it("states the two-step contract", () => {
    expect(cleanupImportRunTool.description).toContain("TWO-STEP");
  });
});

describe("send_test_email", () => {
  it("validates the recipient and relays the op's refusal", async () => {
    const h = harness({
      "email_config.send_test": () =>
        err({
          kind: "HandlerError",
          operation: "email_config.send_test",
          message:
            "the AI can only send the test to an address on the sender's domain (@example.com)",
        }),
    });
    const bad = await run(sendTestEmailTool, { to: "not-an-email" }, h.toolCtx);
    expect(bad.ok).toBe(false);
    expect(h.calls).toHaveLength(0);
    const r = await run(sendTestEmailTool, { to: "x@other.org" }, h.toolCtx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("sender's domain");
  });

  it("reports acceptance, not delivery", async () => {
    const h = harness({
      "email_config.send_test": () => ({ messageId: "m-1", transport: "resend" }),
    });
    const r = await run(sendTestEmailTool, { to: "team@example.com" }, h.toolCtx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("acceptance is not delivery");
  });
});
