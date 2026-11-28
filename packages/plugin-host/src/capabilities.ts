// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/capabilities — per-plugin context factory.
 *
 * Builds a fresh `PluginContext` (Tier 2) or `PluginContextTier1` for each
 * operation invocation. The handles are CLOSURES over the host infra + the
 * plugin's identity; they pass the plugin's actor id + plugin id into the
 * adapter's session vars so RLS scopes correctly.
 *
 * Capability gating: `ctx.cms` / `ctx.ai` / `ctx.email` are only attached
 * if the plugin's manifest declares the matching `requestedCapabilities`.
 * External plugins require exact Owner receipts as well as a supported broker.
 * Author storage is never attached to a visitor or render invocation.
 */

import type {
  PluginAdminQuery,
  PluginCapability,
  PluginCaptcha,
  PluginChanges,
  PluginCms,
  PluginContext,
  PluginContextTier1,
  PluginImports,
  PluginInvocation,
  PluginQuery,
  PluginQueryFilter,
  PluginTheme,
  PluginUpsertResult,
  PluginVisitor,
  PublicOperationDef,
} from "@caelo-cms/plugin-sdk";
import {
  admitsPlugins,
  type DatabaseAdapter,
  execute,
  joinHeldTransaction,
  pluginAccessOf,
} from "@caelo-cms/query-api";
import { LIVE_BUILD_REFUSAL, type LiveBuildUrls } from "@caelo-cms/shared";
import { registerPluginChangeOps } from "./change-consumers.js";
import { makePluginChatTools, makePluginCollections } from "./collections-host.js";
import { hasConfig, makePluginConfigReader } from "./config-handle.js";
import { makePluginConsentPurposes } from "./consent-purposes.js";
import {
  hostSystemActorId,
  type LoadedPlugin,
  type PluginHostInfra,
  type VisitorCaptchaVerdict,
} from "./dispatch.js";
import { operatorCanAuthor } from "./external-authorization.js";
import { makePluginFonts } from "./fonts.js";
import { makePluginImages } from "./images.js";
import { type ImportView, importViewOf, makePluginImports } from "./import-rows.js";
import { makePluginEmail } from "./mail-queue.js";
import { makePluginAi } from "./plugin-ai.js";
import { timedPluginOpCall } from "./plugin-runtime-stats.js";
import { makePluginPrivateFiles } from "./private-files.js";
import { validatePublicRows } from "./public-row-schema.js";
import { isPublicSideHost, makeProjectedAdminQuery } from "./published-state.js";
import type { SandboxKind } from "./sandbox-kind.js";
import { makePluginSiteMedia } from "./site-media.js";
import { registerPluginStorageOps, STORAGE_OPS, UPDATE_MANY_MAX } from "./storage-ops.js";
import { checkUrlTableWrite, type UrlTableWrite, urlTableRole } from "./url-tables.js";

export interface MakePluginContextOpts {
  readonly plugin: LoadedPlugin;
  readonly infra: PluginHostInfra;
  readonly visitorContext?: VisitorContext;
  readonly invocation: PluginInvocation;
  /** #1332 — the visitor operation being served, whose `reads` / `writes`
   *  are the only public tables `ctx.query` may touch on that call. */
  readonly publicOperation?: PublicOperationDef;
  /**
   * #1333 — which public database `ctx.query` works on (admin side only).
   * `"staging"` binds it to cms_public_staging and attaches nothing else:
   * a worker declared `publicDatabases: "each"` recomputing the staging
   * site's derived rows from the staging site's own visitors.
   */
  readonly publicTarget?: "live" | "staging";
  /**
   * #1495 — a plugin-data build's render: page URLs come from the live
   * build. Kept off `invocation`, which is handed to plugin code.
   */
  readonly liveUrls?: LiveBuildUrls;
  /**
   * #1729 — what the call is for when its origin does not say it (a
   * change-journal batch or a rebuild chunk, dispatch.ts). Host-only, like
   * `liveUrls`: it decides what the handles allow.
   */
  readonly sandboxKind?: SandboxKind;
}

/**
 * Per-request visitor context, populated by the gateway from cookies.
 * `sessionMutation` is mutated by the auth plugin's setSession; the
 * gateway reads it after dispatch to emit the right Set-Cookie header.
 */
export interface VisitorContext {
  /** Null when the visitor has not consented to being recognised (#677). */
  readonly visitorId: string | null;
  readonly sessionToken: string | null;
  readonly captcha: VisitorCaptchaVerdict;
  readonly sessionMutation?: { current: SessionMutation };
}

export type SessionMutation =
  | { kind: "none" }
  | { kind: "set"; sessionToken: string; expiresAt: string }
  | { kind: "clear" };

/**
 * Build the per-call context. Returns the locked base PluginContext for
 * runtime-authored plugins and an extended PluginContextTier1 for
 * release-signed plugins (with only the requested capability handles
 * attached) — provenance is the ceiling, the capability set the grant.
 */
