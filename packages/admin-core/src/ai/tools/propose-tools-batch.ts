// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.31 — AI tool wrappers for the propose/execute pairs shipped in
 * v0.2.20 → v0.2.30. Each domain gets:
 *  - one tool per propose op (which becomes a chat-runner-callable
 *    surface for the AI),
 *  - using the makeProposeTool factory for shared boilerplate.
 *
 * Bundling all 9 domains into one file keeps the per-domain stanza
 * compact (~10-25 LOC each) and makes it easy to grep for the
 * complete propose-tool catalogue.
 *
 * Domains covered:
 *   layouts, users, roles, snapshots.revert_*,
 *   email_config, ai_providers, mcp_tokens, templates, domains.
 *
 * Pre-existing propose tools NOT in this file (their per-domain files
 * still exist):
 *   deploy.{promote,rollback}        — propose-deploy-promote.ts
 *   imports.create_run               — propose-site-import.ts
 *   skills.create                    — propose-skill.ts
 *   plugins.submit                   — submit-plugin.ts
 *   gateway.rate_limit               — tune-rate-limit.ts
 *   ai_memory.set                    — site-memory-propose.ts
 */

import { pageTypeSlugSchema, sourceTextArg } from "@caelo-cms/shared";
import { z } from "zod";
import { boundedThemeDocument } from "../../theme-document-input.js";
import {
  ANCHOR_HUE_HINTS,
  DEPTH_AND_SURFACE_HINTS,
  SPACING_RHYTHM_HINTS,
  THEME_DOCUMENT_SKELETON,
  TOKEN_ROLE_HINTS,
  TOKEN_SHAPE_HINTS,
  TYPOGRAPHY_COMPOSITION_HINTS,
} from "../theme-guidance.js";
import { makeProposeTool } from "./_make-propose-tool.js";

const uuid = z.string().uuid();

// ─── layouts ─────────────────────────────────────────────────────────

// NB: no `propose_create_layout` here. Layout-create is offered to the AI as
// the dedicated `create_layout` tool (ai/tools/create-layout.ts), which wraps
// the SAME `layouts.propose_create` op but carries the required `blocks[]`
// (block-set metadata) that this batch shape lacked. Two tools for one gated
// action — with divergent schemas (blocks vs no-blocks) — was pure catalogue
// confusion + wasted schema tokens, so the blockless duplicate is dropped.
// The update/delete/set_blocks propose tools below stay.

export const proposeLayoutUpdateTool = makeProposeTool({
  toolName: "propose_update_layout",
  opName: "layouts.propose_update",
  pendingQueuePath: "/settings/layouts/pending",
  when:
    "Propose a layout edit (`html`, `css`, `displayName` and/or `blocks`) in ONE proposal; cascades to every page on every bound template. New layout -> `create_layout`.\n" +
    'CORE RULES: send `html` + `blocks` together (atomic). Every block `name` needs a matching `<caelo-slot name="<name>"></caelo-slot>` in `html`; the set MUST include `content`.',
  schema: z
    .object({
      layoutId: uuid,
      displayName: z.string().min(1).max(200).optional(),
      html: sourceTextArg(z.string().max(50_000)).optional(),
      css: sourceTextArg(z.string().max(50_000)).optional(),
      blocks: z
        .array(
          z.object({
            name: z.string().min(1).max(80),
            displayName: z.string().min(1).max(200),
            position: z.number().int().min(0).max(1000),
          }),
        )
        .min(1)
        .max(20)
        .optional(),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["layoutId"],
    properties: {
      layoutId: { type: "string", format: "uuid" },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      html: { type: "string", maxLength: 50_000 },
      css: { type: "string", maxLength: 50_000 },
      blocks: {
        type: "array",
        description:
          "REPLACES the layout's block-set atomically with the html/css edit; omit to keep it.",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "displayName", "position"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            displayName: { type: "string", minLength: 1, maxLength: 200 },
            position: { type: "integer", minimum: 0, maximum: 1000 },
          },
        },
      },
    },
  },
  summarize: (_input, preview) =>
    `update layout (affects ${preview.affectedPageCount ?? "?"} pages)`,
});

