// SPDX-License-Identifier: MPL-2.0

/**
 * On-demand state endpoints for every system-prompt context chunk that
 * previously had NO read tool (2026-07 chunk audit). The chunks are a
 * snapshot from turn start — when the AI writes state mid-turn (theme,
 * proposals, defaults, …) the chunk goes stale and, without a read
 * path, the model's only options were "trust the stale chunk" or
 * "repeat the write". Each tool here re-renders CURRENT state through
 * the same ops the chunk builders use.
 *
 * All defined via `makeReadTool` — Zod schema once, JSON Schema
 * generated, standard handler. Long-tail by design: they stay deferred
 * behind Tool Search and load on demand.
 */

import { z } from "zod";
import { makeListReadTool, makeReadTool } from "./_make-read-tool.js";

const noInput = z.object({}).strict();

/** site-defaults + site-identity chunks — both render from site_defaults.get. */
export const getSiteDefaultsTool = makeReadTool<Record<string, never>>({
  name: "get_site_defaults",
  description:
    "Fetch the CURRENT site defaults + identity: default layout/template (slug + UUID), siteName, sitePurpose, design brief. " +
    "The `# Site defaults` / `## Site identity` context blocks are a snapshot from turn start — call this when you changed defaults or identity THIS turn (set_site_defaults / set_site_identity) and need the fresh state, instead of repeating the write.",
  opName: "site_defaults.get",
  input: noInput,
  format: (value) => {
    const d = (
      value as {
        defaults: {
          defaultLayoutSlug: string;
          defaultLayoutId: string;
          defaultTemplateSlug: string;
          defaultTemplateId: string;
          siteName: string | null;
          sitePurpose: string | null;
        } | null;
      }
    ).defaults;
    if (!d) return "No site defaults configured yet — set_site_defaults creates the singleton.";
    return [
      `default layout: ${d.defaultLayoutSlug} (id=${d.defaultLayoutId})`,
      `default template: ${d.defaultTemplateSlug} (id=${d.defaultTemplateId})`,
      `siteName: ${d.siteName ?? "(not set)"}`,
      `sitePurpose: ${d.sitePurpose ?? "(not set)"}`,
    ].join("\n");
  },
});

/** design-system chunk — renders from design_manifest.get. */
export const getDesignManifestTool = makeReadTool<Record<string, never>>({
  name: "get_design_manifest",
  description:
    "Fetch the CURRENT Design Manifest (typography, rhythm, named patterns) — the site's design language. " +
    "The `## Design system` context block is a snapshot from turn start — call this after set_design_manifest THIS turn to confirm the stored state instead of repeating the write.",
  opName: "design_manifest.get",
  input: noInput,
  format: (value) => {
    const m = (value as { manifest: unknown }).manifest;
    if (!m) return "No design manifest set yet — set_design_manifest creates it.";
    return `Current design manifest:\n${JSON.stringify(m, null, 2)}`;
  },
});

/** locales chunk — renders from locales.list. */
export const listLocalesTool = makeListReadTool<
  Record<string, never>,
  {
    code: string;
    displayName: string;
    urlStrategy: string;
    isDefault: boolean;
  }
>({
  name: "list_locales",
  description:
    "List the site's locales (code, display name, URL strategy, default flag). " +
    "The `## Locales` context block is a snapshot from turn start — call this when an Owner approved a locale proposal mid-conversation or you need the current registry. " +
    "Locale changes themselves go through propose_add_locale / propose_remove_locale (Owner-approved).",
  opName: "locales.list",
  input: noInput,
  label: "locales",
  rows: (value) =>
    (
      value as {
        locales: { code: string; displayName: string; urlStrategy: string; isDefault: boolean }[];
      }
    ).locales,
  columns: [
    { key: "code", value: (l) => l.code },
    { key: "displayName", value: (l) => l.displayName },
    { key: "urlStrategy", value: (l) => l.urlStrategy },
    { key: "default", value: (l) => (l.isDefault ? "yes" : "") },
  ],
  emptyMessage: "No locales configured.",
});

/** pending_proposals chunk — renders from pending_proposals.list. */
export const listPendingProposalsTool = makeListReadTool<
  Record<string, never>,
  {
    domain: string;
    kind: string;
    proposalId: string;
    summary: string;
  }
>({
  name: "list_pending_proposals",
  description:
    "List every proposal currently awaiting Owner approval, across all gated domains (locales, layouts, users, roles, reverts, themes, deploys, …). " +
    "The `## Pending proposals` context block is a snapshot from turn start — call this BEFORE queueing a proposal you may already have filed this turn (a duplicate is rejected), and after the user says they approved something.",
  opName: "pending_proposals.list",
  input: noInput,
  label: "pending_proposals",
  rows: (value) =>
    (value as { items: { domain: string; kind: string; proposalId: string; summary: string }[] })
      .items,
  columns: [
    { key: "domain", value: (i) => i.domain },
    { key: "kind", value: (i) => i.kind },
    { key: "proposalId", value: (i) => i.proposalId },
    { key: "summary", value: (i) => i.summary },
  ],
  emptyMessage: "No pending proposals — the Owner queue is empty.",
});

