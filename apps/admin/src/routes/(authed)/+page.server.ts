// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, redirect } from "@sveltejs/kit";
import { getQueryContext } from "#lib/server/query.js";
import { type DeployRunSummary, type SiteState, siteStateFrom } from "#lib/site-state.js";
import type { PageServerLoad } from "./$types";

/** How many chats the "Recent chats" card lists. */
const RECENT_CHAT_COUNT = 3;

/** The `chat.list_sessions` fields the dashboard shows. */
interface DashboardChat {
  id: string;
  title: string;
  lastActiveAt: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  // Route to /setup when there are no users yet; otherwise require login.
  const setup = await execute(registry, adapter, locals.ctx, "users.is_setup_complete", {});
  // CLAUDE.md §2 no-fallbacks: fail loudly instead of guessing.
  if (!setup.ok) throw error(500, `users.is_setup_complete failed: ${setup.error.kind}`);
  if (!(setup.value as { complete: boolean }).complete) throw redirect(303, "/setup");
  if (!locals.user) throw redirect(303, "/login");

  const perms = locals.user.permissions;

  // Zero published pages = a fresh install: the dashboard's first card then
  // invites the operator to set the site up in Live edit.
  let publishedPageCount = 0;
  let pages: { status: string }[] = [];
  const pagesR = await execute(registry, adapter, locals.ctx, "pages.list", {});
  if (pagesR.ok) {
    pages = (pagesR.value as { pages: { status: string }[] }).pages;
    publishedPageCount = pages.filter((p) => p.status === "published").length;
  }

  // #779 — Draft / Preview / Live summary. Only rendered when both reads
  // succeeded: a half-known state would claim "nothing staged" or "not
  // live" without knowing it (CLAUDE.md §2 no-fallbacks).
  let siteState: SiteState | null = null;
  const runsR = await execute(registry, adapter, locals.ctx, "deploy.list_runs", { limit: 200 });
  if (pagesR.ok && runsR.ok) {
    siteState = siteStateFrom(pages, (runsR.value as { runs: DeployRunSummary[] }).runs);
  }

  // Status cards. Each read is gated by the permission of the page its card
  // links to, and a card whose read failed is left out (null) rather than
  // showing a made-up zero — same rule as the site state above.
  const [chatsR, changesR, pendingR, bugsR] = await Promise.all([
    perms.has("content.write")
      ? execute(registry, adapter, locals.ctx, "chat.list_sessions", { includeArchived: false })
      : null,
    perms.has("content.write")
      ? execute(registry, adapter, locals.ctx, "chat.list_open_changes", {})
      : null,
    perms.has("settings.read")
      ? execute(registry, adapter, locals.ctx, "pending_proposals.list", { limit: 1 })
      : null,
    perms.has("settings.read")
      ? execute(registry, adapter, locals.ctx, "ai_bug_reports.list", { status: "new", limit: 1 })
      : null,
  ]);
  for (const [op, r] of [
    ["chat.list_sessions", chatsR],
    ["chat.list_open_changes", changesR],
    ["pending_proposals.list", pendingR],
    ["ai_bug_reports.list", bugsR],
  ] as const) {
    if (r && !r.ok) console.error(`[dashboard] ${op} failed`, { kind: r.error.kind });
  }

  const recentChats: DashboardChat[] | null = chatsR?.ok
    ? (chatsR.value as { sessions: DashboardChat[] }).sessions
        .slice(0, RECENT_CHAT_COUNT)
        .map(({ id, title, lastActiveAt }) => ({ id, title, lastActiveAt }))
    : null;
  const openChanges: { changeCount: number; chatCount: number } | null = changesR?.ok
    ? (() => {
        const chats = (changesR.value as { chats: { pendingCount: number }[] }).chats.filter(
          (c) => c.pendingCount > 0,
        );
        return {
          changeCount: chats.reduce((sum, c) => sum + c.pendingCount, 0),
          chatCount: chats.length,
        };
      })()
    : null;
  const pendingApprovals: number | null = pendingR?.ok
    ? (pendingR.value as { total: number }).total
    : null;
  const newBugReports: number | null = bugsR?.ok ? (bugsR.value as { total: number }).total : null;

  return {
    siteState,
    user: {
      email: locals.user.email,
      roles: locals.user.roles,
      permissions: [...locals.user.permissions].sort(),
    },
    publishedPageCount,
    recentChats,
    openChanges,
    pendingApprovals,
    newBugReports,
  };
};
