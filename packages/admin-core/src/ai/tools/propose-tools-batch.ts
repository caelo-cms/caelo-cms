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
 *   layouts, users, roles, snapshots.revert_*, experiments,
 *   email_config, ai_providers, mcp_tokens, templates, domains.
 *
 * Pre-existing propose tools NOT in this file (their per-domain files
 * still exist):
 *   deploy.{promote,rollback}        — propose-deploy-promote.ts
 *   locales.{create,delete,...}      — propose-{add,remove,...}-locale.ts
 *   imports.create_run               — propose-site-import.ts
 *   skills.create                    — propose-skill.ts
 *   plugins.submit                   — submit-plugin.ts
 *   gateway.rate_limit               — tune-rate-limit.ts
 *   ai_memory.set                    — site-memory-propose.ts
 */

import { z } from "zod";
import { boundedThemeDocument } from "../../theme-document-input.js";
import {
  ANCHOR_HUE_HINTS,
  DEPTH_AND_SURFACE_HINTS,
  TOKEN_SHAPE_HINTS,
  THEME_DOCUMENT_SKELETON,
} from "../theme-guidance.js";
import { makeProposeTool } from "./_make-propose-tool.js";

const uuid = z.string().uuid();

// ─── layouts ─────────────────────────────────────────────────────────

export const proposeLayoutCreateTool = makeProposeTool({
  toolName: "propose_create_layout",
  opName: "layouts.propose_create",
  pendingQueuePath: "/security/layouts/pending",
  when:
    "Propose a new site-wide layout (chrome shared across templates: header, footer, navigation). " +
    "Use when the operator describes a new shell that will host multiple templates.",
  schema: z
    .object({
      slug: z.string().min(1).max(120),
      displayName: z.string().min(1).max(200),
      html: z.string().max(50_000),
      css: z.string().max(50_000).optional(),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "displayName", "html"],
    properties: {
      slug: { type: "string", minLength: 1, maxLength: 120 },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      html: { type: "string", maxLength: 50_000 },
      css: { type: "string", maxLength: 50_000 },
    },
  },
  summarize: (input) => `create layout "${input.displayName}" (${input.slug})`,
});

export const proposeLayoutUpdateTool = makeProposeTool({
  toolName: "propose_update_layout",
  opName: "layouts.propose_update",
  pendingQueuePath: "/security/layouts/pending",
  when: "Propose an HTML/CSS/displayName edit to an existing layout. The change cascades to every page on every bound template.",
  schema: z
    .object({
      layoutId: uuid,
      displayName: z.string().min(1).max(200).optional(),
      html: z.string().max(50_000).optional(),
      css: z.string().max(50_000).optional(),
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
    },
  },
  summarize: (_input, preview) =>
    `update layout (affects ${preview.affectedPageCount ?? "?"} pages)`,
});

export const proposeLayoutDeleteTool = makeProposeTool({
  toolName: "propose_delete_layout",
  opName: "layouts.propose_delete",
  pendingQueuePath: "/security/layouts/pending",
  when: "Propose deleting a layout. Bound templates re-bind to site_defaults.default_layout_id.",
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

export const proposeLayoutSetBlocksTool = makeProposeTool({
  toolName: "propose_set_layout_blocks",
  opName: "layouts.propose_set_blocks",
  pendingQueuePath: "/security/layouts/pending",
  when: "Propose redefining the named slots/blocks in a layout. Module references in those slots may need re-binding.",
  schema: z
    .object({
      layoutId: uuid,
      blocks: z.array(z.object({ name: z.string(), displayName: z.string() })),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["layoutId", "blocks"],
    properties: {
      layoutId: { type: "string", format: "uuid" },
      blocks: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "displayName"],
          properties: {
            name: { type: "string" },
            displayName: { type: "string" },
          },
        },
      },
    },
  },
  summarize: (input) => `set ${input.blocks.length} layout blocks`,
});