/** foreign_locks chunk — renders from chat.list_foreign_locks. */
export const listEntityLocksTool = makeListReadTool<
  Record<string, never>,
  {
    entityKind: string;
    entityId: string;
    label: string;
  }
>({
  name: "list_entity_locks",
  description:
    "List entities currently locked by OTHER chat sessions (module/page/template/… + who holds the lock). " +
    "The `## Locks held by other chats` context block is a snapshot from turn start — call this when a write fails with a Locked error to see the CURRENT holder, or before planning edits on entities another chat may be touching.",
  opName: "chat.list_foreign_locks",
  input: noInput,
  buildOpInput: (_input, _ctx, toolCtx) => ({ chatSessionId: toolCtx.chatSessionId }),
  label: "locks",
  rows: (value) =>
    (value as { locks: { entityKind: string; entityId: string; label: string }[] }).locks,
  columns: [
    { key: "entityKind", value: (l) => l.entityKind },
    { key: "label", value: (l) => l.label },
    { key: "entityId", value: (l) => l.entityId },
  ],
  emptyMessage: "No foreign locks — no other chat is holding entities.",
});

/** users chunk — renders from users.list. */
export const listUsersTool = makeListReadTool<
  Record<string, never>,
  {
    email: string;
    displayName: string;
    roleNames?: string[];
  }
>({
  name: "list_users",
  description:
    "List the site's users (email, display name, roles). Read-only — user changes go through propose_create_user / propose_set_user_roles / propose_delete_user (Owner-approved). " +
    "The `## Users` context block is a snapshot from turn start; call this after an Owner approved a user proposal mid-conversation.",
  opName: "users.list",
  input: noInput,
  label: "users",
  rows: (value) =>
    (value as { users: { email: string; displayName: string; roleNames?: string[] }[] }).users,
  columns: [
    { key: "email", value: (u) => u.email },
    { key: "displayName", value: (u) => u.displayName },
    { key: "roles", value: (u) => (u.roleNames ?? []).join("|") },
  ],
  emptyMessage: "No users.",
});

/** roles chunk — renders from roles.list. */
export const listRolesTool = makeListReadTool<
  Record<string, never>,
  {
    name: string;
    description: string;
    isBuiltin: boolean;
  }
>({
  name: "list_roles",
  description:
    "List the site's roles (name, description, builtin flag). Read-only — role changes go through propose_create_role / propose_update_role_permissions / propose_delete_role (Owner-approved). " +
    "The `## Roles` context block is a snapshot from turn start.",
  opName: "roles.list",
  input: noInput,
  label: "roles",
  rows: (value) =>
    (value as { roles: { name: string; description: string; isBuiltin: boolean }[] }).roles,
  columns: [
    { key: "name", value: (r) => r.name },
    { key: "builtin", value: (r) => (r.isBuiltin ? "yes" : "") },
    { key: "description", value: (r) => r.description },
  ],
  emptyMessage: "No roles.",
});

/**
 * ai_providers chunk — renders from ai_providers.list. SECURITY: the
 * op's `config` payload can carry a plaintext apiKey (the resolver path
 * reads it); this tool must NEVER leak it into the transcript, so it
 * formats only brand-neutral status fields and drops the raw value
 * (includeValue: false).
 */
export const listAiProvidersTool = makeListReadTool<
  Record<string, never>,
  {
    displayName: string;
    isActive: boolean;
    config: Record<string, unknown>;
  }
>({
  name: "list_ai_providers",
  description:
    "List configured AI providers (display name, active flag, whether a key is configured). Key values are never returned. " +
    "Provider changes go through propose_set_ai_provider / propose_clear_ai_provider_key (Owner-approved).",
  opName: "ai_providers.list",
  input: noInput,
  includeValue: false,
  label: "ai_providers",
  rows: (value) =>
    (
      value as {
        providers: { displayName: string; isActive: boolean; config: Record<string, unknown> }[];
      }
    ).providers,
  columns: [
    { key: "displayName", value: (p) => p.displayName },
    { key: "active", value: (p) => (p.isActive ? "yes" : "no") },
    {
      key: "hasKey",
      value: (p) =>
        typeof p.config.apiKey === "string" && p.config.apiKey.length > 0 ? "yes" : "no",
    },
  ],
  emptyMessage: "No AI providers configured.",
});

/** domains chunk — renders from domains.list. */
export const listDomainsTool = makeListReadTool<
  Record<string, never>,
  {
    hostname: string;
    kind: string;
    localeCode: string | null;
    tlsStatus: string;
  }
>({
  name: "list_domains",
  description:
    "List the site's domains (hostname, kind, locale, TLS status). Domain changes go through propose_add_domain / propose_remove_domain (Owner-approved). " +
    "The `## Domains` context block is a snapshot from turn start.",
  opName: "domains.list",
  input: noInput,
  label: "domains",
  rows: (value) =>
    (
      value as {
        domains: { hostname: string; kind: string; localeCode: string | null; tlsStatus: string }[];
      }
    ).domains,
  columns: [
    { key: "hostname", value: (d) => d.hostname },
    { key: "kind", value: (d) => d.kind },
    { key: "locale", value: (d) => d.localeCode ?? "" },
    { key: "tls", value: (d) => d.tlsStatus },
  ],
  emptyMessage: "No domains configured.",
});
