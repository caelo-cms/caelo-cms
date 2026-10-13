// SPDX-License-Identifier: MPL-2.0

/**
 * Every §11.A proposal has a page that can decide it (#684).
 *
 * A proposal reaches the operator three ways, and each one sends Approve /
 * Reject as a form POST (`<queue>?/approve`) to the domain's queue page:
 *
 *  - the chat's pending strip — `proposalQueueRoute(domain)` for every
 *    domain `pending_proposals.list` returns;
 *  - the proposal card — the queue path a propose tool writes into its
 *    result (`gated.pendingQueuePath`), parsed by proposal-parser.ts;
 *  - the approvals inbox's Review links — `proposalQueueRoute` again.
 *
 * `url_migrations` shipped with a propose tool, an executor and a strip
 * entry but no queue page: Approve answered 404 and a queued migration
 * could never be applied. This test enumerates the domains from the code
 * that creates proposals (the inbox SQL, the registered `*.execute_proposal`
 * ops, the gated tools) and fails when any of them has no page with both
 * actions — so the next new domain cannot ship without its page.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultToolRegistry, registerAdminOps } from "@caelo-cms/admin-core";
import { OperationRegistry } from "@caelo-cms/query-api";
import { proposalQueueRoute } from "../apps/admin/src/lib/proposal-queue-route.js";

const REPO_ROOT = join(import.meta.dir, "..");
const AUTHED_ROUTES = join(REPO_ROOT, "apps/admin/src/routes/(authed)");

/** Source of the page's server module, or null when the route has no page. */
function pageServer(route: string): string | null {
  try {
    return readFileSync(join(AUTHED_ROUTES, route, "+page.server.ts"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Why `route` cannot decide a proposal from a form POST, or null when it can. */
function queueProblem(route: string): string | null {
  const src = pageServer(route);
  if (src === null) return `${route} has no page`;
  const actions = src.slice(src.indexOf("export const actions"));
  if (!src.includes("export const actions")) return `${route} has no form actions`;
  const missing = ["approve", "reject"].filter((a) => !new RegExp(`\\b${a}\\s*:`).test(actions));
  return missing.length > 0 ? `${route} lacks ?/${missing.join(" and ?/")}` : null;
}

/** Domains the approvals inbox / chat pending strip can return. */
function inboxDomains(): string[] {
  const src = readFileSync(
    join(REPO_ROOT, "packages/admin-core/src/ops/pending_proposals.ts"),
    "utf8",
  );
  return [...new Set([...src.matchAll(/SELECT '([a-z_]+)'/g)].map((m) => m[1] as string))];
}

const registry = new OperationRegistry();
registerAdminOps(registry);
const executors = registry.names().filter((n) => /\.execute_proposal$/.test(n));

/** Every `+page.server.ts` source under /settings, concatenated. */
function settingsServerSources(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "+page.server.ts") out.push(readFileSync(full, "utf8"));
    }
  };
  walk(join(AUTHED_ROUTES, "settings"));
  return out.join("\n");
}

describe("every proposal domain has a queue page that approves and rejects", () => {
  it("finds the domains (guard against a silent parse miss)", () => {
    expect(inboxDomains().length).toBeGreaterThanOrEqual(15);
    expect(executors.length).toBeGreaterThanOrEqual(15);
  });

  it("the chat's pending strip and the inbox reach a working page for every inbox domain", () => {
    const problems = inboxDomains().flatMap((d) => {
      const p = queueProblem(proposalQueueRoute(d));
      return p ? [`${d}: ${p}`] : [];
    });
    expect(problems).toEqual([]);
  });

  it("every executor op has a queue page, and that page runs it", () => {
    const sources = settingsServerSources();
    const problems = executors.flatMap((op) => {
      const domain = op.slice(0, op.indexOf("."));
      const p = queueProblem(proposalQueueRoute(domain));
      if (p) return [`${op}: ${p}`];
      return sources.includes(`"${op}"`) ? [] : [`${op}: no Settings page calls it`];
    });
    expect(problems).toEqual([]);
  });

  it("every gated tool names a queue page that decides its proposals", () => {
    const problems = createDefaultToolRegistry()
      .list()
      .flatMap((t) => {
        if (!t.gated) return [];
        const path = t.gated.pendingQueuePath;
        // The approvals inbox lists everything but decides nothing itself;
        // a tool that names it leaves its proposal card without buttons.
        const expected = proposalQueueRoute(
          t.gated.executeOp.slice(0, t.gated.executeOp.indexOf(".")),
        );
        if (path !== expected) return [`${t.name}: queue ${path}, expected ${expected}`];
        const p = queueProblem(path);
        return p ? [`${t.name}: ${p}`] : [];
      });
    expect(problems).toEqual([]);
  });
});
