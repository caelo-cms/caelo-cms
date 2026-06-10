// SPDX-License-Identifier: MPL-2.0

/**
 * Domain inventory system-prompt context blocks — redirects, locales,
 * pending proposals, users, roles, AI providers, and domains (P8 / P9 /
 * v0.2.32 / v0.2.38). Extracted verbatim from the pre-split `chat-runner.ts`.
 * Each block lets the AI plan domain-targeting work without a `*.list`
 * round-trip; best-effort — a failed list omits its block, never blocks the
 * turn.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

export interface DomainBlocks {
  redirectsBlock: string | undefined;
  localesBlock: string | undefined;
  pendingProposalsBlock: string | undefined;
  usersBlock: string | undefined;
  rolesBlock: string | undefined;
  aiProvidersBlock: string | undefined;
  domainsBlock: string | undefined;
}

export async function buildDomainBlocks(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  aiActorId: string,
): Promise<DomainBlocks> {
  // P8 AI-first review pass — `## Redirects` context block. Lets the
  // AI plan slug-change conversations + bulk cleanup without a
  // `find_redirects` round-trip when the table is small. Caps at 30
  // most-recent rows; AI calls `find_redirects` for fuller search.
  let redirectsBlock: string | undefined;
  const redirR = await execute(registry, adapter, humanCtx, "redirects.list", { limit: 30 });
  if (redirR.ok) {
    const rows = redirR.value as {
      redirects: { fromPath: string; toPath: string; statusCode: number }[];
      totalCount: number;
    };
    if (rows.redirects.length > 0) {
      const lines = rows.redirects.map((r) => `- ${r.fromPath} → ${r.toPath} (${r.statusCode})`);
      redirectsBlock = [
        `# Redirects (showing ${rows.redirects.length} of ${rows.totalCount})`,
        "For more, call `find_redirects({ query?, statusCode?, limit? })`. To create / delete in bulk, prefer `bulk_create_redirects` / `bulk_delete_redirects` over multiple single-row tool calls.",
        ...lines,
      ].join("\n");
    }
  }

  // P9 — `## Locales` context block. Lists every locale with its URL
  // strategy and surfaces pending proposals so the AI doesn't re-queue
  // a change the Owner is already reviewing.
  let localesBlock: string | undefined;
  const localesR = await execute(registry, adapter, humanCtx, "locales.list", {});
  if (localesR.ok) {
    const rows = localesR.value as {
      locales: {
        code: string;
        displayName: string;
        urlStrategy: string;
        urlHost: string | null;
        isDefault: boolean;
      }[];
    };
    if (rows.locales.length > 0) {
      const lines = rows.locales.map((l) => {
        const def = l.isDefault ? " (DEFAULT)" : "";
        const host = l.urlHost ? ` host=${l.urlHost}` : "";
        return `- ${l.code} "${l.displayName}" — ${l.urlStrategy}${host}${def}`;
      });
      const pendingR = await execute(registry, adapter, humanCtx, "locales.list_pending", {
        status: "pending",
      });
      const pendingLines: string[] = [];
      if (pendingR.ok) {
        const p = pendingR.value as {
          proposals: { id: string; actionKind: string; payload: unknown }[];
        };
        for (const pr of p.proposals.slice(0, 10)) {
          pendingLines.push(
            `  pending: ${pr.actionKind} ${JSON.stringify(pr.payload)} (id=${pr.id})`,
          );
        }
      }
      localesBlock = [
        "# Locales",
        // v0.5.10 — dropped "per CLAUDE.md §11.A" citation. The AI can't
        // access that file; the citation made it sound like a referenceable
        // external doc. The rule itself stays.
        "Adding/removing/retargeting a locale is a TWO-STEP propose/execute flow. You propose via `propose_add_locale` / `propose_remove_locale` / `propose_set_default_locale` / `propose_update_locale_strategy`; an Owner clicks Approve at /security/locales/pending to apply. Do not claim the action was applied — tell the user the proposal is queued.",
        ...lines,
        ...(pendingLines.length > 0 ? ["Your pending proposals:", ...pendingLines] : []),
      ].join("\n");
    }
  }

  // v0.2.32 + v0.2.38 — `## Pending proposals` block, AI-self-filtered.
  // Surfaces ONLY proposals the AI itself queued in any prior turn so it
  // doesn't re-queue them (CLAUDE.md §11.A). Other actors' proposals get
  // a one-line count so the AI knows the operator has other things in
  // flight without flooding the context.
  let pendingProposalsBlock: string | undefined;
  const pendingR = await execute(registry, adapter, humanCtx, "pending_proposals.list", {
    limit: 200,
  });
  if (pendingR.ok) {
    const v = pendingR.value as {
      items: Array<{
        domain: string;
        kind: string;
        proposalId: string;
        summary: string;
        proposedBy: string;
        proposedAt: string;
      }>;
      byDomain: Record<string, number>;
      total: number;
    };
    const own = v.items.filter((i) => i.proposedBy === aiActorId);
    const othersCount = v.total - own.length;
    if (own.length > 0 || othersCount > 0) {
      const lines = own
        .slice(0, 30)
        .map(
          (i) =>
            `- [${i.domain}.${i.kind}] ${i.summary} (id=${i.proposalId.slice(0, 8)}, ${i.proposedAt.slice(0, 10)})`,
        );
      const headerParts: string[] = [];
      if (own.length > 0) headerParts.push(`${own.length} of your own`);
      if (othersCount > 0) headerParts.push(`${othersCount} from other actors`);
      pendingProposalsBlock = [
        `# Pending proposals (${headerParts.join(", ")})`,
        ...(own.length > 0
          ? [
              "Your queued proposals — DO NOT re-propose any of these. Tell the user they're already pending, or use `cancel_proposal` to withdraw.",
              // v0.2.64 — chat UI surfaces these proposals as a sticky
              // strip at the top of the transcript with inline
              // Approve / Reject buttons (shipped v0.2.62 / v0.2.63).
              // When the operator asks "where's the approve button?",
              // tell them: "scroll to the top of THIS chat — there's
              // an amber 'Pending your approval' strip with the
              // Approve button right there." Do NOT direct them to
              // /security/<domain>/pending unless they explicitly
              // want the full preview view; the strip is the fast
              // path. Pre-v0.2.62 instances may not have the strip,
              // so /security/pending is the safe fallback.
              "When directing the operator to approve a queued proposal: tell them to look for the amber 'Pending your approval' strip at the top of this chat panel — each row has inline Approve / Reject buttons. They don't need to navigate to /security/<domain>/pending; the strip and the original tool-card both have one-click approve. If the strip isn't visible after a recent upgrade, ask the operator to hard-refresh.",
              ...lines,
            ]
          : []),
        ...(othersCount > 0
          ? [
              `(${othersCount} more pending from other actors — operator can review at /security/pending.)`,
            ]
          : []),
      ].join("\n");
    }
  }

  // v0.2.38 — `## Users` / `## Roles` / `## AI providers` / `## Domains`
  // inventory blocks (CLAUDE.md §11: "new domains should ship a
  // corresponding context block when the data fits in <2 KB").
  let usersBlock: string | undefined;
  const usersListR = await execute(registry, adapter, humanCtx, "users.list", {});
  if (usersListR.ok) {
    const users = (
      usersListR.value as {
        users: Array<{ id: string; email: string; displayName: string; roles: string[] }>;
      }
    ).users;
    if (users.length > 0) {
      usersBlock = [
        `# Users (${users.length})`,
        "Use `propose_create_user` to invite, `propose_set_user_roles` to change roles, `propose_delete_user` to soft-delete.",
        ...users
          .slice(0, 40)
          .map(
            (u) =>
              `- ${u.email} "${u.displayName}" — ${u.roles.length > 0 ? u.roles.join("+") : "(no roles)"} (id=${u.id.slice(0, 8)})`,
          ),
      ].join("\n");
    }
  }

  let rolesBlock: string | undefined;
  const rolesListR = await execute(registry, adapter, humanCtx, "roles.list", {});
  if (rolesListR.ok) {
    const roles = (
      rolesListR.value as {
        roles: Array<{
          id: string;
          name: string;
          description: string;
          isBuiltin: boolean;
          permissions: string[];
        }>;
      }
    ).roles;
    if (roles.length > 0) {
      rolesBlock = [
        `# Roles (${roles.length})`,
        "Use `propose_create_role` for new roles, `propose_update_role_permissions` to modify, `propose_delete_role` to remove (built-in roles cannot be deleted).",
        ...roles.map(
          (r) =>
            `- ${r.name}${r.isBuiltin ? " [builtin]" : ""} — ${r.permissions.length} permission${r.permissions.length === 1 ? "" : "s"} (id=${r.id.slice(0, 8)})`,
        ),
      ].join("\n");
    }
  }

  let aiProvidersBlock: string | undefined;
  const providersR = await execute(registry, adapter, humanCtx, "ai_providers.list", {});
  if (providersR.ok) {
    const providers = (
      providersR.value as {
        providers: Array<{
          name: string;
          displayName: string;
          isActive: boolean;
          apiKeySource: "db" | "env" | null;
        }>;
      }
    ).providers;
    if (providers.length > 0) {
      aiProvidersBlock = [
        "# AI providers",
        "Use `propose_set_ai_provider` to add or modify config (Owner pastes apiKey at approve), `propose_clear_ai_provider_key` to wipe a stored key.",
        ...providers.map(
          (p) =>
            `- ${p.name} "${p.displayName}" — active=${p.isActive}, key=${p.apiKeySource ?? "none"}`,
        ),
      ].join("\n");
    }
  }

  let domainsBlock: string | undefined;
  const domainsR = await execute(registry, adapter, humanCtx, "domains.list", {});
  if (domainsR.ok) {
    const domains = (
      domainsR.value as {
        domains: Array<{
          id: string;
          hostname: string;
          kind: string;
          tlsStatus: string;
        }>;
      }
    ).domains;
    if (domains.length > 0) {
      domainsBlock = [
        `# Domains (${domains.length})`,
        "Use `propose_add_domain` for new hostnames, `propose_remove_domain` to drop. Use `domains.verify` (read-only DNS lookup) to preflight DNS resolution before proposing an add.",
        ...domains.map(
          (d) => `- ${d.hostname} (${d.kind}) — TLS=${d.tlsStatus} (id=${d.id.slice(0, 8)})`,
        ),
      ].join("\n");
    }
  }

  return {
    redirectsBlock,
    localesBlock,
    pendingProposalsBlock,
    usersBlock,
    rolesBlock,
    aiProvidersBlock,
    domainsBlock,
  };
}
