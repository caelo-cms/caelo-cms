// SPDX-License-Identifier: MPL-2.0

/**
 * #589 CI guard — every §11.A gated tool names the permission its approver
 * must hold, so no approval can be granted by "anyone who can open the chat".
 *
 *  - a `gated` tool (makeProposeTool): its `executeOp` is a registered op
 *    that declares `approverPermissions` (via `requiresApproverPermission`);
 *  - a `needsApproval` tool (the /security/tool-approvals queue): the tool
 *    declares `approverPermissions` itself.
 *
 * Plus unit coverage of the wrapper's decision table against a stub
 * transaction (the real role join is pinned in
 * gated-approver-permission.integration.test.ts).
 */

import { describe, expect, it } from "bun:test";
import authPlugin from "@caelo-cms/plugin-auth";
import commentsPlugin from "@caelo-cms/plugin-comments";
import consentPlugin from "@caelo-cms/plugin-consent-manager";
import formsPlugin from "@caelo-cms/plugin-forms";
import intlPlugin from "@caelo-cms/plugin-international-site";
import newsletterPlugin from "@caelo-cms/plugin-newsletter";
import ratingsPlugin from "@caelo-cms/plugin-ratings";
import {
  defineOperation,
  type OperationDefinition,
  OperationRegistry,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { z } from "zod";
import { createDefaultToolRegistry, type ToolRegistry } from "../ai/tools/index.js";
import {
  approverPermissionsOf,
  isApproverPermissionRefusal,
  requiresApproverPermission,
} from "../ops/_approver-permission.js";
import { PERMISSIONS } from "../permissions.js";
import { registerAdminOps } from "../register.js";

/** Gated tools whose executor declares no approver permission. */
function undeclaredGatedTools(tools: ToolRegistry, registry: OperationRegistry): string[] {
  return tools.list().flatMap((t) => {
    if (t.gated) {
      const op = registry.lookup(t.gated.executeOp);
      if (!op.ok) return [`${t.name}: executor ${t.gated.executeOp} is not registered`];
      return approverPermissionsOf(op.value)
        ? []
        : [`${t.name}: ${t.gated.executeOp} declares no approver permission`];
    }
    if (t.needsApproval && !(t.approverPermissions && t.approverPermissions.length > 0)) {
      return [`${t.name}: needsApproval tool declares no approverPermissions`];
    }
    return [];
  });
}

const registry = new OperationRegistry();
registerAdminOps(registry);
const tools = createDefaultToolRegistry();

describe("#589 guard: every gated tool declares its approver permission", () => {
  it("no gated or needsApproval tool lacks a declared approver permission", () => {
    expect(
      undeclaredGatedTools(tools, registry),
      "A §11.A gated tool must name the permission its approver needs — wrap its executor in " +
        "requiresApproverPermission([...], defineOperation({...})) (or set approverPermissions " +
        "on a needsApproval tool), using the permission the equivalent panel action requires.",
    ).toEqual([]);
  });

  it("every declared permission is a real catalog permission", () => {
    const known = new Set<string>(PERMISSIONS);
    const declared = registry.names().flatMap((name) => {
      const op = registry.lookup(name);
      return op.ok ? (approverPermissionsOf(op.value) ?? []) : [];
    });
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((p) => !known.has(p))).toEqual([]);
  });

  it("covers the domains #589 names (roles, deploy, snapshots, plugins, settings, SEO)", () => {
    const perms = (op: string) => {
      const r = registry.lookup(op);
      return r.ok ? approverPermissionsOf(r.value) : null;
    };
    expect(perms("roles.execute_proposal")).toEqual(["roles.manage"]);
    expect(perms("deploy.execute_proposal")).toEqual(["deploy.trigger"]);
    expect(perms("snapshots.execute_proposal")).toEqual(["roles.manage"]);
    expect(perms("plugins.execute_activation")).toEqual(["settings.write", "plugins.install"]);
    expect(perms("plugins.execute_proposal")).toEqual(["settings.write", "plugins.install"]);
    expect(perms("owner_settings.execute_proposal")).toEqual(["settings.write"]);
    expect(perms("site_defaults.execute_proposal")).toEqual(["roles.manage"]);
  });

  it("flags a gated tool whose executor declares nothing", () => {
    const reg = new OperationRegistry();
    reg.register(
      defineOperation({
        name: "widgets.execute_proposal",
        actorScope: ["human", "system"],
        database: "cms_admin",
        input: z.object({ proposalId: z.string() }),
        output: z.object({}),
        handler: async () => ok({}),
      }),
    );
    const fake = {
      list: () => [
        {
          name: "propose_widget",
          gated: {
            proposeOp: "widgets.propose",
            executeOp: "widgets.execute_proposal",
            pendingQueuePath: "/security/widgets/pending",
          },
        },
        { name: "delete_widgets", needsApproval: () => true },
      ],
    } as unknown as ToolRegistry;
    expect(undeclaredGatedTools(fake, reg)).toEqual([
      "propose_widget: widgets.execute_proposal declares no approver permission",
      "delete_widgets: needsApproval tool declares no approverPermissions",
    ]);
  });
});