// ─── users ───────────────────────────────────────────────────────────

export const proposeUserCreateTool = makeProposeTool({
  toolName: "propose_create_user",
  opName: "users.propose_create",
  pendingQueuePath: "/security/users/pending",
  when:
    "Propose inviting a new user to the CMS. Provide email + displayName + roleNames. " +
    "DO NOT include a password — the Owner approves and a one-time temporary password is generated server-side.",
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
  opName: "users.propose_set_roles",
  pendingQueuePath: "/security/users/pending",
  when: "Propose changing an existing user's role assignments (e.g. promote to Owner, demote to Editor).",
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
    `set roles to ${input.roleNames.join("+") || "(empty)"} for user ${input.userId.slice(0, 8)}`,
});

export const proposeUserDeleteTool = makeProposeTool({
  toolName: "propose_delete_user",
  opName: "users.propose_delete",
  pendingQueuePath: "/security/users/pending",
  when: "Propose soft-deleting a user. The first Owner cannot be deleted; promote another Owner first.",
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
  pendingQueuePath: "/security/roles/pending",
  when: "Propose a new custom role with a permission set. Built-in role names (owner/editor/reviewer) are reserved.",
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
  pendingQueuePath: "/security/roles/pending",
  when: "Propose adding or removing permissions from an existing role. The change applies to every user holding that role.",
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
  opName: "roles.propose_delete",
  pendingQueuePath: "/security/roles/pending",
  when: "Propose deleting a custom role. Built-in roles cannot be deleted; users in the deleted role lose those permissions.",
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
  pendingQueuePath: "/security/snapshots/pending",
  when:
    "Propose rewinding the entire site to a previous snapshot. " +
    "HIGHEST blast radius — affects every module/page/template that has rows in the target snapshot. " +
    "Prefer revert_page or revert_module when the operator only needs a narrower undo.",
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
  pendingQueuePath: "/security/snapshots/pending",
  when: "Propose rewinding a single page (metadata + module composition) to a previous snapshot.",
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
  pendingQueuePath: "/security/snapshots/pending",
  when: "Propose rewinding a template (HTML/CSS/blocks) to a previous snapshot. Re-renders every page bound to it.",
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
  pendingQueuePath: "/security/snapshots/pending",
  when: "Propose rewinding a single module to a previous snapshot. Smallest-scope revert.",
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

// ─── experiments ─────────────────────────────────────────────────────

export const proposeExperimentActivateTool = makeProposeTool({
  toolName: "propose_activate_experiment",
  opName: "experiments.propose_activate",
  pendingQueuePath: "/security/experiments/pending",
  when:
    "Propose activating a draft A/B experiment so it starts assigning real visitor traffic. " +
    "Use AFTER experiments.create has minted the draft.",
  schema: z.object({ experimentId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["experimentId"],
    properties: { experimentId: { type: "string", format: "uuid" } },
  },
  summarize: (_input, preview) =>
    `activate experiment "${preview.experimentSlug ?? "?"}" on ${preview.pageSlug ?? "?"}`,
});

export const proposeExperimentCompleteTool = makeProposeTool({
  toolName: "propose_complete_experiment",
  opName: "experiments.propose_complete",
  pendingQueuePath: "/security/experiments/pending",
  when:
    "Propose completing an active experiment. Pass winningVariant when there's a clear winner — " +
    "the propose handler validates the label against actual variants and surfaces per-variant assignment counts in the preview.",
  schema: z
    .object({
      experimentId: uuid,
      winningVariant: z.string().min(1).max(120).optional(),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["experimentId"],
    properties: {
      experimentId: { type: "string", format: "uuid" },
      winningVariant: { type: "string", minLength: 1, maxLength: 120 },
    },
  },
  summarize: (input, preview) =>
    `complete experiment "${preview.experimentSlug ?? "?"}"` +
    (input.winningVariant ? ` (winner: ${input.winningVariant})` : ""),
});

// ─── email_config ────────────────────────────────────────────────────

export const proposeEmailConfigSetTool = makeProposeTool({
  toolName: "propose_set_email_config",
  opName: "email_config.propose_set",
  pendingQueuePath: "/security/email/pending",
  when:
    "Propose changing the site's email transport (smtp / resend / ses / none). " +
    "DO NOT include credential material in config — the Owner pastes the SMTP password / Resend API key / SES keys " +
    "inline at approve time. The propose handler rejects payloads carrying secret-shaped fields.",
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
  pendingQueuePath: "/security/ai/pending",
  when:
    "Propose adding/updating an AI provider config (anthropic / openai / google / local-openai-compat). " +
    "DO NOT include apiKey — the Owner pastes it inline at approve time when no stored key exists. " +
    "Existing-provider edits without a new key preserve the encrypted blob.",
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
  pendingQueuePath: "/security/ai/pending",
  when: "Propose clearing the stored API key for one provider. Falls back to env-var or null source.",
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
  pendingQueuePath: "/security/mcp/pending",
  when:
    "Propose minting a new MCP bearer token. Pass displayName + optional aiCostCapMicrocents. " +
    "Token plaintext is generated server-side at approve time and shown ONCE in the Owner UI banner.",
  schema: z
    .object({
      displayName: z.string().min(1).max(100),
      aiCostCapMicrocents: z.number().int().nonnegative().nullable().optional(),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["displayName"],
    properties: {
      displayName: { type: "string", minLength: 1, maxLength: 100 },
      aiCostCapMicrocents: { type: "integer", minimum: 0, nullable: true },
    },
  },
  summarize: (input) => `mint MCP token "${input.displayName}"`,
});

export const proposeMcpTokenRevokeTool = makeProposeTool({
  toolName: "propose_revoke_mcp_token",
  opName: "mcp_tokens.propose_revoke",
  pendingQueuePath: "/security/mcp/pending",
  when: "Propose revoking an existing MCP token. Already-revoked tokens are rejected at queue time.",
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
  pendingQueuePath: "/security/templates/pending",
  when:
    "Propose updating a template's HTML/CSS/displayName/layoutId AND/OR " +
    "the block-set (template_blocks). Re-renders every page bound to the " +
    "template — preview shows the count. " +
    "CRITICAL — block syntax: in `html`, render-slot markers MUST be " +
    '`<caelo-slot name="X"></caelo-slot>` tags, NOT HTML comments. ' +
    "Every block declared in `blocks` needs a matching `<caelo-slot " +
    'name="<blockName>"></caelo-slot>` in `html` for the renderer to ' +
    "inject the page's modules into it. Without the caelo-slot tag the " +
    "modules attach to the right block name in the DB but the renderer " +
    "has nowhere to put them and the page renders empty between header " +
    "and footer. Send html + blocks together in ONE proposal so they " +
    "apply atomically.",
  schema: z
    .object({
      templateId: uuid,
      displayName: z.string().min(1).max(200).optional(),
      html: z.string().optional(),
      css: z.string().optional(),
      layoutId: uuid.optional(),
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
        description:
          'Template HTML. Render slots use <caelo-slot name="X"></caelo-slot> tags (NOT HTML comments). One slot per block declared in `blocks`.',
      },
      css: { type: "string" },
      layoutId: { type: "string", format: "uuid" },
      blocks: {
        type: "array",
        description:
          'Block-set definition. Each block name must have a matching <caelo-slot name="<name>"></caelo-slot> in `html`. Replaces the existing block set atomically (DELETE-then-INSERT). Omit to leave blocks unchanged.',
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
  pendingQueuePath: "/security/templates/pending",
  when: "Propose deleting a template. Every bound page is orphaned — preview shows the count + a sample of affected page slugs.",
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
  pendingQueuePath: "/security/domains/pending",
  when:
    "Propose registering a new custom domain (admin / public / locale-public). " +
    "Approval triggers cms-provision regenerate-caddy on next deploy + ACME issues TLS. " +
    "Use domains.verify (read-only DNS lookup) BEFORE proposing to confirm the hostname resolves.",
  schema: z
    .object({
      hostname: z.string().min(1).max(253),
      kind: z.enum(["admin", "public", "locale-public"]),
      localeCode: z.string().min(2).max(20).optional(),
    })
    .strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["hostname", "kind"],
    properties: {
      hostname: { type: "string", minLength: 1, maxLength: 253 },
      kind: { type: "string", enum: ["admin", "public", "locale-public"] },
      localeCode: { type: "string", minLength: 2, maxLength: 20 },
    },
  },
  summarize: (input) => `add ${input.kind} domain "${input.hostname}"`,
});

export const proposeDomainRemoveTool = makeProposeTool({
  toolName: "propose_remove_domain",
  opName: "domains.propose_remove",
  pendingQueuePath: "/security/domains/pending",
  when: "Propose removing a registered domain. Approval drops the Caddy vhost on next deploy — visitors hit 404 until DNS is re-pointed.",
  schema: z.object({ domainId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["domainId"],
    properties: { domainId: { type: "string", format: "uuid" } },
  },
  summarize: (_input, preview) => `remove domain "${preview.hostname ?? "?"}"`,
});

// ─── themes (v0.11.0, #45) ───────────────────────────────────────────

export const proposeCreateThemeTool = makeProposeTool({
  toolName: "propose_create_theme",
  opName: "themes.propose_create",
  pendingQueuePath: "/security/themes/pending",
  when:
    "Create a new theme by COMPOSING the complete DTCG token document yourself from the " +
    "brand context you already have (site identity, the operator's wording, the industry, " +
    "the content you're about to write). There are no presets — you author every category: " +
    `\`tokens:\` ${THEME_DOCUMENT_SKELETON} — each ` +
    "leaf is `{$type, $value}` (e.g. `{$type: 'color', $value: '#4f46e5'}`). Pick a primary " +
    "with real chroma that fits the brand; do NOT default to neutral/grayscale on a real " +
    `site. Anchor-hue inspiration: ${ANCHOR_HUE_HINTS}. ${DEPTH_AND_SURFACE_HINTS} ${TOKEN_SHAPE_HINTS} ` +
    "`description` is required — record WHY this palette fits (the cold-start gate " +
    "reads it). If `overrides.primaryColor` is set, the server derives a 50–900 OKLCh " +
    "lightness ramp from it (each stop annotated `_derived: true`); explicit stops via " +
    "`overrides[\"color.primary.500\"] = '#…'` win over derived ones.",
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
      description: { type: "string", minLength: 1, maxLength: 1000 },
      // Full DTCG can't be expressed in provider JSON Schema — the Zod
      // boundary (shared `themeDocument`) does the real validation.
      tokens: { type: "object", additionalProperties: true },
      overrides: { type: "object", additionalProperties: true },
    },
  },
  summarize: (input) =>
    `create theme "${input.displayName}" (${input.slug}) from an AI-composed token document`,
});

export const proposeActivateThemeTool = makeProposeTool({
  toolName: "propose_activate_theme",
  opName: "themes.propose_activate",
  pendingQueuePath: "/security/themes/pending",
  when:
    "Switch the site's active theme. Approving flips the DB row only — the live site keeps " +
    "serving the previously-active theme's CSS until an Owner separately approves " +
    "`propose_deploy_promote`. Tell the operator both steps are needed.",
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
  pendingQueuePath: "/security/themes/pending",
  when:
    "Delete an inactive theme. Active themes are rejected — activate a different theme " +
    "first via `propose_activate_theme`.",
  schema: z.object({ themeId: uuid }).strict(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["themeId"],
    properties: { themeId: { type: "string", format: "uuid" } },
  },
  summarize: (_input, preview) => `delete theme "${preview.slug ?? "?"}"`,
});
