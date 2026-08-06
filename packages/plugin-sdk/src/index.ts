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

import { z } from "zod";

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
 *  GRANTABLE is capped by provenance (epic #380 decision 2): a
 *  release-signed plugin may request any capability, a runtime-authored
 *  plugin none beyond the sandbox base (query/api/theme/visitor/captcha).
 *  The validator rejects runtime-authored manifests that reach over the
 *  ceiling. */
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

/** AI tool registration declaration. Tier 1 only — Tier 2 plugins do
 *  not get chat-runner tool registration. */
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
});

export type PluginToolSpec = z.infer<typeof pluginToolSpec>;

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
export const pluginManifest = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z][a-z0-9-]*$/, "must be lowercase, dash-separated"),
    version: z
      .string()
      .min(1)
      .max(40)
      .regex(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/, "must be semver"),
    tier: z.union([z.literal(1), z.literal(2)]),
    schema: pluginSchemaMap,
    /** #389 — release-signed only: the plugin's own authoring-DB schema,
     *  provisioned as `plugin_<slug>` in cms_admin (FORCE RLS, scoped to
     *  the plugin's id). Same declarative table spec as `schema`; `ref:`
     *  columns may FK onto allowlisted core tables. Requires the
     *  `cms_admin_schema` capability. */
    adminSchema: pluginSchemaMap.optional(),
    /** Operation names. Bodies live in source — the manifest just lists names. */
    operations: z.array(z.string().min(1).max(120)).min(1),
    component: pluginComponent.optional(),
    hasStaticRender: z.boolean().default(false),
    /** Tier 1 only. */
    requestedCapabilities: z.array(pluginCapability).optional(),
    /** Tier 1 only. */
    workers: z.array(pluginWorkerSpec).optional(),
    /** Tier 1 only. */
    tools: z.array(pluginToolSpec).optional(),
    /** #390 — URL-slot claims (release-signed only). The definition
     *  supplies the matching pure encode/decode pairs. */
    urlContributions: z.array(urlContributionClaim).optional(),
    /** #391 — head/sitemap contribution claims (release-signed only,
     *  requires the `head_contributions` capability). */
    contributes: z.array(contributionKind).optional(),
  })
  .strict();

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
  readonly since?: string;
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
  readonly slug: string;
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
      /** Transform the stored slug into its URL form. */
      readonly encode: (page: UrlComposePage) => string;
      /** Inverse: URL slug segment back to the stored slug. */
      readonly decode: (urlSlug: string) => string;
    }
  | {
      readonly slot: "full-path";
      /** The complete path (leading slash) — owns the whole grammar. */
      readonly encode: (page: UrlComposePage) => string;
      /** Inverse: path back to {slug, annotations}; null = unknown path. */
      readonly decode: (path: string) => (UrlDecodeMatch & { readonly slug: string }) | null;
    };

/**
 * #392 — one row from the transactional domain-event outbox. Events are
 * ephemeral SIGNALS ("this page changed"), not state: the consumer
 * re-reads current state through its normal handles; snapshots remain
 * the durable history.
 */
export interface PluginDomainEvent {
  readonly id: number;
  readonly kind:
    | "page.created"
    | "page.updated"
    | "page.deleted"
    | "page.published"
    | "module.updated";
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
  /** Opaque per-session identifier. Stable across requests within one
   *  visitor session; rotated on logout. */
  readonly id: string;
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
 * Proof-of-work / CAPTCHA validation. Both tiers. Stub in P12 (returns
 * true on a "dev" token); P13 wires real Cloudflare Turnstile / hCaptcha
 * + a tiny PoW scheme. Plugins call this on visitor-write ops (comment
 * submit, form submit, signup) so P13 can drop in real validation
 * without a P12 plugin code change.
 */
export interface PluginCaptcha {
  requireProof(token: string | null): Promise<boolean>;
}

/**
 * Tier-1 only — outbound email. Configurable transport (SMTP / Resend /
 * SES / no-op stub). The host's /security/email page configures which
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

/** Tier 1 only — typed Query API call into cms_admin. The host gates
 *  ops by the plugin's actor scope; calls outside the plugin's
 *  requestedCapabilities throw at dispatch. */
export interface PluginCms {
  call<Input, Output>(opName: string, input: Input): Promise<Output>;
}

/** Tier 1 only — single-shot generation against the configured provider. */
export interface PluginAi {
  complete(opts: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
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

/** Locked context — what every Tier 2 plugin receives. */
export interface PluginContext {
  readonly query: PluginQuery;
  readonly api: PluginApi;
  readonly theme: PluginTheme;
  readonly visitor: PluginVisitor;
  readonly captcha: PluginCaptcha;
}

/** Tier 1 context — adds the elevated capability handles. The host
 *  ONLY constructs the handles a plugin's `requestedCapabilities`
 *  asked for; unrequested fields are absent. */
export interface PluginContextTier1 extends PluginContext {
  /** #389 — attached when the manifest holds `cms_admin_schema`. */
  readonly adminQuery?: PluginAdminQuery;
  /** #392 — attached when the manifest holds `domain_events`. */
  readonly events?: PluginEvents;
  readonly cms?: PluginCms;
  readonly ai?: PluginAi;
  readonly snapshots?: PluginSnapshots;
  readonly email?: PluginEmail;
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
  readonly staticRender?: (ctx: C, args: { pageId: string }) => Promise<string> | string;
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
  /** Tier 1 only. */
  readonly requestedCapabilities?: ReadonlyArray<PluginCapability>;
  /** Tier 1 only. Cron-style background workers; the host's scheduler
   *  dispatches `operationName` on each tick. */
  readonly workers?: ReadonlyArray<PluginWorkerSpec>;
  /** Tier 1 only. AI tools registered into the chat-runner catalogue
   *  at activation. Each tool dispatches to the named operation. */
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
  /**
   * #391 — the I/O half of head/sitemap contributions: an operation in
   * `operations` taking `{pageIds: string[], siteBaseUrl: string}` and
   * returning `{head?: Record<pageId, HeadEntry[]>, sitemap?:
   * Record<pageId, SitemapContribution>}`. The host Zod-validates every
   * entry and serializes them itself — a plugin can never inject raw
   * head HTML.
   */
  readonly contributionsOperation?: string;
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
  readonly operations: Readonly<Record<string, unknown>>;
  readonly component?: PluginComponent;
  readonly staticRender?: unknown;
  readonly requestedCapabilities?: ReadonlyArray<PluginCapability>;
  readonly workers?: ReadonlyArray<PluginWorkerSpec>;
  readonly tools?: ReadonlyArray<PluginToolSpec>;
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
    ...(def.requestedCapabilities ? { requestedCapabilities: [...def.requestedCapabilities] } : {}),
    ...(def.workers ? { workers: [...def.workers] } : {}),
    ...(def.tools ? { tools: [...def.tools] } : {}),
    ...(def.urlContributions && def.urlContributions.length > 0
      ? { urlContributions: def.urlContributions.map((c) => ({ slot: c.slot })) }
      : {}),
    ...(def.contributes && def.contributes.length > 0 ? { contributes: [...def.contributes] } : {}),
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