export async function makePluginContext(
  opts: MakePluginContextOpts,
): Promise<PluginContext | PluginContextTier1> {
  const { plugin, infra, visitorContext, invocation } = opts;
  const requested = new Set<PluginCapability>(plugin.definition.requestedCapabilities ?? []);
  if (invocation.origin === "visitor" && !opts.publicOperation) {
    // Dispatch resolves the contract before it builds a visitor context;
    // without one there is nothing to bound the call's table access by.
    throw new Error("a visitor call needs its declared public operation");
  }

  if (opts.publicTarget === "staging") {
    if (isPublicSideHost(infra) || !infra.stagingAdapter) {
      throw new Error(
        `plugin "${plugin.slug}": a staging-database run needs the admin's adapter on cms_public_staging (PluginHostInfra.stagingAdapter)`,
      );
    }
    const stagingAdapter = infra.stagingAdapter;
    return {
      query: makePluginQuery(plugin, infra, invocation, undefined, stagingAdapter),
      api: makePluginApi(plugin, infra),
      theme: makePluginTheme(),
      visitor: makePluginVisitor(undefined),
      captcha: makePluginCaptcha(undefined),
      invocation: Object.freeze({ ...invocation }),
      ...importsHandle(plugin, infra, "staging"),
    };
  }

  // #1645 — the plugin's own configuration, on every admin-side origin. The
  // gateway has no cms_admin login and visitors' calls never read it.
  const configHandle =
    hasConfig(plugin) && !isPublicSideHost(infra) && invocation.origin !== "visitor"
      ? { config: makePluginConfigReader(plugin, infra, invocation) }
      : {};
  // #1648 — collections need their grant; the gateway reads them only
  // through declared collection operations, never through plugin code.
  const collectionsGranted =
    plugin.provenance === "runtime-authored"
      ? (plugin.externalApproval?.capabilities.includes("collections") ?? false)
      : requested.has("collections");
  const collectionsHandle =
    collectionsGranted &&
    Object.keys(plugin.definition.collections ?? {}).length > 0 &&
    !isPublicSideHost(infra) &&
    invocation.origin !== "visitor"
      ? // A render (and the Stage audit, which calls as one) may query; its
        // writes are refused by the handle.
        { collections: makePluginCollections(plugin, infra, invocation) }
      : {};
  // #1655 — a conversation's declared tools, run as the gateway runs them
  // (the Stage audit, previews): on the admin side, with the visitor_ai grant.
  const visitorAiGranted =
    plugin.provenance === "runtime-authored"
      ? (plugin.externalApproval?.capabilities.includes("visitor_ai") ?? false)
      : requested.has("visitor_ai");
  const chatToolsHandle =
    visitorAiGranted &&
    (plugin.definition.aiChatOperations ?? []).length > 0 &&
    !isPublicSideHost(infra) &&
    invocation.origin !== "visitor"
      ? { chatTools: makePluginChatTools(plugin, infra) }
      : {};
  // #1729 — the plugin's own change consumer: its cursor state needs only
  // the change_journal grant, never cms_admin, and no visitor call asks it.
  const changeJournalGranted =
    plugin.provenance === "runtime-authored"
      ? (plugin.externalApproval?.capabilities.includes("change_journal") ?? false)
      : requested.has("change_journal");
  const changesHandle =
    changeJournalGranted &&
    plugin.definition.changeConsumer &&
    !isPublicSideHost(infra) &&
    invocation.origin !== "visitor"
      ? { changes: makePluginChanges(plugin, infra) }
      : {};
  const baseCtx: PluginContext = {
    query: makePluginQuery(
      plugin,
      infra,
      invocation,
      opts.publicOperation,
      undefined,
      opts.sandboxKind,
    ),
    api: makePluginApi(plugin, infra),
    theme: makePluginTheme(),
    visitor: makePluginVisitor(visitorContext),
    captcha: makePluginCaptcha(visitorContext),
    invocation: Object.freeze({ ...invocation }),
    ...configHandle,
    ...collectionsHandle,
    ...chatToolsHandle,
    ...changesHandle,
    ...(!isPublicSideHost(infra) && invocation.origin !== "visitor"
      ? importsHandle(plugin, infra, importViewOf(invocation, opts.publicTarget))
      : {}),
  };

  // Runtime-installed plugins run in the sandbox and get only what an
  // Owner approved for this exact artifact (§14.5): author handles never on
  // a render or visitor call, for a human only when they may author
  // content, and private storage on main in the calls that act for nobody.
  if (plugin.provenance === "runtime-authored") {
    const approval = plugin.externalApproval;
    if (!approval) return baseCtx;
    // The declared purposes are manifest metadata, not author data: a
    // granted consent provider reads them on every origin — the gateway
    // asks for its rule as `system`, never on someone's behalf.
    const consentCtx: PluginContext | PluginContextTier1 = approval.capabilities.includes(
      "consent_provider",
    )
      ? { ...baseCtx, consentPurposes: makePluginConsentPurposes() }
      : baseCtx;
    // #635 — the gateway reads the private columns the manifest publishes
    // to visitors (`visitorProjection`), read-only, as for a shipped plugin;
    // a declared public operation is core code running on this handle.
    if (isPublicSideHost(infra)) {
      const gatewayCtx: Mutable<PluginContextTier1> = { ...consentCtx };
      if (
        approval.capabilities.includes("cms_admin_schema") &&
        Object.keys(plugin.definition.visitorProjection ?? {}).length > 0
      ) {
        gatewayCtx.adminQuery = makeProjectedAdminQuery(plugin, infra);
      }
      // #1729 — the declared mail blocks (double opt-in, visitor accounts)
      // queue the plugin's reviewed templates; no plugin code runs here.
      if (approval.capabilities.includes("email")) {
        gatewayCtx.email = makePluginEmail(plugin, infra, {
          publicAdapter: infra.adapter,
          publicSide: true,
          invocation,
        });
      }
      return gatewayCtx;
    }
    // #1729 (§7.1) — core operations through the cms_admin broker: only
    // the operations the receipt names, read-only on a render, on the
    // invocation's branch. The same rules hold every plugin's ctx.cms.
    const cmsCtx: PluginContext | PluginContextTier1 =
      approval.capabilities.includes("cms_admin") && !visitorContext
        ? {
            ...consentCtx,
            cms: makePluginCms(plugin, infra, invocation, {
              allowed: new Set(approval.cmsOperations ?? []),
              ...(opts.sandboxKind ? { kind: opts.sandboxKind } : {}),
              // #1495 — a live build's refusal is recorded host-side, so a
              // plugin that catches the error cannot hide it from the build.
              ...(opts.liveUrls ? { liveUrls: opts.liveUrls } : {}),
            }),
          }
        : consentCtx;
    // #1729 (§7.2, §7.3) — the AI and mail handles from the receipts, with
    // the checks a shipped plugin's hold (caps, origins, own templates).
    // Unlike ctx.cms they are not author data: a call for someone who may
    // not author keeps them, as a shipped plugin's does.
    const callCtx = withExternalCallHandles(cmsCtx, plugin, infra, invocation);
    const nonAuthorCtx = withExternalCallHandles(consentCtx, plugin, infra, invocation);
    // #1729 (decision Q1 A) — a call that acts for nobody (a worker run,
    // `onActivate`, a journal batch or rebuild, an observer, a batch) is
    // the Owner's grant working unattended: private storage as the plugin
    // actor, through the audited and snapshotted `plugin_storage.*`
    // operations, as a shipped plugin's worker has it. On main, except a
    // journal batch on a chat's branch, whose writes land on that branch
    // and are staged with it (§5.2).
    const journalWork = opts.sandboxKind === "journal" || opts.sandboxKind === "rebuild";
    if (
      !visitorContext &&
      ((UNATTENDED_ORIGINS.has(invocation.origin) && !invocation.chatBranchId) || journalWork)
    ) {
      return approval.capabilities.includes("cms_admin_schema")
        ? { ...callCtx, adminQuery: makePluginAdminQuery(plugin, infra, invocation) }
        : callCtx;
    }
    // #1729 — a render point (list sources, head entries, …) reads the
    // plugin's private storage on the render's branch, as a shipped
    // plugin's render does, and core data through ctx.cms. Both handles
    // refuse every write from a render (`assertAuthoring`, the cms
    // broker's pluginAccess rule), so a page view never changes data.
    if (!visitorContext && invocation.origin === "render") {
      return approval.capabilities.includes("cms_admin_schema")
        ? { ...callCtx, adminQuery: makePluginAdminQuery(plugin, infra, invocation) }
        : callCtx;
    }
    if (visitorContext || !AUTHORING_ORIGINS.has(invocation.origin)) return nonAuthorCtx;
    const wantsStorage = approval.capabilities.includes("cms_admin_schema");
    const wantsFiles = approval.capabilities.includes("private_files");
    // Image generation stores its results as private files, so it needs both.
    const wantsImages = wantsFiles && approval.capabilities.includes("image_generation");
    const wantsFonts = approval.capabilities.includes("font_assets");
    const wantsSiteMedia = approval.capabilities.includes("site_media_read");
    const wantsCms = approval.capabilities.includes("cms_admin");
    if (!wantsStorage && !wantsFiles && !wantsFonts && !wantsSiteMedia && !wantsCms) {
      return nonAuthorCtx;
    }
    // Private storage and files are author data: only for someone who may
    // author. Without it the plugin still runs, with the base handles — an
    // operation that needs them then fails at the sandbox broker
    // (SandboxCapabilityDenied), not silently.
    if (!(await authorMayWrite(infra, approval.systemActorId, invocation))) return nonAuthorCtx;
    return {
      ...callCtx,
      ...(wantsStorage ? { adminQuery: makePluginAdminQuery(plugin, infra, invocation) } : {}),
      ...(wantsFiles ? { privateFiles: makePluginPrivateFiles(plugin, infra, invocation) } : {}),
      ...(wantsImages ? { images: makePluginImages(plugin, infra, invocation) } : {}),
      ...(wantsFonts ? { fonts: makePluginFonts(plugin, infra, invocation) } : {}),
      ...(wantsSiteMedia ? { siteMedia: makePluginSiteMedia(plugin, infra, invocation) } : {}),
    };
  }

  // Release-signed — attach elevated handles per requestedCapabilities.
  const tier1: Mutable<PluginContextTier1> = { ...baseCtx };
  // Read from this host's own registry, so it works the same on the
  // public gateway (which asks the provider for its rule) and the admin.
  if (requested.has("consent_provider")) tier1.consentPurposes = makePluginConsentPurposes();
  if (isPublicSideHost(infra)) {
    // #635 — the public gateway has no cms_admin login. Private storage is
    // the read-only published `visitorProjection`; `ctx.cms` reaches only
    // the gateway's own registry (core ops backed by cms_public). Handles
    // that need the authoring database (events, AI, files,
    // fonts, media) are not attached at all, so a visitor operation that
    // reaches for one fails at the plugin, by name.
    if (requested.has("cms_admin")) tier1.cms = makePluginCms(plugin, infra, invocation, {});
    if (requested.has("cms_admin_schema")) {
      tier1.adminQuery = makeProjectedAdminQuery(plugin, infra);
    }
    if (requested.has("email")) {
      tier1.email = makePluginEmail(plugin, infra, {
        publicAdapter: infra.adapter,
        publicSide: true,
        invocation,
      });
    }
    return tier1;
  }
  if (requested.has("cms_admin")) {
    tier1.cms = makePluginCms(plugin, infra, invocation, {
      ...(opts.liveUrls ? { liveUrls: opts.liveUrls } : {}),
      ...(opts.sandboxKind ? { kind: opts.sandboxKind } : {}),
    });
  }
  if (requested.has("cms_admin_schema")) {
    tier1.adminQuery = makePluginAdminQuery(plugin, infra, invocation);
  }
  if (requested.has("ai_provider") && infra.aiProvider) {
    tier1.ai = makePluginAi(plugin, infra, invocation);
  }
  if (requested.has("email")) {
    // #1337 — on the admin side a queued mail goes to the live outbox.
    tier1.email = makePluginEmail(plugin, infra, {
      publicAdapter: infra.adapter,
      publicSide: false,
      invocation,
    });
  }
  // Shipped plugins get private files on the same author terms as installed ones.
  if (
    requested.has("private_files") &&
    !visitorContext &&
    AUTHORING_ORIGINS.has(invocation.origin) &&
    (await authorMayWrite(infra, hostSystemActorId(), invocation))
  ) {
    tier1.privateFiles = makePluginPrivateFiles(plugin, infra, invocation);
    if (requested.has("image_generation")) {
      tier1.images = makePluginImages(plugin, infra, invocation);
    }
  }
  if (
    requested.has("font_assets") &&
    !visitorContext &&
    AUTHORING_ORIGINS.has(invocation.origin) &&
    (await authorMayWrite(infra, hostSystemActorId(), invocation))
  ) {
    tier1.fonts = makePluginFonts(plugin, infra, invocation);
  }
  if (
    requested.has("site_media_read") &&
    !visitorContext &&
    AUTHORING_ORIGINS.has(invocation.origin) &&
    (await authorMayWrite(infra, hostSystemActorId(), invocation))
  ) {
    tier1.siteMedia = makePluginSiteMedia(plugin, infra, invocation);
  }
  return tier1;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * #1729 — the brokered call handles of a runtime-installed plugin on the
 * admin side, from its receipts: `ctx.ai` (`ai_provider`) and `ctx.email`
 * (`email`, queue and unsubscribe link only, decision Q5 A). They hold the
 * same checks as a shipped plugin's (principle 1): the AI one refuses a
 * render and spends under the plugin's caps, the email one refuses the
 * origins no mail may come from.
 */
function withExternalCallHandles(
  ctx: PluginContext,
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
): PluginContext | PluginContextTier1 {
  const capabilities = plugin.externalApproval?.capabilities ?? [];
  const handles: Mutable<Pick<PluginContextTier1, "ai" | "email">> = {};
  if (capabilities.includes("ai_provider") && infra.aiProvider) {
    handles.ai = makePluginAi(plugin, infra, invocation);
  }
  if (capabilities.includes("email")) {
    handles.email = makePluginEmail(plugin, infra, {
      publicAdapter: infra.adapter,
      publicSide: false,
      invocation,
    });
  }
  return { ...ctx, ...handles };
}

/** Whether the human an authoring invocation acts for may author content. */
async function authorMayWrite(
  infra: PluginHostInfra,
  systemActorId: string,
  invocation: PluginInvocation,
): Promise<boolean> {
  const operator = invocation.origin === "chat" ? invocation.operatorActorId : invocation.actorId;
  return Boolean(operator) && (await operatorCanAuthor(infra, systemActorId, operator as string));
}

/** Invocations that author content on someone's behalf. */
const AUTHORING_ORIGINS: ReadonlySet<string> = new Set(["chat", "owner-panel", "approved"]);

/** Invocations the host starts on nobody's behalf (#1729 Q1). */
const UNATTENDED_ORIGINS: ReadonlySet<string> = new Set(["worker", "system", "observer", "batch"]);

// ---------------------------------------------------------------------------
// PluginQuery (P12 PR1.1) — real cms_public dispatch.
//
// Routes against the public Postgres pool. Each call opens its own tx,
// sets `caelo.plugin_id` + `caelo.actor_kind = 'plugin'` so the per-plugin
// RLS policy emitted by plugin-sandbox/schema.ts gates every row read +
// write. Identifiers (table + column names) are validated against the
// plugin's manifest.schema before being interpolated; values flow through
// parameterised SQL — no raw SQL crosses the boundary.
// ---------------------------------------------------------------------------

const SAFE_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function pluginSchemaName(slug: string): string {
  return `plugin_${slug.replace(/-/g, "_")}`;
}

/** Declared column name → its type spec, or null when the table is not
 *  the plugin's. Callers need the spec, not just the name, to bind a
 *  jsonb value correctly. */
function declaredColumnsIn(
  schemaMap: Readonly<Record<string, Readonly<Record<string, string>>>>,
  table: string,
): Map<string, string> | null {
  const tableSpec = schemaMap[table];
  if (!tableSpec) return null;
  return new Map(Object.entries(tableSpec));
}

function validateIdent(name: string, label: string): void {
  if (!SAFE_IDENT_RE.test(name)) {
    throw new Error(
      `ctx.query: refusing to interpolate ${label} "${name}" (must match ${SAFE_IDENT_RE})`,
    );
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`ctx.query: refusing to set session var ${label}: not a UUID (${value})`);
  }
}

