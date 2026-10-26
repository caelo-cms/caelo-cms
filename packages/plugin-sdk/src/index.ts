// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-sdk — Phase 11.
 *
 * The SDK is the contract between Caelo's plugin host and any plugin,
 * Tier 1 or Tier 2. Both tiers import from this single package; the
 * runtime decides which capability handles in `PluginContext` are
 * actually constructed for a given invocation.
 *
 * - Tier 1 (core)  — runs in-process in Bun. Receives `PluginContextTier1`
 *                    with the full set of handles (cms, ai, snapshots,
 *                    tools, workers).
 * - Tier 2 (user)  — runs in a Deno subprocess with --no-read --no-write
 *                    --no-net. Receives `PluginContext` only — the locked
 *                    base shape limited to its own cms_public schema.
 *
 * The validator (in @caelo-cms/plugin-sandbox) walks plugin source and
 * rejects forbidden patterns BEFORE the runtime ever loads the plugin.
 * For Tier 2 the validator gates activation; for Tier 1 it runs at
 * startup as defense-in-depth (signed manifest + validator + Deno
 * flags are three independent safety layers per CMS_REQUIREMENTS §14.5).
 *
 * Zero runtime dependencies beyond Zod. Pure types + Zod schemas + tiny
 * pass-through factory functions. Plugin source MUST import from this
 * module and ONLY this module — the validator enforces it.
 */

import type { FontMetadata, FontRef, PageUrlStyle } from "@caelo-cms/shared";
// The list model only (Zod underneath): the SDK is bundled into the
// plugin sandbox with everything it imports at runtime.
import { type ListTypeDef, listTypeDefSchema, nodeDefSchema } from "@caelo-cms/shared/lists-model";
import { z } from "zod";
import { checkAdminPanels, type PluginAdminPanel, pluginAdminPanel } from "./admin-panels.js";

/**
 * Epic #1107 — the list model a plugin plans with (`docs/lists.md`): the
 * definitions it reads through the `lists` ops, the value addresses its
 * `list-resolve` overlays are keyed by, and the field check core applies
 * to every overlay value. Re-exported for the same reason as `z`.
 */
export type {
  FieldDef,
  ListItem,
  ListTypeDef,
  NodeDef,
  PageTypeDef,
  ValueAddress,
} from "@caelo-cms/shared/lists-model";
export {
  formatValueAddress,
  parseValueAddress,
  validateFieldValue,
} from "@caelo-cms/shared/lists-model";
export * from "./admin-panels.js";
/** Re-exported so plugins can validate at their boundaries (CLAUDE.md
 *  §4 "Zod at every boundary") without importing zod directly — the
 *  sandbox validator allowlists only the SDK + component-kit. */
export { z };

// ---------------------------------------------------------------------------
// Zod schemas — the wire format the validator + host both consume.
// ---------------------------------------------------------------------------

/** Per-column type. Matches the SQL emitter's vocabulary. */
export const pluginColumnType = z.enum([
  "uuid",
  "string",
  "text",
  "int",
  "bool",
  "timestamp",
  "timestamp_nullable",
  "jsonb",
]);

export type PluginColumnType = z.infer<typeof pluginColumnType>;

/**
 * Per-column declaration. A primitive type, an enum:value,value, or —
 * in `adminSchema` ONLY (#389) — a foreign key onto an allowlisted core
 * table: `ref:<table>` / `ref:<table>:cascade` (uuid REFERENCES
 * <table>(id), ON DELETE CASCADE with the suffix). The validator rejects
 * `ref:` columns in the cms_public `schema` (cross-database FKs are
 * impossible) and outside the allowlist.
 */
export const pluginColumnSpec = z
  .string()
  .refine(
    (v) => v.startsWith("enum:") || v.startsWith("ref:") || pluginColumnType.safeParse(v).success,
    {
      message:
        "must be one of uuid|string|text|int|bool|timestamp|jsonb, enum:a,b,c, or ref:<core-table>[:cascade]",
    },
  );

/** Per-table column map. */
export const pluginTableSchema = z.record(z.string(), pluginColumnSpec);

export type PluginTableSchema = z.infer<typeof pluginTableSchema>;

export const pluginSchemaMap = z.record(z.string(), pluginTableSchema);

export type PluginSchemaMap = z.infer<typeof pluginSchemaMap>;

/** Capability requests. Every capability is runtime-enforced; what is
 *  release signature determines origin and execution path. External access
 *  requires individual installation receipts and an implemented host broker.
 *  Unsupported external requests fail activation; declarations never grant access. */
export const pluginCapability = z.enum([
  "cms_admin",
  "cms_admin_schema",
  "ai_provider",
  "snapshots",
  "chat_runner_tools",
  "background_workers",
  "domain_events",
  "email",
  "head_contributions",
  "url_slots",
  "client_assets",
  "list_sources",
  "list_types",
  "list_resolve",
  "companion_skills",
  "font_assets",
  "private_files",
  "image_generation",
  "site_media_read",
  "content_variants",
  "link_resolve",
  "consent_provider",
]);

export type PluginCapability = z.infer<typeof pluginCapability>;

/**
 * Provenance is the trust axis (epic #380): who authored the plugin and
 * how it entered the system. `release-signed` = the manifest carries a
 * verified Ed25519 signature over the shipped artifact set (disk-loaded
 * core plugins). `runtime-authored` = submitted at runtime (AI or Owner
 * paste), gated by the validator + Owner activation, never signed.
 * Provenance sets the grantability ceiling; the legacy `tier` column
 * (1|2) is the persisted encoding of the same fact and is now derived
 * trust, not a parallel interface.
 */
export type PluginProvenance = "release-signed" | "runtime-authored";

/** Tier 1 background worker spec (cron-style). */
export const pluginWorkerSpec = z.object({
  name: z.string().min(1).max(120),
  /** Cron expression. Same vocabulary as the existing scheduled-publish work. */
  cron: z.string().min(1).max(120),
  /** Operation name to dispatch on tick. Must exist in `operations`. */
  operationName: z.string().min(1).max(120),
});

export type PluginWorkerSpec = z.infer<typeof pluginWorkerSpec>;

/** AI tool declaration. External packages require the chat_runner_tools grant. */
export const pluginToolSpec = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  /** Operation name in `operations` to dispatch when the AI calls this tool. */
  operationName: z.string().min(1).max(120),
  /** Zod-shaped JSON schema for the tool's input. Stored as a JSON object. */
  inputJsonSchema: z.record(z.string(), z.unknown()),
  /** §11.A human-confirmation gate. When set, the chat-runner ships the
   *  tool with the SDK's native approval: the turn PAUSES on a
   *  tool-approval-request, the Owner clicks Approve in-chat, and only
   *  then does the host dispatch `operationName`. Closes the historical
   *  bypass where plugin tools skipped the approvals surface entirely
   *  (#388). The tool's description must state the two-step contract. */
  approvalMode: z.literal("user-approval").optional(),
  /** #635 — arguments the approval card shows IN FULL instead of cut to
   *  one line, because the approver approves their exact text (e.g. the
   *  body of an email that is sent as approved). Only meaningful with
   *  `approvalMode`; bound each one in `inputJsonSchema` (`maxLength`). */
  approvalPreviewFullArgs: z.array(z.string().min(1).max(64)).max(8).optional(),
  /** The permission the HUMAN a chat call acts for must hold — for the
   *  direct call, or for the approver of an approval-gated one. Use the
   *  permission the plugin's own owner panel requires, so the chat is not
   *  a way around it (e.g. sending a newsletter needs `settings.write`
   *  in the panel and therefore in the chat). Enforced by the host for
   *  `chat` and `approved` invocations, including the Power-MCP. */
  requiredPermission: z.enum(["content.write", "settings.write", "deploy.trigger"]).optional(),
  /** #741 — the operation can call `ctx.ai` or generate images, i.e. spend
   *  the install's AI. Declared so the Power-MCP applies a token's cost cap
   *  to exactly these tools and tells the agent the AI part comes back to
   *  it as a work item. An operation that spends without declaring it is a
   *  bug the cap cannot see. */
  usesInstallAi: z.boolean().optional(),
});

export type PluginToolSpec = z.infer<typeof pluginToolSpec>;

/**
 * #393 — a skill SHIPPED with a plugin (release-signed only). On
 * activation the host registers it at `awaiting_activation`; the
 * existing two-level model is untouched — the Owner's site-wide click
 * and per-chat engagement work exactly like any other skill. Archived
 * when the plugin is uninstalled. Closes the "companion skill" gap
 * declaratively instead of via SQL seeds.
 */
export const pluginSkillSpec = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z][a-z0-9-]*$/, "must be lowercase, dash-separated"),
    displayName: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    body: z.string().min(1).max(50_000),
    allowlistedTools: z.array(z.string().min(1).max(120)).optional(),
    autoEngagementHints: z
      .object({
        keywords: z.array(z.string().min(1).max(80)).optional(),
        chipTrigger: z.boolean().optional(),
        alwaysOn: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PluginSkillSpec = z.infer<typeof pluginSkillSpec>;

/** Frontend Web Component spec. Same shape both tiers. Mounted in
 *  Shadow DOM by default (per §14.6 — mandatory). */
export const pluginComponent = z
  .object({
    tag: z
      .string()
      .min(3)
      .max(120)
      .regex(/^[a-z][a-z0-9-]*-[a-z0-9-]+$/, "must be a valid custom-element tag"),
    shadowMode: z.enum(["open", "closed"]).default("open"),
  })
  .strict();

export type PluginComponent = z.infer<typeof pluginComponent>;

/**
 * #390 — the slots of Caelo's fixed URL grammar (epic #380 decision 1):
 * `scheme+host · path-prefix · slug (filtered by slug-format)`, plus
 * `full-path` as the exclusive escape slot. Composition order comes
 * from the grammar, never from registration order; each slot has at
 * most one claimant across all active plugins.
 */
export const urlSlot = z.enum(["host", "path-prefix", "slug-format", "full-path"]);

export type UrlSlot = z.infer<typeof urlSlot>;

/** Manifest-side claim: slot names only, so conflicts are detectable
 *  from the signed manifest without loading code. */
export const urlContributionClaim = z.object({ slot: urlSlot }).strict();

// ---------------------------------------------------------------------------
// #391 — head + sitemap contribution points.
// ---------------------------------------------------------------------------

/**
 * A typed per-page `<head>` entry. STRUCTURED on purpose — the §2
 * invariant "no raw HTML into <head>" holds for plugins too: plugins
 * return these shapes, CORE serializes + escapes them, and the same
 * serializer feeds the static generator and the admin preview (one
 * code path, byte parity).
 */
export const headEntry = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("link"),
      rel: z.string().min(1).max(60),
      href: z.string().min(1).max(2000),
      hreflang: z.string().min(2).max(35).optional(),
      media: z.string().max(200).optional(),
      type: z.string().max(100).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("meta"),
      name: z.string().min(1).max(120).optional(),
      property: z.string().min(1).max(120).optional(),
      content: z.string().max(2000),
    })
    .strict()
    .refine((v) => (v.name !== undefined) !== (v.property !== undefined), {
      message: "meta entries carry exactly one of `name` or `property`",
    }),
]);