export const proposeLayoutDeleteTool = makeProposeTool({
  toolName: "propose_delete_layout",
  opName: "layouts.propose_delete",
  pendingQueuePath: "/settings/layouts/pending",
  when: "Propose deleting a layout; bound templates re-bind to the site's default layout.",
  schema: z.object({ layoutId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["layoutId"],
    properties: { layoutId: { type: "string", format: "uuid" } },
  },
  summarize: (_input, preview) =>
    `delete layout "${preview.slug ?? "?"}" (${preview.affectedTemplateCount ?? "?"} templates re-bind)`,
});

// NB: no `propose_set_layout_blocks` AI tool. Redefining a layout's block-set
// is now folded into `propose_update_layout` via its optional `blocks[]` (send
// html + blocks in ONE proposal, exactly like propose_update_template). One
// tool, one atomic proposal — no separate blockset tool with a divergent
// (position-less) schema. The underlying `layouts.propose_set_blocks` op stays
// for the panel UI + the execute path.

// ─── users ───────────────────────────────────────────────────────────

/**
 * #390 — the generic URL-migration gate. The AI (or an activation flow)
 * proposes; the diff engine computes the blast radius from the
 * MATERIALIZED current_path column, so this works even when the plugin
 * that caused the change is already gone.
 */

/**
 * #393 — the gated uninstall. Data loss is explicit in the preview
 * (both plugin schemas are DROPPED); the Owner approves in-chat.
 */
export const proposeUninstallPluginTool = makeProposeTool({
  toolName: "propose_uninstall_plugin",
  opName: "plugins.propose_uninstall",
  pendingQueuePath: "/settings/plugins/pending",
  when:
    "Propose PERMANENTLY uninstalling a plugin: drops its cms_public + cms_admin schemas (all plugin data), removes its tools/workers/skills, moves pages whose URLs it reshaped back with 301s. " +
    "A temporary stop that keeps the data is the Owner's disable (Settings -> Plugins), not this tool.",
  schema: z
    .object({
      slug: z.string().min(1).max(120),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug"],
    properties: {
      slug: { type: "string", minLength: 1, maxLength: 120 },
      reason: { type: "string", maxLength: 500 },
    },
  },
  summarize: (input) => `uninstall plugin ${input.slug} (drops its data)`,
});

export const proposeUrlMigrationTool = makeProposeTool({
  toolName: "propose_url_migration",
  opName: "url_migrations.propose_migrate",
  pendingQueuePath: "/settings/url_migrations/pending",
  when:
    "Propose migrating every page whose public URL no longer matches the active URL contributions (after a URL plugin was activated, deactivated or reconfigured). " +
    "Preview = old->new path diff + redirect fan-out. Error 'no URL changes' = success (nothing to migrate); do NOT retry.",
  schema: z.object({ reason: z.string().max(500).optional() }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reason: { type: "string", maxLength: 500 },
    },
  },
  summarize: (input) => `migrate page URLs${input.reason ? ` — ${input.reason}` : ""}`,
});

export const proposeUserCreateTool = makeProposeTool({
  toolName: "propose_create_user",
  afterApply: "sync-operator-access",
  producesCredential: "user_temporary_password",
  opName: "users.propose_create",
  pendingQueuePath: "/settings/users/pending",
  when:
    "Propose inviting a user to the CMS (never pass a password).\n" +
    "CORE RULES (Google Cloud installs): approval also admits the email through Google IAP (browser + MCP) -> use the person's Google account address (Gmail/Workspace); a non-Google address is created but CANNOT sign in. Uncheckable before approval: result `operatorAccess` reports the sync, `operatorAccess.refusedMembers` lists addresses without a Google account -> relay any `warning`, ask for the Google address. " +
    "An address outside the project's Google organisation is refused until the Owner sets up Google sign-in (Settings -> Google sign-in, human-only console step): relay that error's next step; do not retry or propose another address.",
  schema: z
    .object({
      email: z.string().email().max(254),
      displayName: z.string().min(1).max(128),
      roleNames: z.array(z.string()).default([]),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["email", "displayName"],
    properties: {
      email: { type: "string", format: "email", maxLength: 254 },
      displayName: { type: "string", minLength: 1, maxLength: 128 },
      roleNames: { type: "array", items: { type: "string" } },
    },
  },
  summarize: (input) => `invite ${input.email} as ${input.roleNames.join("+") || "(no role)"}`,
});

export const proposeUserSetRolesTool = makeProposeTool({
  toolName: "propose_set_user_roles",
  afterApply: "sync-operator-access",
  opName: "users.propose_set_roles",
  pendingQueuePath: "/settings/users/pending",
  when: "Propose replacing a user's roles (e.g. promote to Owner, demote to Editor). Empty list also removes their Google IAP access on Google Cloud; relay any result `warning`.",
  schema: z.object({ userId: uuid, roleNames: z.array(z.string()) }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["userId", "roleNames"],
    properties: {
      userId: { type: "string", format: "uuid" },
      roleNames: { type: "array", items: { type: "string" } },
    },
  },
  summarize: (input) =>
    `set roles to ${input.roleNames.join("+") || "(empty)"} for user ${input.userId}`,
});

export const proposeUserDeleteTool = makeProposeTool({
  toolName: "propose_delete_user",
  afterApply: "sync-operator-access",
  opName: "users.propose_delete",
  pendingQueuePath: "/settings/users/pending",
  when: "Propose soft-deleting a user. The first Owner cannot be deleted (promote another Owner first). On Google Cloud also removes their IAP + MCP access; relay any result `warning`.",
  schema: z.object({ userId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["userId"],
    properties: { userId: { type: "string", format: "uuid" } },
  },
  summarize: (_input, preview) => `delete user ${preview.email ?? "?"}`,
});

// ─── roles ───────────────────────────────────────────────────────────

export const proposeRoleCreateTool = makeProposeTool({
  toolName: "propose_create_role",
  opName: "roles.propose_create",
  pendingQueuePath: "/settings/roles/pending",
  when: "Propose a custom role with a permission set; built-in names (owner/editor/reviewer) are reserved.",
  schema: z
    .object({
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9_-]*$/, "lowercase, digits, _ or -"),
      description: z.string().max(500).default(""),
      permissions: z.array(z.string()).default([]),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_-]*$" },
      description: { type: "string", maxLength: 500 },
      permissions: { type: "array", items: { type: "string" } },
    },
  },
  summarize: (input) => `create role "${input.name}" (${input.permissions.length} permissions)`,
});