interface QueryScope {
  /** Error-message prefix — "ctx.query" | "ctx.adminQuery". */
  readonly label: string;
  /** #1729 — the call's kind when its origin does not say it (MakePluginContextOpts.sandboxKind). */
  readonly kind?: SandboxKind;
  /** Which manifest map declares the reachable tables. */
  readonly schemaLabel: "schema" | "adminSchema";
  readonly schemaMap: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly pool: "public" | "admin";
  /** #1332 — on a visitor call, the contract bounding which tables it reaches. */
  readonly publicOperation?: PublicOperationDef;
  /** #1333 — the adapter of the public database to use; the host's own unless given. */
  readonly adapter?: DatabaseAdapter;
}

/**
 * The plugin's storage handle — a broker over the `plugin_storage.*` /
 * `plugin_public_storage.*` Query API operations (storage-ops.ts). It
 * validates each call against the plugin's manifest (so error messages
 * name the plugin and its schema) and never issues SQL itself
 * (CMS_REQUIREMENTS §14.7).
 */
function makeScopedQuery(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
  scope: QueryScope,
): PluginQuery & Partial<Pick<PluginAdminQuery, "upsert">> {
  const schemaName = pluginSchemaName(plugin.slug);
  validateIdent(schemaName, "schema");
  // Validated at construction so a bad id fails the moment the handle is
  // built; the adapter binds them as parameters either way.
  assertUuid(plugin.pluginActorId, "caelo.actor_id");
  assertUuid(plugin.pluginId, "caelo.plugin_id");
  const ops = STORAGE_OPS[scope.pool === "admin" ? "private" : "public"];
  // Private storage follows the invocation's branch: a chat's writes land
  // on its branch, everything else on main (docs/branch-aware-plugin-
  // storage.md). Public storage is visitor data and always live.
  const branch =
    scope.pool === "admin" && invocation.chatBranchId
      ? {
          chatBranchId: invocation.chatBranchId,
          ...(invocation.chatTaskId ? { chatTaskId: invocation.chatTaskId } : {}),
        }
      : {};
  const ctx = {
    actorId: plugin.pluginActorId,
    actorKind: "plugin" as const,
    pluginId: plugin.pluginId,
    requestId: `plugin-${plugin.slug}`,
    ...branch,
    ...(plugin.externalApproval
      ? { pluginArtifactDigest: plugin.externalApproval.artifactDigest }
      : {}),
  };

  /**
   * Rendering and visitor requests are not authoring contexts: a write to
   * private storage from one would change author data outside any chat or
   * Owner action (CMS_REQUIREMENTS §14.7). Seed data in `onActivate`.
   */
  function assertAuthoring(method: string): void {
    // #1212 — a render call only reads, from either pool: the preview
    // runs every render hook on every view of every page, and a write
    // from one would change plugin data because someone looked at a page.
    // It is also why dispatch keeps no audit row per render call.
    if (invocation.origin === "render") {
      throw new Error(
        `${scope.label}.${method}: plugin "${plugin.slug}" cannot write from a render call — render hooks only read; write from a chat tool, the Owner panel, a worker or onActivate`,
      );
    }
    // #1729 (decision Q12) — a change-journal batch on main sees staged
    // content, and a rebuild reads the whole source: copying either into a
    // public table would show visitors what is not published. For every
    // plugin, as for observers and batches below.
    if (scope.pool !== "admin" && (scope.kind === "journal" || scope.kind === "rebuild")) {
      throw new Error(
        `${scope.label}.${method}: plugin "${plugin.slug}" cannot write its public tables from ${scope.kind === "journal" ? "a change-journal batch" : "a change-journal rebuild"} — it can see staged work, and visitors would see it before Publish live; keep derived state in private storage, or write public rows from a worker`,
      );
    }
    if (
      scope.pool !== "admin" &&
      (invocation.origin === "observer" || invocation.origin === "batch")
    ) {
      throw new Error(
        `${scope.label}.${method}: plugin "${plugin.slug}" cannot write its public tables from ${invocation.origin === "observer" ? "a page-output observer" : "a batch job"} — that is staged work, and visitors would see it before Publish live; write collections or private storage`,
      );
    }
    if (scope.pool !== "admin") {
      // Public tables hold visitor data and have no branch: a write from a
      // chat would go live before publish. Installed plugins keep chat
      // work in private storage (which branches); visitors, the Owner
      // panel and actions approved by someone who may publish write live.
      if (plugin.externalApproval && invocation.chatBranchId) {
        throw new Error(
          `${scope.label}.${method}: plugin "${plugin.slug}" cannot write its public tables from a chat — they are live visitor data; keep chat work in private storage (adminQuery)`,
        );
      }
      return;
    }
    if (invocation.origin === "visitor") {
      throw new Error(
        `${scope.label}.${method}: plugin "${plugin.slug}" cannot write its private storage from a ${invocation.origin} call — write from a chat tool, the Owner panel, a worker or onActivate`,
      );
    }
  }

  /**
   * #1332 — a visitor call reaches only the tables its operation declares:
   * `reads` for `list`, `writes` for every write. The database grants by
   * table kind are the boundary (the gateway is assumed compromised); this
   * keeps an honest plugin's declaration exact, so the manifest the Owner
   * reviewed says what the operation does.
   */
  function assertDeclaredAccess(method: string, table: string): void {
    const op = scope.publicOperation;
    if (!op || scope.pool !== "public") return;
    const read = method === "list";
    const declared = read ? op.reads : op.writes;
    if (!(declared ?? []).includes(table)) {
      throw new Error(
        `${scope.label}.${method}: public operation "${op.name}" of plugin "${plugin.slug}" does not declare "${table}" in its ${read ? "reads" : "writes"}`,
      );
    }
  }

  /** The table's declared column map, or a loud error naming the plugin. */
  function tableColumns(method: string, table: string): Record<string, string> {
    validateIdent(table, "table");
    assertDeclaredAccess(method, table);
    const declared = declaredColumnsIn(scope.schemaMap, table);
    if (!declared) {
      throw new Error(
        `${scope.label}.${method}: table "${table}" not declared in plugin "${plugin.slug}".${scope.schemaLabel}`,
      );
    }
    return Object.fromEntries(declared);
  }

  function assertDeclared(
    method: string,
    table: string,
    columns: Record<string, string>,
    keys: Iterable<string>,
  ): void {
    for (const k of keys) {
      if (!(k in columns)) {
        throw new Error(
          `${scope.label}.${method}: column "${k}" not declared in plugin "${plugin.slug}".${scope.schemaLabel}.${table}`,
        );
      }
      validateIdent(k, "column");
    }
  }

  async function run<T>(opName: string, input: unknown): Promise<T> {
    // Registered on first use, not at construction: building a context
    // must not touch the registry (the handles are lazy by design).
    registerPluginStorageOps(infra.registry, { lockPluginRow: infra.lockPluginRow });
    const r = await timedPluginOpCall(plugin.slug, opName, () =>
      execute(infra.registry, scope.adapter ?? infra.adapter, ctx, opName, input),
    );
    if (!r.ok) {
      throw new Error("message" in r.error ? String(r.error.message) : r.error.kind);
    }
    return r.value as T;
  }

  /**
   * #1729 — a declared URL table (`urlTables`) shapes page addresses: it
   * changes only in an Owner-approved call, and never into a collision, an
   * unserved host or a page naming a missing value (url-tables.ts). For
   * every plugin that declares one.
   *
   * The checks read the tables and the write changes them in ONE
   * transaction, under the plugin's URL-table lock taken before the first
   * read (`plugin_storage.lock_url_tables`): every read and the write join
   * it (joinHeldTransaction), so two approved writes at once cannot both
   * pass checks made before either was stored. A write to any other table
   * runs as before.
   */
  async function urlTableWrite<T>(write: UrlTableWrite, perform: () => Promise<T>): Promise<T> {
    const tables = plugin.definition.urlTables;
    if (scope.pool !== "admin" || !tables || urlTableRole(tables, write.table) === null) {
      return perform();
    }
    registerPluginStorageOps(infra.registry, { lockPluginRow: infra.lockPluginRow });
    const adapter = scope.adapter ?? infra.adapter;
    return adapter.withAdminTransaction(
      ctx,
      () =>
        joinHeldTransaction(async () => {
          await run(STORAGE_OPS.private.lockUrlTables, {});
          await checkUrlTableWrite({
            pluginSlug: plugin.slug,
            tables,
            invocation,
            write,
            list: (t, f) => handle.list(t, f),
          });
          return perform();
        }),
      { holder: `plugin ${plugin.slug} url-table ${write.method}` },
    );
  }

  const handle: PluginQuery & Partial<Pick<PluginAdminQuery, "upsert">> = {
    insert: async (table, data) => {
      const tableStr = table as string;
      assertAuthoring("insert");
      const columns = tableColumns("insert", tableStr);
      assertDeclared("insert", tableStr, columns, Object.keys(data));
      if (Object.keys(data).length === 0) {
        throw new Error(`${scope.label}.insert: data must include at least one declared column`);
      }
      return urlTableWrite({ method: "insert", table: tableStr, data }, () =>
        run<{ id: string }>(ops.insert, {
          schema: schemaName,
          table: tableStr,
          columns,
          data,
        }),
      );
    },

    list: async <T = Record<string, unknown>>(
      table: string,
      filter?: PluginQueryFilter,
    ): Promise<T[]> => {
      const columns = tableColumns("list", table);
      const reserved = new Set([
        "limit",
        "orderBy",
        "orderDir",
        "since",
        "before",
        "anyOf",
        "afterId",
      ]);
      for (const [k, v] of Object.entries(filter ?? {})) {
        if (k === "limit" && (typeof v !== "number" || v <= 0 || v > 1000)) {
          throw new Error(`${scope.label}.list: limit must be 1..1000`);
        }
        if (k === "anyOf" && v !== null && typeof v === "object" && !Array.isArray(v)) {
          // Name the plugin's schema in the error; the op re-checks values.
          // `id` is host-owned but listable (#1269).
          assertDeclared(
            "list",
            table,
            columns,
            Object.keys(v).filter((c) => c !== "id"),
          );
        }
        if (k === "orderBy") {
          if (typeof v !== "string") throw new Error(`${scope.label}.list: orderBy must be string`);
          // `id` is host-owned but orderable: `afterId` pages by it (#1213).
          if (v !== "id" && !(v in columns)) {
            throw new Error(`${scope.label}.list: orderBy "${v}" not declared in schema`);
          }
        }
        if (k === "orderDir" && v !== "asc" && v !== "desc") {
          throw new Error(`${scope.label}.list: orderDir must be asc|desc`);
        }
        if (k === "since" || k === "before") {
          if (typeof v !== "string") {
            throw new Error(`${scope.label}.list: ${k} must be ISO timestamp string`);
          }
          if (!("created_at" in columns)) {
            throw new Error(`${scope.label}.list: \`${k}\` requires a created_at column`);
          }
        }
        if (!reserved.has(k)) assertDeclared("list", table, columns, [k]);
      }
      const out = await run<{ rows: T[] }>(ops.list, {
        schema: schemaName,
        table,
        columns,
        ...(filter ? { filter } : {}),
      });
      // #635 — on the admin side, rows of a public table were written by
      // the public side: validated against the declaration before the
      // plugin's code sees them (public-row-schema.ts).
      if (scope.pool === "public" && !isPublicSideHost(infra)) {
        return validatePublicRows<T>(plugin.slug, table, columns, out.rows);
      }
      return out.rows;
    },

    update: async (table, id, patch) => {
      const tableStr = table as string;
      assertAuthoring("update");
      const columns = tableColumns("update", tableStr);
      const keys = Object.keys(patch).filter((k) => k !== "id");
      assertDeclared("update", tableStr, columns, keys);
      if (keys.length === 0) {
        throw new Error(`${scope.label}.update: patch must include at least one declared column`);
      }
      await urlTableWrite({ method: "update", table: tableStr, id, data: patch }, () =>
        run(ops.update, { schema: schemaName, table: tableStr, columns, id, patch }),
      );
    },

    updateMany: async (table, ids, patch) => {
      const tableStr = table as string;
      assertAuthoring("updateMany");
      const columns = tableColumns("updateMany", tableStr);
      const keys = Object.keys(patch).filter((k) => k !== "id");
      assertDeclared("updateMany", tableStr, columns, keys);
      if (keys.length === 0) {
        throw new Error(
          `${scope.label}.updateMany: patch must include at least one declared column`,
        );
      }
      if (ids.length === 0) return;
      if (ids.length > UPDATE_MANY_MAX) {
        throw new Error(
          `${scope.label}.updateMany: at most ${UPDATE_MANY_MAX} ids per call — split the list into several calls`,
        );
      }
      await urlTableWrite({ method: "updateMany", table: tableStr, data: patch }, () =>
        run(ops.updateMany, {
          schema: schemaName,
          table: tableStr,
          columns,
          ids: [...ids],
          patch,
        }),
      );
    },

    delete: async (table, id) => {
      const tableStr = table as string;
      assertAuthoring("delete");
      const columns = tableColumns("delete", tableStr);
      await urlTableWrite({ method: "delete", table: tableStr, id }, () =>
        run(ops.delete, { schema: schemaName, table: tableStr, columns, id }),
      );
    },

    compareAndSwap: async (table, id, expected, patch) => {
      const tableStr = table as string;
      assertAuthoring("compareAndSwap");
      const columns = tableColumns("compareAndSwap", tableStr);
      const out = await urlTableWrite(
        { method: "compareAndSwap", table: tableStr, id, data: patch },
        () =>
          run<{ swapped: boolean }>(ops.compareAndSwap, {
            schema: schemaName,
            table: tableStr,
            columns,
            id,
            expected,
            patch,
          }),
      );
      return out.swapped;
    },

    // #1659 — private storage only (see makePluginAdminQuery).
    ...(scope.pool === "admin"
      ? {
          upsert: async (table, key, values, options) => {
            const tableStr = table as string;
            assertAuthoring("upsert");
            const columns = tableColumns("upsert", tableStr);
            assertDeclared("upsert", tableStr, columns, [
              ...Object.keys(key),
              ...Object.keys(values),
            ]);
            return urlTableWrite(
              { method: "upsert", table: tableStr, key, data: { ...key, ...values } },
              () =>
                run<PluginUpsertResult>(STORAGE_OPS.private.upsert, {
                  schema: schemaName,
                  table: tableStr,
                  columns,
                  key,
                  values,
                  ifExists: options?.ifExists ?? "update",
                }),
            );
          },
        }
      : {}),
  };
  return handle;
}