export type HeadEntry = z.infer<typeof headEntry>;

/** Per-page sitemap adjustments contributed by a plugin. */
export const sitemapContribution = z
  .object({
    /** Drop this page from the sitemap entirely (e.g. an unpublished
     *  variant URL must not appear — clean-404 semantics). */
    exclude: z.boolean().optional(),
    /** xhtml alternate links attached to the page's <url> entry. */
    alternates: z
      .array(
        z
          .object({
            hreflang: z.string().min(2).max(35),
            href: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type SitemapContribution = z.infer<typeof sitemapContribution>;

/** Manifest-side claim of contribution kinds (release-signed only,
 *  capability `head_contributions`). */
export const contributionKind = z.enum(["head", "sitemap"]);

export type ContributionKind = z.infer<typeof contributionKind>;

/** Plugin manifest (the structural part the host consumes). The actual
 *  operation bodies + frontend mount handler live in source — the
 *  manifest references them by name. */
/**
 * Epic #1107 — a list source a plugin offers to module templates
 * (`docs/lists.md` §6). It replaced the flat-string `dataLists`.
 *
 * `name` is what a list type's source node names (`source: { kind:
 * "plugin", name }`) and what a module may iterate directly as
 * `{{#name}}`; it is claimed site-wide so two plugins can never disagree
 * about what a name means. `node` declares the fields every generated
 * entry carries, in the same field system list types use, so the AI
 * authors the inner markup from the definition and the host validates
 * every value the plugin returns against it. A generated entry is data,
 * never structure: no stored children, no nested source, no embedded
 * module or term reference.
 */
export const pluginListSourceSpec = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, "list source names are lowercase snake_case"),
    /** Operator-facing label ("Language versions of this page"). */
    label: z.string().min(1).max(128),
    /** One line for the AI: what the entries are and when the list is non-empty. */
    description: z.string().min(1).max(300),
    node: nodeDefSchema,
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.node.children || spec.node.source) {
      ctx.addIssue({
        code: "custom",
        path: ["node"],
        message: "a list source entry has no stored children and no nested source",
      });
    }
    for (const [i, f] of spec.node.fields.entries()) {
      if (f.type === "module" || f.type === "term") {
        ctx.addIssue({
          code: "custom",
          path: ["node", "fields", i],
          message: `a list source entry cannot carry a ${f.type} field: generated entries are data, not structure`,
        });
      }
    }
  });

export type PluginListSourceSpec = z.infer<typeof pluginListSourceSpec>;

/**
 * Epic #1107 — the JSON Schema subset a plugin declares for its
 * definition extensions (`listExt`). Kept to the keywords the host
 * compiles safely (the same subset external tool schemas use); the
 * object root must close `additionalProperties`.
 */
export const pluginExtJsonSchema = z.record(z.string(), z.unknown());

/**
 * Epic #1107 (`docs/lists.md` §9) — attributes a plugin adds to field
 * and node definitions of list types, stored under `ext.<pluginSlug>`.
 * Core validates them against the ACTIVE plugin's schema and never
 * reads them; the plugin interprets them (international-site:
 * `{ translate: boolean }` on fields).
 */
export const pluginListExt = z
  .object({
    field: pluginExtJsonSchema.optional(),
    node: pluginExtJsonSchema.optional(),
  })
  .strict();

export type PluginListExt = z.infer<typeof pluginListExt>;

/**
 * Epic #1107 — the `list-resolve` composition point's answer for one
 * output variant (`docs/lists.md` §9.3): values keyed by value address
 * (`list/<listId>/item/<itemId>/<field>`, `instance/…`, `page/…/props/…`)
 * and addresses of hidden entries. An overlay replaces values and hides
 * entries; it can never add, remove or reorder entries — core's resolver
 * drops anything else and reports it to the plugin's error channel.
 */
export const listResolveVariantOverlay = z
  .object({
    values: z.record(z.string().min(1).max(400), z.unknown()),
    hidden: z.array(z.string().min(1).max(400)).max(50_000),
  })
  .strict();

export type ListResolveVariantOverlay = z.infer<typeof listResolveVariantOverlay>;

/**
 * A module withheld from the page until the withholding plugin says
 * otherwise.
 *
 * Core emits the module's real HTML inside an inert `<template>` plus a
 * visible placeholder module; nothing inside a `<template>` issues a
 * network request, so a third-party embed genuinely does not load. The
 * plugin's client runtime clones the content into place when its
 * condition is met.
 *
 * Deliberately generic — core learns "withheld by plugin X for reason
 * Y", never "consent". A paywall or an auth gate uses the same shape.
 */
export const moduleDeferralSpec = z
  .object({
    /** The plugin's own vocabulary, surfaced as `data-reason`. */
    reason: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/, "reason is a lowercase key"),
    /** Slug of the module rendered in the withheld one's place. An
     *  ordinary module, so the AI authors and styles it. */
    placeholderModuleSlug: z.string().min(1).max(200),
    /** The plugin's own built-in placeholder, rendered while no module
     *  with `placeholderModuleSlug` exists yet. Without it a site whose
     *  placeholder was never designed cannot render the page at all. */
    defaultPlaceholder: z
      .object({ html: z.string().min(1).max(20_000), css: z.string().max(20_000) })
      .strict()
      .optional(),
  })
  .strict();

export type ModuleDeferralSpec = z.infer<typeof moduleDeferralSpec>;

/**
 * One module of the render pass, as the deferrals operation receives it:
 * exactly the content about to be shipped. A gate must judge THIS, not a
 * verdict recorded earlier — a module edited (or created on a chat
 * branch) since the last background scan would otherwise ship ungated.
 */
export interface DeferralCandidate {
  readonly moduleId: string;
  readonly html: string;
  readonly css: string;
  readonly js: string;
  /** The module's field schema (defaults can carry vendor URLs). */
  readonly fields: unknown;
  /** Every content-values object the module renders with in this pass. */
  readonly contentValues: ReadonlyArray<unknown>;
}

/**
 * #592 — one placement of a page being rendered, as the content-variants
 * operation receives it: LAYOUT placements (site chrome — header, footer,
 * menus; content in the module's field defaults) and PAGE placements
 * (content in a content instance, `shared` when synced across pages).
 * `values` is exactly what core would render without a plugin.
 */
export interface ContentVariantPlacement {
  /** Stable within one page: `layout:<block>:<position>` / `page:<block>:<position>`. */
  readonly key: string;
  readonly scope: "layout" | "page";
  /** The page's layout (layout scope only). */
  readonly layoutId: string | null;
  readonly blockName: string;
  readonly position: number;
  readonly moduleId: string;
  /** Display name of the module, for messages an operator reads. */
  readonly moduleName: string;
  /** The bound content instance (page scope only). */
  readonly contentInstanceId: string | null;
  /** Layout placements are always shared; page placements when synced. */
  readonly shared: boolean;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly kind: string }>;
  readonly values: Readonly<Record<string, unknown>>;
}

/** The pages of one render pass, as the content-variants operation gets them. */
export interface ContentVariantPage {
  readonly pageId: string;
  readonly placements: ReadonlyArray<ContentVariantPlacement>;
}

/**
 * #592 — what a plugin answers for one placement. Absent = render as core
 * would. `values` replaces the placement's content; `moduleId` swaps the
 * module itself (LAYOUT placements only — a different footer or menu
 * module in a locale's chrome). `problems` are loud: the preview lists
 * them on the missing-content surface and the build refuses to ship —
 * e.g. a missing locale variant, never a silent fallback to another
 * language (CLAUDE.md §2).
 */
export const contentVariantResolution = z
  .object({
    moduleId: z.string().uuid().optional(),
    values: z.record(z.string(), z.unknown()).optional(),
    problems: z.array(z.string().min(1).max(2000)).max(50).optional(),
  })
  .strict();

export type ContentVariantResolution = z.infer<typeof contentVariantResolution>;

/**
 * Epic #724 (rollout D) — one page's answer at the `link-resolve`
 * composition point: which VARIANT of the site the page belongs to
 * (international-site: its locale code) and which GROUP of pages are
 * versions of each other (its variant group; null = no other version).
 *
 * Core resolves every internal page reference (`caelo:page/<id>`) on a
 * page of variant V to the member of the target's group in V — the
 * same-language version of the linked page — wherever the link lives:
 * module HTML, rich text, link fields, link lists, nav-menu sets,
 * chrome. A target with no member in V is a loud failure, never a link
 * into another variant (CLAUDE.md §2). URLs stay core's: the plugin
 * names pages, core builds their URLs.
 *
 * `variant` is a plain token (letters, digits, `-`, `_`: BCP-47 codes
 * like `de`, `pt-BR`, `zh-Hant`): core interpolates it into missing-slot
 * markers (`link-variant-missing:page/<id>:<variant>`) and AI-facing
 * text, where a `:` or whitespace would corrupt the marker.
 */
export const linkResolvePageVariant = z
  .object({
    variant: z
      .string()
      .regex(
        /^[A-Za-z0-9_-]{1,64}$/,
        "variant must be 1-64 letters, digits, '-' or '_' (e.g. a locale code like pt-BR)",
      ),
    group: z.string().min(1).max(200).nullable(),
  })
  .strict();

export type LinkResolvePageVariant = z.infer<typeof linkResolvePageVariant>;

/**
 * Epic #724 (rollout E) — one place in a plugin's private storage that
 * holds internal links: a column of one row. Core converts literal links
 * there (`/about`) into references (`caelo:page/<id>`) with the same
 * canonicaliser it uses for its own content, inside its own migration
 * transaction and snapshot, so a plugin never re-implements link
 * parsing and the conversion reverts with everything else.
 *
 * How the column's value is read:
 *   - `fields` (or `moduleId`, whose fields core loads): the value is a
 *     module content-values object; a `url` / `link` / `image` field's
 *     whole value is a link, every string is scanned for HTML links;
 *   - neither: the value is any JSON (or text) — keys named `href`,
 *     `url`, `link`, `*_href`, … carry links, strings carrying markup are
 *     scanned for `href` / `src`.
 */