export const proposeRoleUpdatePermissionsTool = makeProposeTool({
  toolName: "propose_update_role_permissions",
  opName: "roles.propose_update_permissions",
  pendingQueuePath: "/settings/roles/pending",
  when: "Propose replacing a role's permissions (full list; not the owner role); hits all its users.",
  schema: z.object({ roleId: uuid, permissions: z.array(z.string()) }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["roleId", "permissions"],
    properties: {
      roleId: { type: "string", format: "uuid" },
      permissions: { type: "array", items: { type: "string" } },
    },
  },
  summarize: (_input, preview) =>
    `update permissions on role "${preview.roleName ?? "?"}" (added: ${(preview.added as string[] | undefined)?.length ?? 0}, removed: ${(preview.removed as string[] | undefined)?.length ?? 0})`,
});

export const proposeRoleDeleteTool = makeProposeTool({
  toolName: "propose_delete_role",
  afterApply: "sync-operator-access",
  opName: "roles.propose_delete",
  pendingQueuePath: "/settings/roles/pending",
  when: "Propose deleting a custom role (built-ins cannot be); its users lose those permissions. On Google Cloud anyone left with no role loses IAP access; relay any result `warning`.",
  schema: z.object({ roleId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["roleId"],
    properties: { roleId: { type: "string", format: "uuid" } },
  },
  summarize: (_input, preview) =>
    `delete role "${preview.roleName ?? "?"}" (${preview.affectedUserCount ?? "?"} users affected)`,
});

// ─── snapshots.revert_* ──────────────────────────────────────────────

export const proposeRevertSiteTool = makeProposeTool({
  toolName: "propose_revert_site",
  opName: "snapshots.propose_revert_site",
  pendingQueuePath: "/settings/snapshots/pending",
  when: "Propose rewinding the ENTIRE site to a snapshot: highest blast radius (every module/page/template with rows in it). Narrower undo -> `propose_revert_page` | `propose_revert_module`.",
  schema: z.object({ snapshotId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["snapshotId"],
    properties: { snapshotId: { type: "string", format: "uuid" } },
  },
  summarize: (_input, preview) =>
    `revert site to snapshot from ${preview.snapshotCreatedAt ?? "?"} (${preview.affectedEntityCount ?? "?"} entities)`,
});

export const proposeRevertPageTool = makeProposeTool({
  toolName: "propose_revert_page",
  opName: "snapshots.propose_revert_page",
  pendingQueuePath: "/settings/snapshots/pending",
  when: "Propose rewinding one page (metadata + module composition) to a snapshot.",
  schema: z.object({ pageId: uuid, snapshotId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "snapshotId"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      snapshotId: { type: "string", format: "uuid" },
    },
  },
  summarize: (_input, preview) =>
    `revert page "${preview.pageSlug ?? "?"}" to snapshot from ${preview.snapshotCreatedAt ?? "?"}`,
});

export const proposeRevertTemplateTool = makeProposeTool({
  toolName: "propose_revert_template",
  opName: "snapshots.propose_revert_template",
  pendingQueuePath: "/settings/snapshots/pending",
  when: "Propose rewinding a template (HTML/CSS/blocks) to a snapshot; re-renders every bound page.",
  schema: z.object({ templateId: uuid, snapshotId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["templateId", "snapshotId"],
    properties: {
      templateId: { type: "string", format: "uuid" },
      snapshotId: { type: "string", format: "uuid" },
    },
  },
  summarize: (_input, preview) =>
    `revert template "${preview.templateSlug ?? "?"}" (${preview.affectedPageCount ?? "?"} bound pages)`,
});

export const proposeRevertModuleTool = makeProposeTool({
  toolName: "propose_revert_module",
  opName: "snapshots.propose_revert_module",
  pendingQueuePath: "/settings/snapshots/pending",
  when: "Propose rewinding one module to a snapshot (smallest-scope revert).",
  schema: z.object({ moduleId: uuid, snapshotId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["moduleId", "snapshotId"],
    properties: {
      moduleId: { type: "string", format: "uuid" },
      snapshotId: { type: "string", format: "uuid" },
    },
  },
  summarize: (_input, preview) => `revert module "${preview.moduleSlug ?? "?"}"`,
});

// ─── email_config ────────────────────────────────────────────────────

export const proposeEmailConfigSetTool = makeProposeTool({
  toolName: "propose_set_email_config",
  opName: "email_config.propose_set",
  pendingQueuePath: "/settings/email/pending",
  when: "Propose changing the site's email transport. NEVER put credentials in `config` (secret-shaped fields are rejected); the Owner pastes the SMTP password / Resend key / SES keys at approval. Verify afterwards with `send_test_email`.",
  schema: z
    .object({
      transport: z.enum(["none", "smtp", "resend", "ses"]),
      fromAddress: z.string().max(254),
      config: z.record(z.string(), z.unknown()),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["transport", "fromAddress", "config"],
    properties: {
      transport: { type: "string", enum: ["none", "smtp", "resend", "ses"] },
      fromAddress: { type: "string", maxLength: 254 },
      config: { type: "object", additionalProperties: true },
    },
  },
  summarize: (input) => `switch email transport to ${input.transport} (from: ${input.fromAddress})`,
});

// ─── ai_providers ────────────────────────────────────────────────────

export const proposeAiProvidersSetTool = makeProposeTool({
  toolName: "propose_set_ai_provider",
  opName: "ai_providers.propose_set",
  pendingQueuePath: "/settings/ai/pending",
  when: "Propose adding/updating an AI provider config. NEVER include an apiKey: the Owner pastes it at approval when none is stored; edits without a new key keep the stored one.",
  schema: z
    .object({
      name: z.enum(["anthropic", "openai", "google", "local-openai-compat"]),
      displayName: z.string().min(1).max(100),
      config: z.record(z.string(), z.unknown()).default({}),
      isActive: z.boolean().default(true),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "displayName"],
    properties: {
      name: { type: "string", enum: ["anthropic", "openai", "google", "local-openai-compat"] },
      displayName: { type: "string", minLength: 1, maxLength: 100 },
      config: { type: "object", additionalProperties: true },
      isActive: { type: "boolean" },
    },
  },
  summarize: (input) => `set provider "${input.name}" (active=${input.isActive ?? true})`,
});

export const proposeAiProvidersClearKeyTool = makeProposeTool({
  toolName: "propose_clear_ai_provider_key",
  opName: "ai_providers.propose_clear_key",
  pendingQueuePath: "/settings/ai/pending",
  when: "Propose clearing one provider's stored API key; it then uses the env var, if any.",
  schema: z
    .object({ name: z.enum(["anthropic", "openai", "google", "local-openai-compat"]) })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", enum: ["anthropic", "openai", "google", "local-openai-compat"] },
    },
  },
  summarize: (input) => `clear stored key for "${input.name}"`,
});

// ─── mcp_tokens ──────────────────────────────────────────────────────

export const proposeMcpTokenCreateTool = makeProposeTool({
  toolName: "propose_create_mcp_token",
  opName: "mcp_tokens.propose_create",
  pendingQueuePath: "/settings/mcp/pending",
  when:
    "Propose minting an MCP bearer token. `scope`: `chat` (default) = `caelo_chat` surface; `admin` also unlocks the Power-MCP tools for external agents. " +
    "`allowCaeloAi` (admin only, default false) lets that agent spend the install's own AI (image generation, Caelo-side translation); leave off unless the operator asks (the agent then uses its own subscription).",
  producesCredential: "mcp_token",
  schema: z
    .object({
      displayName: z.string().min(1).max(100),
      scope: z.enum(["chat", "admin"]).optional(),
      aiCostCapMicrocents: z.number().int().nonnegative().nullable().optional(),
      allowCaeloAi: z.boolean().optional(),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["displayName"],
    properties: {
      displayName: { type: "string", minLength: 1, maxLength: 100 },
      scope: { type: "string", enum: ["chat", "admin"] },
      aiCostCapMicrocents: { type: "integer", minimum: 0, nullable: true },
      allowCaeloAi: { type: "boolean" },
    },
  },
  summarize: (input) =>
    `mint MCP token "${input.displayName}" (scope: ${input.scope ?? "chat"}${input.allowCaeloAi ? ", may use Caelo's AI" : ""})`,
});

export const proposeMcpTokenRevokeTool = makeProposeTool({
  toolName: "propose_revoke_mcp_token",
  opName: "mcp_tokens.propose_revoke",
  pendingQueuePath: "/settings/mcp/pending",
  when: "Propose revoking an MCP token (already-revoked ones are rejected). In an Owner's chat any user's token can be named; otherwise only the chatting user's own tokens are visible (another's id -> not found).",
  schema: z.object({ tokenId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tokenId"],
    properties: { tokenId: { type: "string", format: "uuid" } },
  },
  summarize: (_input, preview) => `revoke MCP token "${preview.displayName ?? "?"}"`,
});

// ─── templates ───────────────────────────────────────────────────────

export const proposeTemplateUpdateTool = makeProposeTool({
  toolName: "propose_update_template",
  opName: "templates.propose_update",
  pendingQueuePath: "/settings/templates/pending",
  when:
    "Propose updating a template (`html`, `css`, `displayName`, `layoutId`, `pageType` and/or `blocks`); re-renders every bound page (preview shows the count). Layout only -> `set_template_layout`.\n" +
    'CORE RULES: every block in `blocks` needs a matching `<caelo-slot name="<blockName>"></caelo-slot>` TAG in `html` (never an HTML comment), else its modules have nowhere to render and the page is empty between header and footer. Send `html` + `blocks` together (atomic).',
  schema: z
    .object({
      templateId: uuid,
      displayName: z.string().min(1).max(200).optional(),
      html: sourceTextArg(z.string()).optional(),
      css: sourceTextArg(z.string()).optional(),
      layoutId: uuid.optional(),
      pageType: pageTypeSlugSchema.optional(),
      blocks: z
        .array(
          z.object({
            name: z.string().min(1).max(64),
            displayName: z.string().min(1).max(200),
            position: z.number().int().nonnegative(),
          }),
        )
        .optional(),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["templateId"],
    properties: {
      templateId: { type: "string", format: "uuid" },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      html: {
        type: "string",
      },
      css: { type: "string" },
      layoutId: { type: "string", format: "uuid" },
      pageType: {
        type: "string",
        pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
        description: "Also allow this template for this page type (slug from `list_page_types`).",
      },
      blocks: {
        type: "array",
        description: "REPLACES the block set atomically; omit to keep it.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "displayName", "position"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 64 },
            displayName: { type: "string", minLength: 1, maxLength: 200 },
            position: { type: "integer", minimum: 0 },
          },
        },
      },
    },
  },
  summarize: (_input, preview) =>
    `update template "${preview.templateSlug ?? "?"}" (${preview.affectedPageCount ?? "?"} bound pages)`,
});

export const proposeTemplateDeleteTool = makeProposeTool({
  toolName: "propose_delete_template",
  opName: "templates.propose_delete",
  pendingQueuePath: "/settings/templates/pending",
  when: "Propose deleting a template; every bound page is orphaned (preview shows count + sample slugs).",
  schema: z.object({ templateId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["templateId"],
    properties: { templateId: { type: "string", format: "uuid" } },
  },
  summarize: (_input, preview) =>
    `delete template "${preview.templateSlug ?? "?"}" (${preview.affectedPageCount ?? "?"} pages orphaned)`,
});

// ─── domains ─────────────────────────────────────────────────────────

export const proposeDomainAddTool = makeProposeTool({
  toolName: "propose_add_domain",
  opName: "domains.propose_add",
  pendingQueuePath: "/settings/domains/pending",
  when: "Propose registering a custom domain; approval regenerates Caddy on next deploy + ACME issues TLS. After approval check resolution with `verify_domains`.",
  schema: z
    .object({
      hostname: z.string().min(1).max(253),
      kind: z.enum(["admin", "public"]),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["hostname", "kind"],
    properties: {
      hostname: { type: "string", minLength: 1, maxLength: 253 },
      kind: { type: "string", enum: ["admin", "public"] },
    },
  },
  summarize: (input) => `add ${input.kind} domain "${input.hostname}"`,
});

export const proposeDomainRemoveTool = makeProposeTool({
  toolName: "propose_remove_domain",
  opName: "domains.propose_remove",
  pendingQueuePath: "/settings/domains/pending",
  when: "Propose removing a registered domain; approval drops its Caddy vhost on next deploy (visitors get 404 until DNS is re-pointed).",
  schema: z.object({ domainId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["domainId"],
    properties: { domainId: { type: "string", format: "uuid" } },
  },
  summarize: (_input, preview) => `remove domain "${preview.hostname ?? "?"}"`,
});

export const proposeDomainReconnectTool = makeProposeTool({
  toolName: "propose_reconnect_domain",
  opName: "domains.propose_reconnect",
  pendingQueuePath: "/settings/domains/pending",
  when:
    "Heal a Firebase Hosting custom domain that `list_domains` / `verify_domains` reports 'stuck' (all DNS records in place, yet Firebase shows HOST_MISMATCH / OWNERSHIP_PENDING and stopped re-checking -> visitors get \"Site Not Found\"). " +
    "Approval deletes + re-creates the domain so Firebase verifies afresh (nothing goes offline; it is not serving yet); once active, Caelo re-releases the live version to clear the CDN's cached 404. " +
    "Also restores a domain reported 'deleted' unintentionally (e.g. interrupted reconnect); ask the operator first, a deletion may be deliberate.\n" +
    "DO NOT USE FOR a domain still waiting for DNS (tell the operator which records to add). Refused for an active domain.",
  schema: z.object({ hostname: z.string().min(1).max(253) }).strict(),
  summarize: (input, preview) =>
    `reconnect hosting domain "${input.hostname}" (${preview.hostState ?? "?"} / ${preview.ownershipState ?? "?"})`,
});

// ─── themes (v0.11.0, #45) ───────────────────────────────────────────

export const proposeCreateThemeTool = makeProposeTool({
  toolName: "propose_create_theme",
  opName: "themes.propose_create",
  pendingQueuePath: "/settings/themes/pending",
  when:
    "Create a theme from a DTCG token document YOU COMPOSE from the brand context (site identity, operator wording, industry, upcoming content); no presets. " +
    "Clone an existing theme -> `duplicate_theme`; tweak tokens -> `set_theme_tokens`.",
  schema: z
    .object({
      slug: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-z0-9][a-z0-9-]*$/),
      displayName: z.string().min(1).max(200),
      description: z.string().min(1).max(1000),
      tokens: boundedThemeDocument,
      overrides: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "displayName", "description", "tokens"],
    properties: {
      slug: { type: "string", minLength: 1, maxLength: 120 },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      description: {
        type: "string",
        minLength: 1,
        maxLength: 1000,
        description: "WHY this palette fits the brand (read by the cold-start gate).",
      },
      // Full DTCG can't be expressed in provider JSON Schema — the Zod
      // boundary (shared `themeDocument`) does the real validation, so the
      // composition guidance rides on this property's description.
      tokens: {
        type: "object",
        additionalProperties: true,
        description:
          `Complete DTCG document, every category: ${THEME_DOCUMENT_SKELETON}; each leaf \`{$type, $value}\`. ` +
          `Primary with real chroma fitting the brand; do NOT default to neutral/grayscale on a real site. Anchors: ${ANCHOR_HUE_HINTS}. ` +
          `${DEPTH_AND_SURFACE_HINTS} ${TOKEN_SHAPE_HINTS} ${SPACING_RHYTHM_HINTS} ${TOKEN_ROLE_HINTS} ${TYPOGRAPHY_COMPOSITION_HINTS}`,
      },
      overrides: {
        type: "object",
        additionalProperties: true,
        description:
          "`primaryColor` -> server derives a 50–900 OKLCh lightness ramp (stops marked `_derived: true`); explicit stops (`\"color.primary.500\": '#…'`) win.",
      },
    },
  },
  summarize: (input) =>
    `create theme "${input.displayName}" (${input.slug}) from an AI-composed token document`,
});

export const proposeActivateThemeTool = makeProposeTool({
  toolName: "propose_activate_theme",
  opName: "themes.propose_activate",
  pendingQueuePath: "/settings/themes/pending",
  when: "Switch the site's active theme. Approval flips the DB row only; the live site keeps the old theme's CSS until `propose_deploy_promote` is also approved: tell the operator both steps are needed.",
  schema: z.object({ themeId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["themeId"],
    properties: { themeId: { type: "string", format: "uuid" } },
  },
  summarize: (_input, preview) =>
    `activate "${preview.targetSlug ?? "?"}" (replaces "${preview.currentActiveSlug ?? "none"}")`,
});

export const proposeDeleteThemeTool = makeProposeTool({
  toolName: "propose_delete_theme",
  opName: "themes.propose_delete",
  pendingQueuePath: "/settings/themes/pending",
  when: "Delete an inactive theme (the active one is rejected: `propose_activate_theme` another first).",
  schema: z.object({ themeId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["themeId"],
    properties: { themeId: { type: "string", format: "uuid" } },
  },
  summarize: (_input, preview) => `delete theme "${preview.slug ?? "?"}"`,
});