function makePluginQuery(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
  publicOperation: PublicOperationDef | undefined,
  adapter?: DatabaseAdapter,
  kind?: SandboxKind,
): PluginQuery {
  return makeScopedQuery(plugin, infra, invocation, {
    label: "ctx.query",
    schemaLabel: "schema",
    schemaMap: plugin.definition.schema,
    pool: "public",
    ...(publicOperation ? { publicOperation } : {}),
    ...(adapter ? { adapter } : {}),
    ...(kind ? { kind } : {}),
  });
}

/**
 * #389 — the plugin's OWN cms_admin schema handle. Identical surface to
 * ctx.query, routed through the ADMIN pool with the same per-plugin
 * session vars, reaching only tables declared in `adminSchema` (their
 * RLS policies scope rows to this plugin's id). Attached by
 * makePluginContext only when the manifest holds `cms_admin_schema`.
 */
function makePluginAdminQuery(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
): PluginAdminQuery {
  const handle = makeScopedQuery(plugin, infra, invocation, {
    label: "ctx.adminQuery",
    schemaLabel: "adminSchema",
    schemaMap: plugin.definition.adminSchema ?? {},
    pool: "admin",
  });
  const { upsert } = handle;
  if (!upsert) throw new Error("ctx.adminQuery: the admin pool's handle has no upsert");
  return { ...handle, upsert };
}