export const pluginLinkLocation = z
  .object({
    /** A table declared in the plugin's `adminSchema`. */
    table: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
    rowId: z.string().uuid(),
    /** A `jsonb` or `text` column declared on that table. */
    column: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
    /** Operator-facing: what this is ("German footer — layout main"). */
    label: z.string().min(1).max(300),
    moduleId: z.string().uuid().optional(),
    fields: z
      .array(z.object({ name: z.string().min(1), kind: z.string().min(1) }).strict())
      .max(500)
      .optional(),
  })
  .strict();

export type PluginLinkLocation = z.infer<typeof pluginLinkLocation>;

/** What a `linkLocationsOperation` returns. */
export const pluginLinkLocations = z
  .object({ locations: z.array(pluginLinkLocation).max(10_000) })
  .strict();

/**
 * Epic #1107 — one Stage-audit finding a plugin contributes through its
 * `auditFindingsOperation` (see {@link PluginDefinition.auditFindingsOperation}).
 * Core files it under the rule `plugin.<slug>/<rule>` in the same audit
 * report as its own checks: an `error` blocks Publish live until fixed or
 * accepted by the Owner, `warning` / `info` are reported.
 */
export const pluginAuditFinding = z
  .object({
    /** Lower-case kebab words (`translation-missing`). */
    rule: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/),
    severity: z.enum(["error", "warning", "info"]),
    /** A page of the staged build (one of the `pages` passed in); absent = site-wide. */
    pageId: z.string().uuid().optional(),
    /**
     * AI-actionable: lead with a short label before the first colon
     * ("Translation missing: …"), then what is wrong and why it matters.
     */
    message: z.string().min(1).max(1000),
    /** The AI tool that fixes it (the plugin's own or a core tool) and one sentence of how. */
    fix: z
      .object({ tool: z.string().min(1).max(80), hint: z.string().min(1).max(500) })
      .strict()
      .optional(),
  })
  .strict();

export type PluginAuditFinding = z.infer<typeof pluginAuditFinding>;

/** What an `auditFindingsOperation` returns. */
export const pluginAuditFindings = z
  .object({ findings: z.array(pluginAuditFinding).max(499) })
  .strict();

/** What an `auditFindingsOperation` is called with: the staged build's pages. */
export interface PluginAuditFindingsArgs {
  readonly pages: readonly { readonly pageId: string; readonly path: string }[];
}

/** A plugin slug as a reference to another plugin (same shape as `pluginManifest.slug`). */
const pluginSlugRef = z
  .string()
  .min(1)
  .max(55)
  .regex(/^[a-z][a-z0-9-]*$/, "must be a plugin slug (lowercase, dash-separated)");

/**
 * The consent categories a declared purpose may sit under. They are the
 * consent provider's shipped categories (consent-manager seeds exactly
 * these keys). `necessary` is listed so the type names the whole set,
 * but a declaration may not use it — see {@link pluginConsentPurpose}.
 */
export const consentCategory = z.enum(["necessary", "functional", "analytics", "marketing"]);

export type ConsentCategory = z.infer<typeof consentCategory>;

/** The cookie the API gateway sets for the `visitor_id` purpose. Host-owned. */
export const VISITOR_ID_COOKIE = "caelo_visitor_id";

/** The purpose key that makes the gateway set {@link VISITOR_ID_COOKIE}. */
export const VISITOR_ID_PURPOSE_KEY = "visitor_id";

/** One cookie a declared purpose sets, worded for the banner and the privacy policy. */
export const pluginConsentCookie = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, "a plain cookie name"),
    /** How long it lives, in words ("30 days", "session"). */
    lifetime: z.string().min(1).max(40),
    /** What it does, for the visitor. */
    purpose: z.string().min(1).max(500),
  })
  .strict();

/**
 * Something a plugin needs the visitor's consent for, and the cookies it
 * sets for it. The consent provider classifies the purpose under
 * `category`; the visitor's banner decision for that category decides
 * whether it happens.
 *
 * `necessary` is refused: a necessary cookie needs no consent at all, so
 * a plugin that could declare one would set it for every visitor,
 * unasked — the opposite of what declaring a purpose is for. Strictly
 * necessary cookies stay host-owned (the provider's own decision cookie).
 */
export const pluginConsentPurpose = z
  .object({
    /** Purpose key, e.g. `visitor_id`. The key core acts on is {@link VISITOR_ID_PURPOSE_KEY}. */
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, "a snake_case purpose key"),
    category: consentCategory.exclude(["necessary"], {
      message:
        "a declared purpose cannot be `necessary`: necessary cookies are set without consent, so declare the narrowest category the visitor can refuse (functional, analytics or marketing)",
    }),
    /** Why the plugin needs it, for the Owner and the banner copy. */
    purpose: z.string().min(1).max(500),
    cookies: z.array(pluginConsentCookie).max(10),
  })
  .strict();

export type PluginConsentPurpose = z.infer<typeof pluginConsentPurpose>;

/**
 * One purpose as `ctx.consentPurposes.list()` returns it: a declaration
 * of an active plugin, tagged by the host with the slug of the plugin
 * that declared it (never by the plugin itself).
 */
export interface DeclaredConsentPurpose {
  readonly pluginSlug: string;
  readonly key: string;
  readonly category: string;
  readonly purpose: string;
  readonly cookies: ReadonlyArray<{
    readonly name: string;
    readonly lifetime: string;
    readonly purpose: string;
  }>;
}

export const pluginManifest = z
  .object({
    // ≤ 55: the plugin's schema is `plugin_<slug>`, and Postgres silently
    // truncates identifiers past 63 bytes — two long slugs sharing a
    // prefix would land in ONE schema, i.e. one plugin's data.
    slug: z
      .string()
      .min(1)
      .max(55)
      .regex(/^[a-z][a-z0-9-]*$/, "must be lowercase, dash-separated"),
    version: z
      .string()
      .min(1)
      .max(40)
      .regex(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/, "must be semver"),
    tier: z.union([z.literal(1), z.literal(2)]),
    schema: pluginSchemaMap,
    /** The plugin's own authoring-DB schema,
     *  provisioned as `plugin_<slug>` in cms_admin (FORCE RLS, scoped to
     *  the plugin's id). Same declarative table spec as `schema`; `ref:`
     *  columns may FK onto allowlisted core tables. Requires the
     *  `cms_admin_schema` capability. */
    adminSchema: pluginSchemaMap.optional(),
    /** Operation names. Bodies live in source — the manifest just lists names. */
    operations: z.array(z.string().min(1).max(120)).min(1),
    component: pluginComponent.optional(),
    hasStaticRender: z.boolean().default(false),
    /** See `PluginDefinition.publicOperations`. */
    publicOperations: z.array(z.string().min(1).max(120)).optional(),
    /** See `PluginDefinition.visitorProjection` (#635). Each table must be
     *  in `adminSchema` and each column declared on it. */
    visitorProjection: z
      .record(
        z.string().regex(/^[a-z_][a-z0-9_]*$/),
        z
          .array(
            z
              .string()
              .regex(/^[a-z_][a-z0-9_]*$/)
              .refine((c) => !c.startsWith("caelo_"), "caelo_ columns are host-owned"),
          )
          .max(64),
      )
      .optional(),
    /** See `PluginDefinition.buildAssets`. Release-signed only — the
     *  files land on every page of the public site, so authorship has
     *  to be auditable. */
    hasBuildAssets: z.boolean().default(false),
    /** See `PluginDefinition.deferralsOperation`. Release-signed only:
     *  withholding a module changes what visitors see. */
    hasDeferrals: z.boolean().default(false),
    /** See `PluginDefinition.contentVariantsOperation` (#592). Requires
     *  the `content_variants` capability: it changes what every page
     *  renders. */
    hasContentVariants: z.boolean().default(false),
    /** See `PluginDefinition.linkResolveOperation` (#724). Requires the
     *  `link_resolve` capability: it changes where every internal link
     *  on a page goes. */
    hasLinkResolve: z.boolean().default(false),
    /** See `PluginDefinition.auditFindingsOperation` (epic #1107). Must
     *  name one of `operations`. Needs no capability: it reads like a
     *  render and only adds findings to the Stage audit. */
    auditFindingsOperation: z.string().min(1).max(120).optional(),
    /** Grants this plugin asks for. A request grants nothing: the Owner
     *  approves each one for this exact artifact (CMS_REQUIREMENTS §14.5). */
    requestedCapabilities: z.array(pluginCapability).optional(),
    /** Untrusted author explanations, displayed beside each explicit Owner grant. */
    capabilityReasons: z.partialRecord(pluginCapability, z.string().min(1).max(500)).optional(),
    /** Requested scopes are part of the immutable reviewed artifact. */
    capabilityConstraints: z
      .partialRecord(
        pluginCapability,
        z
          .object({
            operations: z
              .array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/))
              .max(100)
              .optional(),
            maxDailyCostMicrocents: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .optional(),
    /** Tier 1 only. */
    workers: z.array(pluginWorkerSpec).optional(),
    /** AI chat tools; needs the `chat_runner_tools` grant. */
    tools: z.array(pluginToolSpec).optional(),
    /** #390 — URL-slot claims (release-signed only). The definition
     *  supplies the matching pure encode/decode pairs. */
    urlContributions: z.array(urlContributionClaim).optional(),
    /** #391 — head/sitemap contribution claims (release-signed only,
     *  requires the `head_contributions` capability). */
    contributes: z.array(contributionKind).optional(),
    /** Plugin-shipped instructions; external packages require a companion_skills receipt. */
    skills: z.array(pluginSkillSpec).optional(),
    /**
     * Epic #1107 — list sources a module iterates (`{{#name}}…{{/name}}`
     * or a list type's `source: { kind: "plugin", name }`), resolved per
     * rendered page. The plugin supplies the DATA; the module (authored
     * by the AI) owns the markup — so a language switcher looks like the
     * site it lives on. Names are claimed site-wide, like URL slots.
     * Requires the `list_sources` capability.
     */
    listSources: z.array(pluginListSourceSpec).max(20).optional(),
    /**
     * Epic #1107 — list types this plugin ships. They become stored list
     * types owned by the plugin, available exactly while the plugin runs
     * (like its skills), and are refreshed from this manifest — bound to
     * the artifact like everything else here. Slugs start with
     * `<pluginSlug>-`. Requires the `list_types` capability.
     */
    listTypes: z.array(listTypeDefSchema).max(20).optional(),
    /** See {@link pluginListExt}. Data only — no capability: core never interprets it. */
    listExt: pluginListExt.optional(),
    /** See `PluginDefinition.listResolveOperation`. Requires the
     *  `list_resolve` capability: it changes what lists render as. */
    hasListResolve: z.boolean().default(false),
    /** See `PluginDefinition.adminPanels`. Data only: the admin renders
     *  them; part of the artifact the Owner approves. */
    adminPanels: z.array(pluginAdminPanel).max(8).optional(),
    /** See `PluginDefinition.requiresPlugins`. */
    requiresPlugins: z.array(pluginSlugRef).max(20).optional(),
    /** See `PluginDefinition.consentPurposes`. Data only — no capability:
     *  a declaration asks the visitor, it never grants anything. */
    consentPurposes: z.array(pluginConsentPurpose).max(20).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    checkAdminPanels(m.adminPanels ?? [], m.operations, (path, message) =>
      ctx.addIssue({ code: "custom", path: ["adminPanels", ...path], message }),
    );
    const required = new Set<string>();
    for (const [i, slug] of (m.requiresPlugins ?? []).entries()) {
      if (slug === m.slug) {
        ctx.addIssue({
          code: "custom",
          path: ["requiresPlugins", i],
          message: "a plugin cannot require itself",
        });
      }
      if (required.has(slug)) {
        ctx.addIssue({
          code: "custom",
          path: ["requiresPlugins", i],
          message: `"${slug}" is required twice`,
        });
      }
      required.add(slug);
    }
    const purposeKeys = new Set<string>();
    for (const [i, p] of (m.consentPurposes ?? []).entries()) {
      if (purposeKeys.has(p.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["consentPurposes", i, "key"],
          message: `consent purpose "${p.key}" is declared twice`,
        });
      }
      purposeKeys.add(p.key);
      // `caelo_` cookies are the host's: a plugin names one only to say it
      // relies on it, and the one it can rely on is the visitor id.
      const names = p.cookies.map((c) => c.name);
      for (const [j, name] of names.entries()) {
        if (
          name.startsWith("caelo_") &&
          !(name === VISITOR_ID_COOKIE && p.key === VISITOR_ID_PURPOSE_KEY)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["consentPurposes", i, "cookies", j, "name"],
            message: `"caelo_" cookies are host-owned; only the "${VISITOR_ID_PURPOSE_KEY}" purpose may name ${VISITOR_ID_COOKIE}`,
          });
        }
      }
      if (p.key === VISITOR_ID_PURPOSE_KEY && !names.includes(VISITOR_ID_COOKIE)) {
        ctx.addIssue({
          code: "custom",
          path: ["consentPurposes", i, "cookies"],
          message: `the "${VISITOR_ID_PURPOSE_KEY}" purpose is the gateway's ${VISITOR_ID_COOKIE} cookie: list it`,
        });
      }
    }
    // Epic #1107 — a plugin's list types are its own: the slug prefix
    // keeps them from ever colliding with (or replacing) a site's type.
    for (const [i, t] of (m.listTypes ?? []).entries()) {
      if (!t.slug.startsWith(`${m.slug}-`)) {
        ctx.addIssue({
          code: "custom",
          path: ["listTypes", i, "slug"],
          message: `plugin list type slugs must start with "${m.slug}-"`,
        });
      }
    }
    const sourceNames = new Set<string>();
    for (const [i, src] of (m.listSources ?? []).entries()) {
      if (sourceNames.has(src.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["listSources", i, "name"],
          message: `list source "${src.name}" is declared twice`,
        });
      }
      sourceNames.add(src.name);
    }
    if (
      m.auditFindingsOperation !== undefined &&
      !m.operations.includes(m.auditFindingsOperation)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["auditFindingsOperation"],
        message: `auditFindingsOperation "${m.auditFindingsOperation}" is not one of the plugin's operations`,
      });
    }
    // #635 — the projection can only name what private storage declares.
    for (const [table, columns] of Object.entries(m.visitorProjection ?? {})) {
      const declared = m.adminSchema?.[table];
      if (!declared) {
        ctx.addIssue({
          code: "custom",
          path: ["visitorProjection", table],
          message: `visitorProjection names table "${table}", which is not in adminSchema`,
        });
        continue;
      }
      for (const c of columns) {
        if (c !== "id" && !(c in declared)) {
          ctx.addIssue({
            code: "custom",
            path: ["visitorProjection", table],
            message: `visitorProjection names column "${c}", which adminSchema.${table} does not declare`,
          });
        }
      }
    }
  });