// ─── wrapper decision table ──────────────────────────────────────────

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000b1",
  actorKind: "human",
  requestId: "approver-permission-unit",
};

/** A stub tx whose role join returns `held`. */
function txHolding(held: string[]): TransactionRunner {
  return {
    execute: async () => held.map((name) => ({ name })),
  } as unknown as TransactionRunner;
}

function wrapped(): { op: OperationDefinition<unknown, unknown>; ran: () => number } {
  let runs = 0;
  const op = requiresApproverPermission(
    ["roles.manage"],
    defineOperation({
      name: "widgets.execute_proposal",
      actorScope: ["human", "system"],
      database: "cms_admin",
      input: z.object({}),
      output: z.object({ applied: z.boolean() }),
      handler: async () => {
        runs++;
        return ok({ applied: true });
      },
    }),
  ) as OperationDefinition<unknown, unknown>;
  return { op, ran: () => runs };
}

describe("#589 guard: every approval-gated SHIPPED plugin tool names its approver permission", () => {
  // A plugin tool's `requiredPermission` is what the plugin host checks for
  // the person who clicked Approve (dispatch.ts, origin "approved"); without
  // it any chat user could approve the call.
  it("declares requiredPermission next to approvalMode, from the permission catalog", () => {
    const plugins = [
      authPlugin,
      commentsPlugin,
      consentPlugin,
      formsPlugin,
      intlPlugin,
      newsletterPlugin,
      ratingsPlugin,
    ];
    const offenders = plugins.flatMap((p) =>
      (p.tools ?? [])
        .filter((t) => t.approvalMode && !t.requiredPermission)
        .map((t) => `${p.slug}.${t.name}`),
    );
    expect(offenders).toEqual([]);
    const known = new Set<string>(PERMISSIONS);
    for (const p of plugins) {
      for (const t of p.tools ?? []) {
        if (t.requiredPermission) expect(known.has(t.requiredPermission)).toBe(true);
      }
    }
  });
});

describe("requiresApproverPermission", () => {
  it("exposes the declared permissions on the op definition", () => {
    expect(approverPermissionsOf(wrapped().op)).toEqual(["roles.manage"]);
  });

  it("lets a human holding the permission through", async () => {
    const { op, ran } = wrapped();
    const r = await op.handler(HUMAN, {}, txHolding(["content.read", "roles.manage"]));
    expect(r.ok).toBe(true);
    expect(ran()).toBe(1);
  });

  it("refuses a human without it before the handler runs, naming the permission", async () => {
    const { op, ran } = wrapped();
    const r = await op.handler(HUMAN, {}, txHolding(["content.read", "content.write"]));
    expect(r.ok).toBe(false);
    const message = r.ok ? "" : (r.error as { message: string }).message;
    expect(isApproverPermissionRefusal(message)).toBe(true);
    expect(message).toContain("roles.manage");
    expect(message).toContain("stays pending");
    expect(ran()).toBe(0);
  });

  it("refuses an AI actor even if a scope mistake let it reach the executor", async () => {
    const { op, ran } = wrapped();
    const r = await op.handler({ ...HUMAN, actorKind: "ai" }, {}, txHolding(["roles.manage"]));
    expect(r.ok).toBe(false);
    expect(ran()).toBe(0);
  });

  it("lets the system actor through without a role lookup", async () => {
    const { op, ran } = wrapped();
    const tx = {
      execute: async () => {
        throw new Error("system must not need a role lookup");
      },
    } as unknown as TransactionRunner;
    const r = await op.handler({ ...HUMAN, actorKind: "system" }, {}, tx);
    expect(r.ok).toBe(true);
    expect(ran()).toBe(1);
  });
});