// ---------------------------------------------------------------------------
// PluginApi — visitor-side read API. Stub until P12 PR1.4 (gateway) wires it
// to the visitor-facing JSON endpoints. For now any caller that hits this
// outside a gateway-dispatched request gets a clear error.
// ---------------------------------------------------------------------------

function makePluginApi(_plugin: LoadedPlugin, _infra: PluginHostInfra) {
  return {
    list: async () => {
      throw new Error(
        "ctx.api.list: visitor-side read API requires a gateway-dispatched request context.",
      );
    },
    get: async () => {
      throw new Error(
        "ctx.api.get: visitor-side read API requires a gateway-dispatched request context.",
      );
    },
  };
}

// ---------------------------------------------------------------------------
// PluginVisitor — set by the gateway from cookie. When dispatched outside
// the gateway (internal Tier-1 calls / tests), defaults to a system visitor.
// A visitor call without consent to the visitor id carries null (#677):
// the plugin must not stand an id in for one the visitor declined.
// ---------------------------------------------------------------------------

const SYSTEM_VISITOR_ID = "00000000-0000-0000-0000-000000000000";

function makePluginVisitor(visitorContext?: VisitorContext): PluginVisitor {
  const mut = visitorContext?.sessionMutation;
  return {
    id: visitorContext ? visitorContext.visitorId : SYSTEM_VISITOR_ID,
    publicUserId: null,
    ipHash: "",
    sessionToken: visitorContext?.sessionToken ?? null,
    setSession: (args) => {
      if (!mut) return; // outside-gateway dispatch — no-op
      mut.current = args === null ? { kind: "clear" } : { kind: "set", ...args };
    },
  };
}