export type PluginManifest = z.infer<typeof pluginManifest>;

// ---------------------------------------------------------------------------
// Capability handles — the runtime injects these into the plugin's ctx.
// Tier 2 receives the base PluginContext only; Tier 1 receives PluginContextTier1.
// ---------------------------------------------------------------------------

/**
 * Locked query handle — both tiers. Limited to ops over the plugin's
 * declared cms_public.<slug>.<table> schema. The host enforces that
 * `table` is declared in the plugin's manifest before dispatching.
 *
 * Filter shape (P12):
 *   `{column: value}` AND-combined → parameterised WHERE.
 *   Reserved keys: `since` (timestamptz cutoff on `created_at`),
 *   `limit` (int, default 100, max 1000), `orderBy` (column name,
 *   must be in the declared schema), `orderDir` ("asc" | "desc").
 *   No raw SQL crosses the boundary — all values are parameterised.
 */
export interface PluginQueryFilter {
  /** Rows created strictly after this ISO timestamp. */
  readonly since?: string;
  /** Rows created strictly before this ISO timestamp — the cursor for
   *  paging a newest-first list (`orderBy: "created_at", orderDir: "desc"`). */
  readonly before?: string;
  readonly limit?: number;
  readonly orderBy?: string;
  readonly orderDir?: "asc" | "desc";
  readonly [column: string]: unknown;
}

