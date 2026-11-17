// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1636 — one permission for working on a site through an AI. The
 * Live Edit chat and both MCP surfaces run the same tool catalogue as an AI
 * actor bound to the person, in the same draft, behind the same approval
 * gates; a path that asked for more than the others only moved people to
 * another path (until #1636 the Power-MCP surface needed `settings.write`,
 * a rule carried over from minting tokens). This pins every path to
 * `AI_WORK_PERMISSION`: a path that names its own permission fails here
 * until docs/dev/mcp-access.md says why it differs.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { approverPermissionsOf } from "../packages/admin-core/src/ops/_approver-permission.ts";
import { executeMcpTokenProposalOp } from "../packages/admin-core/src/ops/mcp_token_pending.ts";
import { REMOTE_SURFACE_PERMISSION } from "../packages/admin-core/src/ops/security/mcp_principal.ts";
import {
  AI_WORK_PERMISSION,
  MCP_SURFACE_COPY,
  MCP_SURFACE_NAMES,
  MCP_SURFACE_PERMISSION,
} from "../packages/shared/src/mcp-access.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const src = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

/** Every `requirePermission(locals, <arg>)` argument in `source`. */
function requiredPermissions(source: string): string[] {
  return [...source.matchAll(/requirePermission\(\s*locals,\s*([^)]+?)\s*\)/g)].map(
    (m) => m[1] as string,
  );
}

/** The body of form action `name` in a `+page.server.ts` source. */
function actionBody(source: string, name: string): string {
  const start = source.indexOf(`  ${name}: async (`);
  if (start < 0) throw new Error(`no action "${name}"`);
  const next = source.indexOf("\n  },\n", start);
  return source.slice(start, next);
}

describe("one permission for working through an AI (#1636)", () => {
  it("is content.write, the permission to change the site's content", () => {
    expect(AI_WORK_PERMISSION).toBe("content.write");
  });

  it("both MCP surfaces need exactly it, in the map and in the remote resolver", () => {
    for (const surface of MCP_SURFACE_NAMES) {
      expect(MCP_SURFACE_PERMISSION[surface]).toBe(AI_WORK_PERMISSION);
      expect(REMOTE_SURFACE_PERMISSION[surface]).toBe(AI_WORK_PERMISSION);
      // What people read under Settings → MCP and on the consent page.
      expect(MCP_SURFACE_COPY[surface].who).toContain(AI_WORK_PERMISSION);
    }
  });

  it("a turn in the Live Edit chat needs it and nothing else", () => {
    const route = src("apps/admin/src/routes/(authed)/content/chat/[sessionId]/stream/+server.ts");
    expect(requiredPermissions(route)).toEqual(["AI_WORK_PERMISSION"]);
  });

  it("a token resolves only for a person who still holds it", () => {
    const tokens = src("packages/admin-core/src/ops/security/mcp_tokens.ts");
    const resolveToken = tokens.slice(
      tokens.indexOf("export async function resolveMcpToken("),
      tokens.indexOf("export interface SendChatBridgeOpts"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    expect(resolveToken).toContain("p.name = ${AI_WORK_PERMISSION}");
    expect(resolveToken).toContain("AS user_can_write");
    expect(resolveToken).not.toMatch(/p\.name = '[a-z.]+'/);
  });

  it("minting a token needs it: on the Settings page, in the op and on the approval card", () => {
    const page = src("apps/admin/src/routes/(authed)/settings/mcp/+page.server.ts");
    expect(requiredPermissions(actionBody(page, "create"))).toEqual(["AI_WORK_PERMISSION"]);
    const tokens = src("packages/admin-core/src/ops/security/mcp_tokens.ts");
    const create = tokens.slice(
      tokens.indexOf("export const createMcpTokenOp"),
      tokens.indexOf("export const revokeMcpTokenOp"),
    );
    expect(create).toContain("missingPermissions(tx, ctx.actorId, [");
    expect(create).toContain("AI_WORK_PERMISSION,");
    expect(approverPermissionsOf(executeMcpTokenProposalOp)).toEqual([AI_WORK_PERMISSION]);
  });

  it("the Owner's controls over other people's access stay with settings.write", () => {
    const page = src("apps/admin/src/routes/(authed)/settings/mcp/+page.server.ts");
    for (const action of [
      "remoteRevoke",
      "remoteRestore",
      "remoteBlockUser",
      "remoteUnblockUser",
      "remoteSetCap",
    ]) {
      expect(requiredPermissions(actionBody(page, action))).toEqual(['"settings.write"']);
    }
    // "May use Caelo's AI" spends the install's account: an Owner's decision.
    expect(src("packages/admin-core/src/ops/security/mcp_tokens.ts")).toContain(
      'const ALLOW_CAELO_AI_PERMISSION = "settings.write";',
    );
  });
});