// ---------------------------------------------------------------------------
// PluginCaptcha — answers from the gateway's own verification (issue #634).
// ---------------------------------------------------------------------------

/**
 * The gateway verifies the visitor's proof-of-work (`_caelo_captcha`)
 * before dispatch and hands its verdict over in the visitor context; this
 * only reads it. The token argument is ignored: a plugin-supplied string
 * (the old `"dev"` sentinel) must never stand in for a verified proof, and
 * it behaves the same in every NODE_ENV so tests exercise production.
 *
 * A call without a visitor context did not come from the public gateway
 * (dispatch.ts rejects a `visitor` origin without one): it is the Owner
 * panel, the AI or a system worker, already authenticated, with no visitor
 * to challenge.
 */
export function makePluginCaptcha(visitorContext?: VisitorContext): PluginCaptcha {
  return {
    requireProof: async () => {
      if (!visitorContext) return true;
      return !visitorContext.captcha.enforced || visitorContext.captcha.proofVerified;
    },
  };
}

// ---------------------------------------------------------------------------
// PluginTheme — read-only tokens.
// ---------------------------------------------------------------------------

function makePluginTheme(): PluginTheme {
  return {
    tokens: Object.freeze({}), // P12 wires real theme tokens from structured_sets
  };
}

// ---------------------------------------------------------------------------
// PluginCms — typed Query API call into cms_admin scoped to the plugin's
// actor row + plugin id. Sets caelo.actor_id / caelo.actor_kind='plugin' /
// caelo.plugin_id session vars via the adapter's existing runOperation path.
// ---------------------------------------------------------------------------