export interface PluginQuery {
  insert<TableName extends string>(
    table: TableName,
    data: Record<string, unknown>,
  ): Promise<{ id: string }>;
  list<TableName extends string, T = Record<string, unknown>>(
    table: TableName,
    filter?: PluginQueryFilter,
  ): Promise<T[]>;
  update<TableName extends string>(
    table: TableName,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void>;
  delete<TableName extends string>(table: TableName, id: string): Promise<void>;
  /**
   * Atomically update one row only while every expected value still
   * matches. Returns false for a stale, missing or inaccessible row.
   * `null` matches `null`; JSON values compare by JSON equality. Both
   * `expected` and `patch` take 1–64 declared columns; `id` cannot be
   * patched. Write a fresh revision token on every successful swap so a
   * value that returns to an earlier state cannot revive a stale write
   * (ABA). From a chat the swap runs against the chat's view of the row,
   * like every other private-storage write.
   */
  compareAndSwap<TableName extends string>(
    table: TableName,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<boolean>;
}

/**
 * #389 — typed access to the plugin's OWN cms_admin schema
 * (`plugin_<slug>`), masked by the `cms_admin_schema` capability.
 * Identical surface to `PluginQuery`; the host routes it through the
 * admin pool with the plugin's actor + plugin id session vars so the
 * per-plugin RLS policy scopes every row. Direct writes to core tables
 * stay impossible — this handle only reaches tables the plugin declared
 * in `adminSchema` (FKs to core tables are declared as `ref:` columns,
 * enforced by Postgres, never written through this handle).
 */
export interface PluginAdminQuery extends PluginQuery {}

// ---------------------------------------------------------------------------
// #390 — URL composition point.
// ---------------------------------------------------------------------------

/**
 * The page as the URL resolver sees it. `annotations` is the plugin's
 * own per-page data (e.g. `{ locale: "de", isDefaultLocale: false }`),
 * collected BEFORE resolution via the plugin's `urlAnnotations`
 * operation — encode/decode themselves are pure and perform no I/O.
 */
export interface UrlComposePage {
  readonly pageId: string;
  /** The page's OWN slug — one path segment. */
  readonly slug: string;
  /**
   * Slugs of the page's ancestors, root first (`["seo-monitoring"]` for
   * `/seo-monitoring/alerts`); empty for a top-level page. Core places
   * them between the path prefix and the page's own (slug-formatted)
   * slug; a `full-path` contribution composes them itself. Not available
   * to the `host` slot (always empty there): a host is chosen per page
   * from its annotations, never from its position in the tree — the
   * host is resolved at render time where only the materialized path
   * exists.
   */
  readonly ancestorSlugs: ReadonlyArray<string>;
  /** True when this page is the designated site root (site_defaults). */
  readonly isHomePage: boolean;
  readonly annotations: Readonly<Record<string, unknown>>;
}

/** Decode result for prefix/host/full-path: the annotations the path
 *  implies (e.g. `{ locale: "de" }`), consumed by page lookup. */
export interface UrlDecodeMatch {
  readonly annotations: Readonly<Record<string, unknown>>;
}

/**
 * Definition-side contribution: pure encode + decode per slot. Decode
 * is MANDATORY — preview-by-path, link integrity, and the URL-diff
 * engine all need inversion; a contribution that cannot invert its own
 * encoding is rejected at registration.
 */
export type UrlContributionDef =
  | {
      readonly slot: "host";
      /** Host for this page (e.g. "de.example.com") or null for the site default. */
      readonly encode: (page: UrlComposePage) => string | null;
      /** Inverse: what does an inbound host imply? null = not one of ours (default host). */
      readonly decode: (host: string) => UrlDecodeMatch | null;
    }
  | {
      readonly slot: "path-prefix";
      /** Leading path segments for this page ([] = none / default variant). */
      readonly encode: (page: UrlComposePage) => ReadonlyArray<string>;
      /** Inverse: given the path's leading segments, how many belong to
       *  this contribution and what do they imply? null = no prefix
       *  (default). MUST be unambiguous; throw on ambiguity. */
      readonly decode: (
        segments: ReadonlyArray<string>,
      ) => (UrlDecodeMatch & { readonly consumed: number }) | null;
    }
  | {
      readonly slot: "slug-format";
      /** Transform the stored slug into its URL form — ONE path segment
       *  (no "/"): nesting comes from the parent-page chain. */
      readonly encode: (page: UrlComposePage) => string;
      /** Inverse: URL slug segment back to the stored slug. */
      readonly decode: (urlSlug: string) => string;
    }
  | {
      readonly slot: "full-path";
      /** The complete path (leading slash) — owns the whole grammar. */
      readonly encode: (page: UrlComposePage) => string;
      /** Inverse: path back to {slug, ancestorSlugs?, annotations}; null =
       *  unknown path. `ancestorSlugs` (root first) names the parent chain
       *  the path implies; omit it when the grammar has no nesting. */
      readonly decode: (path: string) =>
        | (UrlDecodeMatch & {
            readonly slug: string;
            readonly ancestorSlugs?: ReadonlyArray<string>;
          })
        | null;
    };

/**
 * #392 — one row from the transactional domain-event outbox. Events are
 * ephemeral SIGNALS ("this page changed"), not state: the consumer
 * re-reads current state through its normal handles; snapshots remain
 * the durable history.
 */
/**
 * Every domain-event kind a plugin may poll (#392). The list kinds are
 * epic #1107's neutral translation hooks (`docs/lists.md` §9.4):
 * `list.items_changed` carries the per-entry diff, `list_type.changed`
 * what a definition gained or lost, the page kinds which properties /
 * terms changed. One list for the SDK type and the host's check.
 */
export const PLUGIN_EVENT_KINDS = [
  "page.created",
  "page.updated",
  "page.deleted",
  "page.published",
  "module.updated",
  "list.items_changed",
  "list_type.changed",
  "list.deleted",
  "page.properties_changed",
  "page.terms_changed",
] as const;

export type PluginEventKind = (typeof PLUGIN_EVENT_KINDS)[number];

export interface PluginDomainEvent {
  readonly id: number;
  readonly kind: PluginEventKind;
  readonly entityId: string;
  /** Emitter-supplied context (slug at event time; `chatBranchId` when
   *  the write was branch-scoped — absent means a live write). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/**
 * #392 — polling access to the domain-event outbox, masked by the
 * release-signed-only `domain_events` capability. Deliberately NOT an
 * in-process event bus: workers poll on their existing cron schedule.
 *
 * Cursor contract: `poll()` without an explicit cursor resumes from the
 * plugin's persisted position; `commit(cursor)` advances it AFTER the
 * worker has fully processed a batch (at-least-once semantics — a crash
 * between poll and commit re-delivers).
 */
export interface PluginEvents {
  poll(opts?: {
    readonly cursor?: number;
    readonly kinds?: ReadonlyArray<PluginDomainEvent["kind"]>;
    readonly limit?: number;
  }): Promise<{ events: PluginDomainEvent[]; nextCursor: number }>;
  commit(cursor: number): Promise<void>;
}

/** Public-facing API client (cms_public role; rate-limited at the gateway). */
export interface PluginApi {
  list<T = unknown>(args: object): Promise<T[]>;
  get<T = unknown>(args: object): Promise<T | null>;
}

/** Site theme tokens. Read-only. Same both tiers. */
export interface PluginTheme {
  readonly tokens: Readonly<Record<string, string>>;
}

/**
 * Visitor-side identity. Both tiers. Set by the gateway from the
 * `caelo_visitor_id` HttpOnly cookie + (when authenticated by the auth
 * plugin) the resolved public_user_id. Operations dispatched outside
 * the gateway (e.g. internal Tier-1 calls) get a system visitor id.
 */
export interface PluginVisitor {
  /** Opaque identifier, stable across requests from one browser for as
   *  long as the `caelo_visitor_id` cookie lives (30 days).
   *
   *  NULL unless some active plugin declares the `visitor_id` consent
   *  purpose (`PluginDefinition.consentPurposes`) AND the visitor granted
   *  the category it sits under — no decision yet, "reject all", no
   *  consent provider on the site or no declaring plugin all mean null
   *  (#677). Many visitors will arrive without one. An operation must work without it:
   *  store null, and skip whatever only makes sense for a recognised
   *  visitor (e.g. updating their earlier vote instead of adding one).
   *  Never substitute a value of your own — that would recreate the
   *  identifier the visitor declined. */
  readonly id: string | null;
  /** Authenticated visitor's public_user_id, or null if anonymous. */
  readonly publicUserId: string | null;
  /** Bcrypt-hashed IP for analytics + rate-limiting without storing PII. */
  readonly ipHash: string;
  /** P12 review-pass #2 — opaque session token, set on signup/login by
   *  the auth plugin via `setSession()` and surfaced back to the
   *  gateway through the response envelope. NULL when the visitor is
   *  anonymous. Plugins read this for "is this visitor logged in?"
   *  decisions; the auth plugin is the only legitimate writer.
   *  Reading is safe — even Tier 2 plugins may need to know "is the
   *  visitor authenticated?" — but writing is restricted by the
   *  gateway: only the response envelope from the auth plugin's
   *  signup/login/logout ops triggers a Set-Cookie. */
  readonly sessionToken: string | null;
  /** Auth plugin uses this to mark the response so the gateway sets
   *  the HttpOnly cookie. Returns immediately; the actual `Set-Cookie`
   *  lands in the gateway's response. Other plugins MUST NOT call it
   *  — operations dispatched outside the gateway no-op silently. */
  setSession?(args: { sessionToken: string; expiresAt: string } | null): void;
}

/**
 * Proof-of-work / CAPTCHA validation. Both tiers. Plugins call this on
 * visitor-write ops (comment submit, form submit, signup). The API gateway
 * verifies the visitor's proof (`_caelo_captcha` in the request body)
 * before dispatch; this resolves true when that proof was verified for
 * this request or the Owner turned the captcha off, and false otherwise.
 * The `token` argument is ignored — no value a plugin passes can stand in
 * for a verified proof. Calls that did not come from a visitor resolve
 * true (there is no visitor to challenge).
 */
export interface PluginCaptcha {
  requireProof(token: string | null): Promise<boolean>;
}

/**
 * Tier-1 only — outbound email. Configurable transport (SMTP / Resend /
 * SES / no-op stub). The host's /settings/email page configures which
 * transport is live; ctx.email.send dispatches to it. Plugins that
 * declare requestedCapabilities: ['email'] get this handle; others throw.
 */
export interface PluginEmail {
  send(args: {
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
  }): Promise<{ messageId: string }>;
}

/**
 * What the site's running plugins ask visitors to consent to — the
 * `consentPurposes` of every ACTIVE (loaded) plugin, each tagged with the
 * slug of the plugin that declared it. Granted by `consent_provider`: the
 * plugin holding it decides how the site asks for consent, so it needs to
 * know everything that has to be asked about. Read-only manifest data; a
 * caller cannot add to, filter or rewrite it.
 */
export interface PluginConsentPurposes {
  list(): Promise<ReadonlyArray<DeclaredConsentPurpose>>;
}

/** Tier 1 only — typed Query API call into cms_admin. The host gates
 *  ops by the plugin's actor scope; calls outside the plugin's
 *  requestedCapabilities throw at dispatch. */
export interface PluginCms {
  call<Input, Output>(opName: string, input: Input): Promise<Output>;
}

/**
 * What a `ctx.ai.complete` call is for. The host maps a purpose to the
 * model the Owner chose for it at /settings/ai (e.g. a cheaper translation
 * model); with no choice stored, or no purpose given, the call runs on the
 * chat model. Plugins never name a model or hold a key.
 */
export type PluginAiPurpose = "translation";

/** Tier 1 only — single-shot generation (text or structured) against the configured provider. */
export interface PluginAi {
  complete(opts: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    maxTokens?: number;
    temperature?: number;
    /** Declared use of the call; selects the Owner's per-purpose model. */
    purpose?: PluginAiPurpose;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
  /**
   * Structured output: the model answers with ONE object constrained to
   * `jsonSchema` (the AI SDK's `generateObject`, CLAUDE.md §12) instead of
   * prose a plugin parses. Use it whenever the plugin needs JSON back —
   * the schema, not a prompt paragraph, is then the contract, so a field
   * the plugin must not receive is simply absent from it.
   *
   * `object` is `undefined` when the model produced nothing that parses
   * to the schema (repairable: re-prompt or fail loudly); provider/API
   * errors throw. Re-validate `object` with Zod at the boundary — the
   * provider may relax keywords (e.g. string lengths) it cannot enforce.
   *
   * @example
   * const r = await ctx.ai.generateObject({
   *   system: "Classify the comment.",
   *   messages: [{ role: "user", content: text }],
   *   jsonSchema: {
   *     type: "object",
   *     additionalProperties: false,
   *     required: ["verdict"],
   *     properties: { verdict: { type: "string", enum: ["ok", "spam"] } },
   *   },
   * });
   */
  generateObject(opts: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    /** JSON Schema (draft-07 object) the answer must satisfy. */
    jsonSchema: Record<string, unknown>;
    maxTokens?: number;
    temperature?: number;
    /** Declared use of the call; selects the Owner's per-purpose model. */
    purpose?: PluginAiPurpose;
  }): Promise<{ object: unknown | undefined; inputTokens: number; outputTokens: number }>;
}

/** Tier 1 only — emit a snapshot when a write affects a tracked entity.
 *  Mirrors the existing `emitSnapshot` helper in admin-core. */
export interface PluginSnapshots {
  emit(args: {
    entity: { kind: string; id: string };
    opKind: string;
    payload: unknown;
    description?: string;
  }): Promise<{ siteSnapshotId: string }>;
}

/** Where a plugin call came from (CMS_REQUIREMENTS §14.7). */
export type PluginInvocationOrigin =
  | "chat"
  | "owner-panel"
  /** An action the Owner approved in the chat (§11.A gate): it applies
   *  on main, as the approving Owner, never on the chat's branch. */
  | "approved"
  | "worker"
  | "render"
  | "visitor"
  | "system";

/**
 * Who a plugin call acts for and on which chat branch. Every dispatch
 * site supplies it; the host uses it to decide whether an authoring
 * write lands on a chat branch or on main (CMS_REQUIREMENTS §14.7).
 */
export interface PluginInvocation {
  readonly origin: PluginInvocationOrigin;
  /** The acting actor: the AI actor in a chat, the Owner in the panel,
   *  the system actor for workers/render, the visitor id for visitors —
   *  or `"anonymous-visitor"` for a visitor who has not consented to
   *  being recognised (#677). */
  readonly actorId: string;
  /** The human a chat belongs to. */
  readonly operatorActorId?: string;
  /** Set for origin `chat`: the chat's branch. */
  readonly chatBranchId?: string;
  readonly chatTaskId?: string;
  /**
   * Issue #741 — true when the caller is an external agent on the
   * Power-MCP that does the AI work itself, on its own subscription. The
   * install's AI is then unavailable to this call: `ctx.ai.complete` and
   * `ctx.images.generate`/`edit` throw an `AiDelegated:` error. An
   * operation that would call `ctx.ai` returns an {@link AiWorkItem}
   * instead, naming the tool that takes the agent's answer.
   */
  readonly aiDelegated?: boolean;
}

/** Prefix of the error the host throws when a plugin calls `ctx.ai` or
 *  generates an image on an {@link PluginInvocation.aiDelegated} call. */
export const AI_DELEGATED_ERROR_PREFIX = "AiDelegated:";

/**
 * Issue #741 — the AI part of an operation, handed to the calling agent
 * instead of run on the install's AI. The agent answers `instructions`
 * with its own model and calls `apply.tool` with `apply.args` plus its
 * answer under `apply.resultArg`. The instructions are the exact prompt
 * the operation would have sent, so the answer meets the same contract,
 * and `apply.tool` validates it the same way the install-side path does.
 */
export interface AiWorkItem {
  readonly kind: "ai_work_item";
  /** One line: what this item asks for, e.g. "Translate /pricing into German". */
  readonly task: string;
  readonly instructions: { readonly system: string; readonly user: string };
  /** `json`: the answer is the bare JSON the instructions describe. */
  readonly responseFormat: "json" | "text";
  /**
   * Where the answer goes. Absent when the answer is for the agent and its
   * operator only (a summary): nothing in Caelo changes.
   */
  readonly apply?: {
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    /**
     * Where in the arguments of `apply.tool` the agent's answer goes: a
     * top-level name (`verdict`) or, for a bulk tool, a path into
     * `apply.args` (`items[0].result`). `apply.args` with the answer set
     * there is a complete call; several items of one bulk tool batch by
     * concatenating their `items` arrays.
     */
    readonly resultArg: string;
  };
}

/** Whether the AI part of this call belongs to the calling agent (#741). */
export function isAiDelegated(ctx: { readonly invocation: PluginInvocation }): boolean {
  return ctx.invocation.aiDelegated === true;
}

/** What every plugin receives. Granted handles extend it (PluginContextTier1). */
export interface PluginContext {
  readonly query: PluginQuery;
  readonly api: PluginApi;
  readonly theme: PluginTheme;
  readonly visitor: PluginVisitor;
  readonly captcha: PluginCaptcha;
  /** Who this call acts for, and on which branch. */
  readonly invocation: PluginInvocation;
}

/** Private immutable files, scoped to this installation and an authenticated author.
 * Fixed-size base64 chunks keep binary data below the isolated RPC message limit.
 * A ready file cannot be overwritten. Its SHA-256 is its immutable revision.
 */
export interface PluginPrivateFile {
  readonly id: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly status: "pending" | "ready" | "deleted";
}
export interface PluginPrivateFiles {
  /** Idempotent for the exact same id and metadata; conflicting reuse is rejected. */
  begin(input: Omit<PluginPrivateFile, "status">): Promise<PluginPrivateFile>;
  /** Offset is a multiple of 262144; only the final chunk may be shorter. */
  writeChunk(input: { id: string; offset: number; base64: string }): Promise<void>;
  /** Requires all bytes and verifies SHA-256 before marking the file ready. */
  commit(input: { id: string }): Promise<PluginPrivateFile>;
  stat(input: { id: string }): Promise<PluginPrivateFile>;
  /** Permanently remove bytes. The identity is retired and cannot be reused. */
  remove(input: { id: string; sha256: string }): Promise<void>;
  /** Only ready files; returns one stored chunk, never a provider URL. */
  readChunk(input: { id: string; offset: number }): Promise<{ base64: string }>;
}

/** #530 — a site media-library image, as a plugin granted `site_media_read` sees it. */
export interface PluginSiteMediaAsset {
  readonly id: string;
  readonly slug: string;
  readonly mime: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly alt: string;
  /** `reference` images guide generation and are never published. */
  readonly visibility: "library" | "reference";
  /** Set when the image was made from another (an edit). */
  readonly derivedFromId: string | null;
}
/**
 * #530 — read access to the site's media library (`site_media_read`).
 * Every call rechecks that the human the plugin acts for may author
 * content; the grant is checked for the running artifact on each call.
 */
export interface PluginSiteMedia {
  /** Search by alt text or filename; images only. */
  find(input: {
    query?: string;
    visibility?: "library" | "reference" | "all";
    limit?: number;
  }): Promise<PluginSiteMediaAsset[]>;
  /** Metadata for specific assets (id or slug); unknown ids are omitted. */
  inspect(input: { ids: readonly string[] }): Promise<PluginSiteMediaAsset[]>;
  /** One 262144-byte chunk of the original, verified against `sha256`. */
  readChunk(input: { id: string; sha256: string; offset: number }): Promise<{ base64: string }>;
}

/** Private image generation. Request IDs are immutable, installation-scoped and
 * never automatically replay a paid call after an uncertain outcome. */
export interface PluginImageResult {
  readonly requestId: string;
  readonly status: "running" | "ready" | "uncertain";
  readonly file?: PluginPrivateFile;
  readonly width?: number;
  readonly height?: number;
  readonly model: string;
  /** Conservative estimate, not a provider invoice. Uncertain calls retain the reservation. */
  readonly costMicrocents: number;
  /** #532 — how the image was requested; returned by `get`. */
  readonly provenance?: {
    readonly prompt: string | null;
    readonly references: readonly { readonly id: string; readonly sha256: string }[];
  };
}
/** Bounded local derivative; originals remain immutable and no AI call is made. */
export interface PluginImageTransform {
  source: { id: string; sha256: string };
  width: number;
  height: number;
  quality: number;
}
/** What the configured image model accepts (#529) — check before a paid call. */
export interface PluginImageCapabilities {
  readonly provider: string;
  readonly model: string;
  readonly operations: readonly ("generate" | "edit")[];
  readonly references: {
    readonly max: number;
    readonly maxBytesEach: number;
    readonly maxBytesTotal: number;
    readonly mediaTypes: readonly string[];
  };
  readonly mask: boolean;
  readonly sizes: readonly string[];
  readonly imageSizes: readonly string[];
}
/** An image a request reads: a private file (default) or site media (#530). */
export interface PluginImageSourceRef {
  readonly id: string;
  readonly sha256: string;
  readonly source?: "private-file" | "site-media";
}
export interface PluginImages {
  transform(
    input: PluginImageTransform,
  ): Promise<{ file: PluginPrivateFile; width: number; height: number }>;
  /** The configured model, its in-flight reservation and what it can do (#529). */
  describe(): Promise<{
    model: string;
    maxCostMicrocents: number;
    imageSizes: readonly string[];
    capabilities: PluginImageCapabilities;
  }>;
  get(input: { requestId: string }): Promise<PluginImageResult | null>;
  /** References are private files, or site media (`source: "site-media"`, #530). */
  generate(input: {
    requestId: string;
    prompt: string;
    imageSize: "1K" | "2K" | "4K";
    references: readonly PluginImageSourceRef[];
    maxCostMicrocents: number;
  }): Promise<PluginImageResult>;
  /**
   * #528 — change a private image (`source`) from a prompt into a NEW private
   * file; `mask` (a PNG) limits where, on models whose capabilities allow it.
   * Same ledger, budget and idempotency rules as `generate`.
   */
  edit(input: {
    requestId: string;
    source: PluginImageSourceRef;
    mask?: PluginImageSourceRef;
    prompt: string;
    imageSize: "1K" | "2K" | "4K";
    references: readonly PluginImageSourceRef[];
    maxCostMicrocents: number;
  }): Promise<PluginImageResult>;
  /**
   * #528 — change a private image (`source`) from a prompt into a NEW private
   * file; `mask` (a PNG) limits where, on models whose capabilities allow it.
   * Same ledger, budget and idempotency rules as `generate`.
   */
  edit(input: {
    requestId: string;
    source: { id: string; sha256: string };
    mask?: { id: string; sha256: string };
    prompt: string;
    imageSize: "1K" | "2K" | "4K";
    references: readonly { id: string; sha256: string }[];
    maxCostMicrocents: number;
  }): Promise<PluginImageResult>;
}

/** Extended SDK context (legacy name). The host attaches only authorized handles;
 * external plugins additionally require exact receipts and a supported broker. */
/** Read access to Caelo's immutable core font registry; author invocations only. */
export interface PluginFonts {
  find(input: {
    query?: string;
    limit?: number;
  }): Promise<{ fonts: FontMetadata[]; hasMore: boolean }>;
  inspect(input: FontRef): Promise<FontMetadata>;
  resolve(
    input: FontRef & {
      use: "web" | "document";
      text?: string;
      formats: ("ttf" | "otf" | "woff" | "woff2")[];
    },
  ): Promise<FontMetadata>;
  readChunk(
    input: FontRef & { offset: number; length: number },
  ): Promise<{ dataBase64: string; sizeBytes: number; eof: boolean }>;
}
export type { FontMetadata, FontRef, PageUrlStyle } from "@caelo-cms/shared";

export interface PluginContextTier1 extends PluginContext {
  readonly fonts?: PluginFonts;
  /** #389 — attached when the manifest holds `cms_admin_schema`. */
  readonly adminQuery?: PluginAdminQuery;
  readonly privateFiles?: PluginPrivateFiles;
  readonly images?: PluginImages;
  /** #530 — attached when the manifest holds (and the Owner granted) `site_media_read`. */
  readonly siteMedia?: PluginSiteMedia;
  /** #392 — attached when the manifest holds `domain_events`. */
  readonly events?: PluginEvents;
  readonly cms?: PluginCms;
  readonly ai?: PluginAi;
  readonly snapshots?: PluginSnapshots;
  readonly email?: PluginEmail;
  /** Attached when the manifest holds (and the Owner granted) `consent_provider`. */
  readonly consentPurposes?: PluginConsentPurposes;
}

/** Tier 1 only — declarative prompt-context renderer. Each entry on
 *  `PluginDefinition.promptContext[]` is invoked by the chat-runner
 *  every turn; non-empty output is folded into the system-prompt
 *  volatile chunks. Failure of one renderer doesn't affect others. */
export interface PluginPromptContextSpec<C extends PluginContext = PluginContext> {
  /** Stable label per (plugin, renderer). Used for ordering + audit logs. */
  readonly label: string;
  readonly render: (ctx: C) => Promise<string> | string;
}

/** Frontend mount context — same shape both tiers. */
export interface PluginFrontendContext {
  readonly theme: PluginTheme;
  readonly api: PluginApi;
}

// ---------------------------------------------------------------------------
// Plugin definition — what `definePlugin(...)` returns.
// ---------------------------------------------------------------------------

export type PluginOperation<C extends PluginContext = PluginContext> = (
  ctx: C,
  args: unknown,
) => Promise<unknown>;

export interface PluginDefinition<C extends PluginContext = PluginContext> {
  readonly slug: string;
  readonly version: string;
  readonly tier: 1 | 2;
  readonly schema: PluginSchemaMap;
  /** #389 — see `pluginManifest.adminSchema`. */
  readonly adminSchema?: PluginSchemaMap;
  readonly operations: Readonly<Record<string, PluginOperation<C>>>;
  readonly component?: PluginComponent & {
    readonly mounted?: (host: HTMLElement, ctx: PluginFrontendContext) => Promise<void> | void;
  };
  /**
   * Build-time HTML for a `<div data-caelo-plugin>` placeholder.
   * `pageUrlStyle` is the serving target's page URL style; a plugin that
   * links to pages gets their URLs from core (`pages.resolve_public_urls`
   * with this style) instead of building them (#590).
   */
  readonly staticRender?: (
    ctx: C,
    args: { pageId: string; pageUrlStyle: PageUrlStyle },
  ) => Promise<string> | string;
  /**
   * The plugin's channel to the browser: files emitted ONCE per build
   * and referenced from every page of the site.
   *
   * Returns `{ "runtime.js": "…", "runtime.css": "…" }`. `.js` files
   * are linked (deferred) before `</body>`, `.css` files go before
   * `</head>`: a stylesheet up to 2 KB is inlined as `<style>` so it does
   * not block first paint (#1124), a larger one is linked. The host
   * hashes each file's content into its name so a CDN can cache it
   * forever and a changed file still lands.
   *
   * Why once per build rather than per page: the point of this channel
   * is behaviour a plugin must guarantee itself — a consent dialog that
   * has to work regardless of how the site's markup was authored, an
   * embed that must not load before the visitor opts in. Such a runtime
   * usually needs configuration BEFORE it can decide anything, and a
   * static site cannot afford a blocking fetch to obtain it. Emitting
   * once per build lets the plugin bake that configuration into the
   * file it ships.
   *
   * @param args.pageIds every page in this build, so a plugin can bake
   *   per-page data into a lookup rather than fetching it at runtime.
   */
  readonly buildAssets?: (
    ctx: C,
    args: { pageIds: ReadonlyArray<string> },
  ) => Promise<Record<string, string>> | Record<string, string>;
  /**
   * P13 audit fix #4 — optional cheap signature of the plugin's data
   * for this page. Folded into the static_bakes
   * cache key so the bake refreshes when plugin data changes even
   * though the page itself didn't change. Recommended shape:
   *   `${count}:${max(updated_at).toISOString()}` — one COUNT/MAX query.
   * Plugins that omit this miss the data-change cache bust (the bake
   * stays valid until plugin.version bumps or the page changes).
   *
   * Prefer `metaSignatureBatch` when shipping a plugin that runs on
   * sites with many pages — that variant lets the static-generator
   * fold N per-page lookups into one query.
   */
  readonly metaSignature?: (ctx: C, args: { pageId: string }) => Promise<string> | string;
  /**
   * P13 perf-pass — batch variant of `metaSignature`. Called once per
   * build with the full pageId list; returns a Map keyed by pageId.
   * The plugin-pass prefers this when present so a 1000-page site does
   * ONE SQL roundtrip instead of 1000.
   */
  readonly metaSignatureBatch?: (
    ctx: C,
    args: { pageIds: ReadonlyArray<string> },
  ) => Promise<ReadonlyMap<string, string>> | ReadonlyMap<string, string>;
  /** Grants this plugin asks for; each is approved by the Owner (§14.5). */
  readonly requestedCapabilities?: ReadonlyArray<PluginCapability>;
  /**
   * Slugs of plugins that must be active for this one to run. Activation
   * is refused until each is active (the error names the one to activate
   * first), and a required plugin cannot be disabled or uninstalled while
   * this one is active. A dependency is a promise about the running site,
   * not a grant: requiring a plugin gives no access to its data or tools.
   *
   * @example
   *   requiresPlugins: ["consent-manager"]
   */
  readonly requiresPlugins?: ReadonlyArray<string>;
  /**
   * What this plugin needs the visitor's consent for, and the cookies it
   * sets for it (see {@link pluginConsentPurpose}). The site's consent
   * provider lists the declarations of every active plugin
   * (`ctx.consentPurposes`), classifies each under its category and names
   * the cookies on the banner and in the privacy policy. Declaring the
   * `visitor_id` purpose is what makes the API gateway set the
   * `caelo_visitor_id` cookie at all — and only for visitors who granted
   * its category.
   *
   * @example
   *   consentPurposes: [{
   *     key: "visitor_id",
   *     category: "functional",
   *     purpose: "Keeps one rating per visitor and page.",
   *     cookies: [{ name: "caelo_visitor_id", lifetime: "30 days", purpose: "…" }],
   *   }]
   */
  readonly consentPurposes?: ReadonlyArray<PluginConsentPurpose>;
  /**
   * Runs each time the host brings the plugin up — at boot and when an
   * Owner activates it — on main, with `invocation.origin` `"system"`.
   * The place for create-time defaults (a settings row, seed
   * categories): render and visitor calls cannot write private storage,
   * so a read path must never seed. Must be idempotent; a throw fails
   * the plugin's load loudly.
   */
  readonly onActivate?: (ctx: C) => Promise<void> | void;
  readonly capabilityReasons?: PluginManifest["capabilityReasons"];
  readonly capabilityConstraints?: PluginManifest["capabilityConstraints"];
  /** Tier 1 only. Cron-style background workers; the host's scheduler
   *  dispatches `operationName` on each tick. */
  readonly workers?: ReadonlyArray<PluginWorkerSpec>;
  /** AI tools registered into the chat-runner catalogue at activation
   *  (needs the `chat_runner_tools` grant). Each dispatches to the named
   *  operation. */
  readonly tools?: ReadonlyArray<PluginToolSpec>;
  /** Tier 1 only. Plugin-emitted system-prompt blocks rendered every
   *  turn. */
  readonly promptContext?: ReadonlyArray<PluginPromptContextSpec<C>>;
  /** #390 — pure URL-slot contributions (release-signed only). Each
   *  entry's slot must also be claimed in the manifest. */
  readonly urlContributions?: ReadonlyArray<UrlContributionDef>;
  /**
   * #390 — the I/O half of URL resolution: given page ids, return each
   * page's URL annotations from the plugin's own data (e.g. its locale
   * from the variant table). Called by core BEFORE composing; the
   * contributions themselves stay pure. Name of an operation in
   * `operations` taking `{pageIds: string[]}` and returning
   * `{annotations: Record<pageId, Record<string, unknown>>}`.
   */
  readonly urlAnnotationsOperation?: string;
  /** #391 — see `pluginManifest.contributes`. */
  readonly contributes?: ReadonlyArray<ContributionKind>;
  /** #393 — see `pluginManifest.skills`. */
  readonly skills?: ReadonlyArray<PluginSkillSpec>;
  /**
   * #391 — the I/O half of head/sitemap contributions: an operation in
   * `operations` taking `{pageIds: string[], siteBaseUrl: string,
   * pageUrlStyle: PageUrlStyle}` and returning `{head?: Record<pageId,
   * HeadEntry[]>, sitemap?: Record<pageId, SitemapContribution>, lang?:
   * Record<pageId, string>}`. A href that points at a page must be the
   * page's public URL as core resolves it — ask
   * `ctx.cms.call("pages.resolve_public_urls", {pageIds, pageUrlStyle})`
   * rather than composing one, so it equals the page's canonical (#590).
   * `lang` is the page's document language (BCP 47, set as `<html
   * lang>`; e.g. the page's locale) and overrides the site's stored
   * language for that page — it rides the `head` contribution kind. The
   * host Zod-validates every entry and serializes them itself — a plugin
   * can never inject raw head HTML.
   */
  readonly contributionsOperation?: string;
  /** See `pluginManifest.listSources`; resolved by `listSourcesOperation`. */
  readonly listSources?: ReadonlyArray<PluginListSourceSpec>;
  /** See `pluginManifest.listTypes`. */
  readonly listTypes?: ReadonlyArray<ListTypeDef>;
  /** See `pluginManifest.listExt`. */
  readonly listExt?: PluginListExt;
  /**
   * Operations reachable by an unauthenticated visitor through the API
   * gateway (`POST /api/plugin/<slug>/<operation>`).
   *
   * DEFAULT DENY. An operation not listed here cannot be dispatched
   * with a visitor context, no matter what route reaches for it.
   *
   * Declaring the visitor surface explicitly is the only workable
   * shape: a plugin's operation list mixes the two audiences freely —
   * `submit` next to `moderate`, `subscribe` next to `send_campaign`,
   * `me` next to `apply_auth_config` — and the difference is not
   * derivable from a name. An allowlist is also the half that a
   * reviewer can check at a glance, which a deny-list is not.
   *
   * Keep it minimal. Everything here runs for anyone on the internet,
   * with whatever capabilities the plugin was granted; the gateway
   * adds a body cap, a rate limit, a honeypot and CAPTCHA, but it
   * cannot know that an operation was meant for the Owner.
   */
  readonly publicOperations?: ReadonlyArray<string>;
  /**
   * The visitor-readable projection of this plugin's private storage
   * (`adminSchema`): table → the columns the API gateway may read (`id`
   * is always included). Issue #635 — the gateway has no cms_admin login,
   * so the admin PUBLISHES exactly these columns of the main-line rows
   * into cms_public, and in the gateway `ctx.adminQuery` is a read-only
   * handle over that projection. Anything not declared here is
   * unreachable from a visitor request.
   *
   * Keep it minimal: every declared column is readable by the public
   * side. Release-signed only (it projects `adminSchema`).
   *
   * @example
   *   visitorProjection: { settings: ["policy_version"], categories: ["key", "position"] }
   */
  readonly visitorProjection?: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * The I/O half of module deferrals: an operation in `operations`
   * taking `{moduleIds: string[], modules: DeferralCandidate[]}` (every
   * module in the current render pass, with the content about to ship)
   * and returning `{deferrals: Record<moduleId, ModuleDeferralSpec>}`.
   *
   * Withholding is per MODULE, not per placement: a video module
   * classified once is withheld everywhere it appears, including from
   * a layout. Return only the modules actually withheld — an absent id
   * renders normally.
   */
  readonly deferralsOperation?: string;
  /**
   * #592 — the content-variants composition point: which content a
   * placement shows on THIS page. An operation in `operations` taking
   * `{pages: ContentVariantPage[]}` (every page of the render pass with
   * its layout and page placements) and returning `{resolutions:
   * Record<pageId, Record<placementKey, ContentVariantResolution>>}`.
   * Without a plugin every placement renders as stored. The preview and
   * the static build both call it, so they cannot disagree. Internal
   * links inside the values need no rewriting here: core resolves them
   * per page through the `link-resolve` point. Requires the
   * `content_variants` capability.
   */
  readonly contentVariantsOperation?: string;
  /**
   * Epic #724 (rollout D) — the link-resolve composition point: where an
   * internal page link goes on THIS page. An operation in `operations`
   * taking `{pageIds: string[]}` (every page a render can link to — the
   * whole site in the render's scope) and returning `{pages:
   * Record<pageId, LinkResolvePageVariant>}`. Core maps each page
   * reference to the target's sibling in the rendering page's variant
   * (see {@link linkResolvePageVariant}); a page absent from the answer
   * is one the plugin has no opinion about. Called once per preview and
   * once per build, so preview, live-edit and the static build resolve
   * identically. Requires the `link_resolve` capability.
   *
   * @example
   *   link_resolve: async (_ctx, { pageIds }) => ({
   *     pages: { [pageIds[0]]: { variant: "de", group: "pricing" } },
   *   }),
   */
  readonly linkResolveOperation?: string;
  /**
   * Epic #724 (rollout E) — where this plugin's private storage holds
   * internal links, so core's link migration converts them to
   * references together with core content. An operation in `operations`
   * taking `{}` and returning `{locations: PluginLinkLocation[]}` (see
   * {@link pluginLinkLocation}). Core calls it as a render (read-only)
   * invocation: once on main and once per chat branch with pending work,
   * so the plugin's normal branch-aware reads return what each scope
   * sees. Core then reads, converts and writes the named columns itself,
   * snapshotted with the migration and reverted with it. Return every
   * row that MAY carry a link; rows without one cost nothing.
   */
  readonly linkLocationsOperation?: string;
  /**
   * Epic #1107 — Stage-audit contributions: an operation in `operations`
   * taking {@link PluginAuditFindingsArgs} (`{pages: [{pageId, path}]}`,
   * the published pages of the staged build) and returning
   * `{findings: PluginAuditFinding[]}` (see {@link pluginAuditFinding}).
   * Core calls it once per Stage audit as a render (read-only) invocation
   * on the main line — what the staged build was rendered from — and
   * files each finding under `plugin.<slug>/<rule>` in the same report
   * as core's checks. A finding may name only a page passed in. A
   * failing call or a malformed answer fails the audit loudly (no
   * silent "no findings").
   *
   * @example
   *   audit_findings: async (_ctx, { pages }) => ({
   *     findings: [{
   *       rule: "translation-missing", severity: "error", pageId: pages[0].pageId,
   *       message: "Translation missing: the German version of the menu entry \"Docs\" is empty.",
   *       fix: { tool: "translate_variant", hint: "translate the entry, then Stage again" },
   *     }],
   *   }),
   */
  readonly auditFindingsOperation?: string;
  /**
   * Epic #1107 — the I/O half of `listSources`: an operation in
   * `operations` taking `{pageIds: string[], pageUrlStyle: PageUrlStyle}`
   * (page links come from `pages.resolve_public_urls`, as for head
   * contributions) and returning `{sources: Record<pageId,
   * Record<sourceName, Array<{id: string, values: Record<string,
   * unknown>}>>>}`. Ids are stable per entry (an entry that means the
   * same thing on the next render keeps its id); values follow the
   * source's `node` fields and are validated by the host. Called once
   * per render pass, batched over the pages being rendered.
   *
   * @example
   *   language_links: async (_ctx, { pageIds }) => ({
   *     sources: { [pageIds[0]]: { language_links: [
   *       { id: "de", values: { label: "Deutsch", href: "https://x.de/", locale: "de", is_current: true } },
   *     ] } },
   *   }),
   */
  readonly listSourcesOperation?: string;
  /**
   * Epic #1107 — the `list-resolve` composition point (`docs/lists.md`
   * §9.3): an operation in `operations` taking `{variants: string[]}`
   * (the output variants of this render, from the `link-resolve`
   * partition) and returning `{overlays: Record<variant,
   * ListResolveVariantOverlay>}`. Called once per preview and once per
   * build, as a read-only render invocation (so a chat's preview sees
   * the chat's private storage). Requires the `list_resolve` capability.
   *
   * @example
   *   list_resolve: async () => ({
   *     overlays: { de: { values: { "list/<listId>/item/<itemId>/label": "Preise" }, hidden: [] } },
   *   }),
   */
  readonly listResolveOperation?: string;
  /**
   * The plugin's pages in the admin (see `./admin-panels.ts`). Declared as
   * data and rendered by the admin's one generic renderer at
   * `/plugins/<slug>/<panel>`, listed under "Plugins" in the side nav — only
   * while the plugin is active, and only for people holding the panel's
   * `permission`, which also gates every action on it. Every operation a
   * panel names must be in `operations`; they run as `owner-panel`
   * invocations by the signed-in person. The same for shipped and
   * runtime-installed plugins: no plugin ships admin UI code.
   */
  readonly adminPanels?: ReadonlyArray<PluginAdminPanel>;
}

/**
 * Define a plugin. Default-export factory — the host calls this at
 * load time. Returns the spec frozen to discourage mutation
 * post-registration.
 */
export function definePlugin<C extends PluginContext = PluginContext>(
  spec: PluginDefinition<C>,
): PluginDefinition<C> {
  return Object.freeze({ ...spec });
}

/**
 * Project a plugin definition onto its signable/persistable manifest.
 * ONE projection for every consumer — the host loader's `plugins` row,
 * the release/dev signing tooling, and the boot-time dev auto-signer all
 * derive the manifest from the built definition through this function,
 * so what gets signed is exactly what gets verified and persisted
 * (issue #387: three hand-kept copies had already drifted on optional
 * fields). Function bodies (operations, staticRender, …) never enter
 * the manifest — only their names/flags do.
 */
export function manifestFromDefinition(def: {
  readonly slug: string;
  readonly version: string;
  readonly tier: 1 | 2;
  readonly schema: PluginSchemaMap;
  readonly adminSchema?: PluginSchemaMap;
  readonly urlContributions?: ReadonlyArray<{ readonly slot: UrlSlot }>;
  readonly contributes?: ReadonlyArray<ContributionKind>;
  readonly listSources?: ReadonlyArray<PluginListSourceSpec>;
  readonly listTypes?: ReadonlyArray<ListTypeDef>;
  readonly listExt?: PluginListExt;
  readonly listResolveOperation?: string;
  readonly skills?: ReadonlyArray<PluginSkillSpec>;
  readonly operations: Readonly<Record<string, unknown>>;
  readonly component?: PluginComponent;
  readonly staticRender?: unknown;
  readonly buildAssets?: unknown;
  readonly deferralsOperation?: string;
  readonly contentVariantsOperation?: string;
  readonly linkResolveOperation?: string;
  readonly auditFindingsOperation?: string;
  readonly requestedCapabilities?: ReadonlyArray<PluginCapability>;
  readonly capabilityReasons?: PluginManifest["capabilityReasons"];
  readonly capabilityConstraints?: PluginManifest["capabilityConstraints"];
  readonly workers?: ReadonlyArray<PluginWorkerSpec>;
  readonly tools?: ReadonlyArray<PluginToolSpec>;
  readonly publicOperations?: ReadonlyArray<string>;
  readonly visitorProjection?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly adminPanels?: ReadonlyArray<PluginAdminPanel>;
  readonly requiresPlugins?: ReadonlyArray<string>;
  readonly consentPurposes?: ReadonlyArray<PluginConsentPurpose>;
}): PluginManifest {
  return pluginManifest.parse({
    slug: def.slug,
    version: def.version,
    tier: def.tier,
    schema: def.schema,
    ...(def.adminSchema ? { adminSchema: def.adminSchema } : {}),
    operations: Object.keys(def.operations),
    component: def.component
      ? { tag: def.component.tag, shadowMode: def.component.shadowMode ?? "open" }
      : undefined,
    hasStaticRender: Boolean(def.staticRender),
    ...(def.publicOperations && def.publicOperations.length > 0
      ? { publicOperations: [...def.publicOperations] }
      : {}),
    ...(def.visitorProjection && Object.keys(def.visitorProjection).length > 0
      ? {
          visitorProjection: Object.fromEntries(
            Object.entries(def.visitorProjection).map(([t, cols]) => [t, [...cols]]),
          ),
        }
      : {}),
    hasBuildAssets: Boolean(def.buildAssets),
    hasDeferrals: Boolean(def.deferralsOperation),
    hasContentVariants: Boolean(def.contentVariantsOperation),
    hasLinkResolve: Boolean(def.linkResolveOperation),
    hasListResolve: Boolean(def.listResolveOperation),
    ...(def.auditFindingsOperation ? { auditFindingsOperation: def.auditFindingsOperation } : {}),
    ...(def.requestedCapabilities ? { requestedCapabilities: [...def.requestedCapabilities] } : {}),
    ...(def.capabilityReasons ? { capabilityReasons: def.capabilityReasons } : {}),
    ...(def.capabilityConstraints ? { capabilityConstraints: def.capabilityConstraints } : {}),
    ...(def.workers ? { workers: [...def.workers] } : {}),
    ...(def.tools ? { tools: [...def.tools] } : {}),
    ...(def.skills ? { skills: [...def.skills] } : {}),
    ...(def.urlContributions && def.urlContributions.length > 0
      ? { urlContributions: def.urlContributions.map((c) => ({ slot: c.slot })) }
      : {}),
    ...(def.contributes && def.contributes.length > 0 ? { contributes: [...def.contributes] } : {}),
    ...(def.listSources && def.listSources.length > 0 ? { listSources: [...def.listSources] } : {}),
    ...(def.listTypes && def.listTypes.length > 0 ? { listTypes: [...def.listTypes] } : {}),
    ...(def.listExt ? { listExt: def.listExt } : {}),
    ...(def.adminPanels && def.adminPanels.length > 0 ? { adminPanels: [...def.adminPanels] } : {}),
    ...(def.requiresPlugins && def.requiresPlugins.length > 0
      ? { requiresPlugins: [...def.requiresPlugins] }
      : {}),
    ...(def.consentPurposes && def.consentPurposes.length > 0
      ? {
          consentPurposes: def.consentPurposes.map((p) => ({
            ...p,
            cookies: p.cookies.map((c) => ({ ...c })),
          })),
        }
      : {}),
  });
}

/**
 * Define a Web Component. Open Shadow DOM by default; closed mode
 * configurable. Theme tokens injected as CSS custom properties on the
 * shadow root automatically.
 */
export function defineComponent(
  spec: PluginComponent & {
    readonly mounted?: (host: HTMLElement, ctx: PluginFrontendContext) => Promise<void> | void;
  },
): PluginComponent & {
  readonly mounted?: (host: HTMLElement, ctx: PluginFrontendContext) => Promise<void> | void;
} {
  return Object.freeze({ ...spec, shadowMode: spec.shadowMode ?? "open" });
}

/** Optional author-preview contract; the host owns navigation and selection scripts. */
export type {
  PluginPreviewDocument,
  PluginPreviewSelection,
  PluginPreviewTarget,
} from "@caelo-cms/shared";
