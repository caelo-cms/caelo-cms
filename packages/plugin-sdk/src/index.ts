// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo/plugin-sdk — Phase 11.
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
 * The validator (in @caelo/plugin-sandbox) walks plugin source and
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
 * Per-column declaration. Either a primitive type or an enum:value,value.
 * The validator parses the leading `enum:` prefix; everything else must
 * match `pluginColumnType`.
 */
export const pluginColumnSpec = z
  .string()
  .refine((v) => v.startsWith("enum:") || pluginColumnType.safeParse(v).success, {
    message: "must be one of uuid|string|text|int|bool|timestamp|jsonb or enum:a,b,c",
  });

/** Per-table column map. Special semantic invariant in §14.6: any table
 *  with `page_id` MUST also declare `locale`. The validator rejects
 *  schemas that violate this rule. */
export const pluginTableSchema = z.record(z.string(), pluginColumnSpec);

export type PluginTableSchema = z.infer<typeof pluginTableSchema>;

export const pluginSchemaMap = z.record(z.string(), pluginTableSchema);

export type PluginSchemaMap = z.infer<typeof pluginSchemaMap>;

/** Tier 1 capability requests. Tier 2 manifests declaring this field
 *  are rejected by the validator (these capabilities are core-only). */
export const pluginCapability = z.enum([
  "cms_admin",
  "ai_provider",
  "snapshots",
  "chat_runner_tools",
  "background_workers",
  "email",
]);

export type PluginCapability = z.infer<typeof pluginCapability>;

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

/** Public-facing API client (cms_public role; rate-limited at the gateway). */
export interface PluginApi {
  list<T = unknown>(args: object): Promise<T[]>;
  get<T = unknown>(args: object): Promise<T | null>;
}

/** Site theme tokens + current page locale. Read-only. Same both tiers. */
export interface PluginTheme {
  readonly tokens: Readonly<Record<string, string>>;
  readonly locale: string;
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
  /** Locale resolved from URL strategy + Accept-Language. */
  readonly locale: string;
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
  readonly operations: Readonly<Record<string, PluginOperation<C>>>;
  readonly component?: PluginComponent & {
    readonly mounted?: (host: HTMLElement, ctx: PluginFrontendContext) => Promise<void> | void;
  };
  readonly staticRender?: (
    ctx: C,
    args: { pageId: string; locale: string },
  ) => Promise<string> | string;
  /**
   * P13 audit fix #4 — optional cheap signature of the plugin's data
   * for this (page, locale) pair. Folded into the static_bakes
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
  readonly metaSignature?: (
    ctx: C,
    args: { pageId: string; locale: string },
  ) => Promise<string> | string;
  /**
   * P13 perf-pass — batch variant of `metaSignature`. Called once per
   * (slug, locale) per build with the full pageId list; returns a
   * Map keyed by pageId. The plugin-pass prefers this when present so
   * a 1000-page site does ONE SQL roundtrip instead of 1000.
   */
  readonly metaSignatureBatch?: (
    ctx: C,
    args: { locale: string; pageIds: ReadonlyArray<string> },
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