/**
 * #1729 — `ctx.changes`: the plugin's own change consumer, asked as the
 * plugin actor (the op answers only about the caller's consumer).
 */
/**
 * `ctx.imports` (docs/data-imports.md): a shipped plugin that declares
 * import kinds reads their rows. Its own rows, nothing to grant.
 */
function importsHandle(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  view: ImportView,
): { imports?: PluginImports } {
  if (plugin.provenance === "runtime-authored") return {};
  if ((plugin.definition.imports ?? []).length === 0) return {};
  return {
    imports: makePluginImports(
      {
        registry: infra.registry,
        adapter: infra.adapter,
        pluginActorId: plugin.pluginActorId,
        pluginId: plugin.pluginId,
        slug: plugin.slug,
      },
      view,
    ),
  };
}

function makePluginChanges(plugin: LoadedPlugin, infra: PluginHostInfra): PluginChanges {
  return Object.freeze({
    cursorState: async () => {
      registerPluginChangeOps(infra.registry);
      const r = await execute(
        infra.registry,
        infra.adapter,
        {
          actorId: plugin.pluginActorId,
          actorKind: "plugin",
          requestId: `plugin-${plugin.slug}`,
          pluginId: plugin.pluginId,
        },
        "plugin_changes.cursor_state",
        {},
      );
      if (!r.ok) {
        const reason = "message" in r.error ? String(r.error.message) : r.error.kind;
        throw new Error(`ctx.changes.cursorState() failed: ${reason}`);
      }
      return r.value as { readonly continuous: boolean };
    },
  });
}

/** How a plugin's `ctx.cms` is bound beyond its invocation. */
export interface PluginCmsOptions {
  readonly liveUrls?: LiveBuildUrls;
  /** The call's kind when its origin does not say it (MakePluginContextOpts.sandboxKind). */
  readonly kind?: SandboxKind;
  /**
   * The operations the Owner approved for this artifact's `cms_admin`
   * receipt (its `constraints.operations`). Absent for a plugin whose
   * receipt carries no allowlist (a shipped plugin).
   */
  readonly allowed?: ReadonlySet<string>;
}

/**
 * The background work that may run a site-wide read (CLAUDE.md §2, the
 * O(request) rule): a worker, a batch job, a rebuild chunk. A render, a
 * chat call or a journal batch is a request.
 */
function mayReadSiteWide(invocation: PluginInvocation, kind: SandboxKind | undefined): boolean {
  return invocation.origin === "worker" || invocation.origin === "batch" || kind === "rebuild";
}

/**
 * Why `ctx.cms.call(opName)` is refused, or null when it may run. One
 * rule set for every plugin (docs/dev/external-plugin-brokers.md §7.1,
 * decisions Q2 and Q9): the operation must be open to plugins and not
 * back one of the plugin's own handles; a render only reads; a site-wide
 * read runs only in background work; and an artifact whose receipt names
 * its operations calls only those. Exported for its unit test.
 */
export function pluginCmsRefusal(
  registry: PluginHostInfra["registry"],
  slug: string,
  opName: string,
  invocation: PluginInvocation,
  options: PluginCmsOptions,
): string | null {
  const call = `ctx.cms.call("${opName}")`;
  const found = registry.lookup(opName);
  if (!found.ok) return `${call}: no operation of that name is registered here`;
  const op = found.value;
  if (!admitsPlugins(op)) {
    return `${call}: plugins cannot call this operation (its actorScope does not admit them)`;
  }
  const access = pluginAccessOf(op);
  if (access === null) {
    return `${call}: the operation declares no pluginAccess, so no plugin may call it — this is a fault in Caelo; report it with bug_report`;
  }
  if (access === "handle") {
    return `${call}: this operation backs one of the plugin's own handles (ctx.adminQuery, ctx.privateFiles, ctx.config, ctx.changes, ctx.email, …); call it through that handle`;
  }
  if (options.allowed && !options.allowed.has(opName)) {
    return `${call}: not among the operations the Owner approved for plugin "${slug}" (capabilityConstraints.cms_admin.operations) — add it there and ship a new version for the Owner to approve`;
  }
  if (access === "write" && invocation.origin === "render") {
    return `${call}: a render only reads, and this operation writes core data — make the write from a chat tool, the Owner panel, a worker or a change-journal batch`;
  }
  if (op.readScope === "site" && !mayReadSiteWide(invocation, options.kind)) {
    return `${call}: this operation reads the whole site, which only background work may do (a worker, a batch job or a rebuild) — a ${invocation.origin} call reads what its request names`;
  }
  return null;
}

/**
 * Core operations for a plugin granted `cms_admin`. Calls inherit the
 * invocation's branch and task, so core writes a plugin makes from a chat
 * are branched, locked and snapshotted like the AI's own, and its core
 * reads see the branch (docs/branch-aware-plugin-storage.md §3). This
 * must switch together with private storage: a page created on the
 * branch while the plugin's own row linking it went live would expose an
 * unpublished page. Every call is first held to {@link pluginCmsRefusal}.
 */
function makePluginCms(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
  options: PluginCmsOptions,
): PluginCms {
  const { liveUrls } = options;
  const branch = invocation.chatBranchId
    ? {
        chatBranchId: invocation.chatBranchId,
        ...(invocation.chatTaskId ? { chatTaskId: invocation.chatTaskId } : {}),
      }
    : {};
  return {
    call: async <Input, Output>(opName: string, input: Input): Promise<Output> => {
      // The operations behind the storage and consumer handles register on
      // first use; registered here too, so a call of one is refused as a
      // handle's operation rather than as an unknown name.
      registerPluginStorageOps(infra.registry, { lockPluginRow: infra.lockPluginRow });
      registerPluginChangeOps(infra.registry);
      const refused = pluginCmsRefusal(infra.registry, plugin.slug, opName, invocation, options);
      if (refused) throw new Error(refused);
      // #1390 — counted per plugin and operation for plugin health; never acted on.
      const r = await timedPluginOpCall(plugin.slug, opName, () =>
        execute(
          infra.registry,
          infra.adapter,
          {
            actorId: plugin.pluginActorId,
            actorKind: "plugin",
            requestId: `plugin-${plugin.slug}`,
            pluginId: plugin.pluginId,
            ...branch,
            ...(invocation.origin === "render" && invocation.siteBaseUrl
              ? { renderSiteBaseUrl: invocation.siteBaseUrl }
              : {}),
            ...(invocation.origin === "render" && invocation.importView
              ? { renderImportView: invocation.importView }
              : {}),
            ...(liveUrls ? { renderLiveUrls: liveUrls } : {}),
          },
          opName,
          input as unknown,
        ),
      );
      if (!r.ok) {
        const reason = "message" in r.error ? (r.error as { message: string }).message : "";
        const failure = new Error(
          `ctx.cms.call("${opName}") failed: ${r.error.kind}${reason ? `: ${reason}` : ""}`,
        );
        if (reason.startsWith(LIVE_BUILD_REFUSAL)) liveUrls?.refusals.add(failure);
        throw failure;
      }
      return r.value as Output;
    },
  };
}
