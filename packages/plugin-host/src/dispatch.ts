// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/dispatch — invoke a Tier-1 plugin operation.
 *
 * The route handler / API gateway / chat-runner / scheduler all funnel through
 * `runPluginOperation`. It looks up the plugin's frozen spec, validates that
 * the operation is declared, builds the per-call ctx via `makePluginContext`,
 * and calls the operation handler.
 *
 * Operation results are returned verbatim — no schema validation here (the
 * plugin author is responsible for its own input/output Zod gates inside the
 * operation handler).
 */

import { createHash } from "node:crypto";
import type {
  PageUrlStyle,
  PluginContext,
  PluginContextTier1,
  PluginDefinition,
  PluginImageCapabilities,
  PluginInvocation,
  PluginProvenance,
} from "@caelo-cms/plugin-sdk";
import {
  allowNestedCheckouts,
  type DatabaseAdapter,
  execute,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { bakedDataPageIds } from "./baked-data-pages.js";
import { type ExternalApproval, operatorHasPermission } from "./external-authorization.js";
import { previewContext } from "./preview-context.js";
import type { PluginRowLocker } from "./private-storage.js";
import {
  emitPublicPluginOpEvent,
  isProjectionNotPublished,
  isPublicSideHost,
  unpublishedRegistryError,
} from "./published-state.js";
import type { PluginRenderFailure } from "./render-failures.js";
import { recordPluginError } from "./runtime-health.js";
import { consumeExternalToolApproval } from "./tool-approval-binding.js";
import type { AIProvider } from "./types.js";

/** Runtime registry of loaded Tier-1 plugins. Loader writes here at startup;
 *  dispatch reads. Disable removes the entry; re-enable adds it back. */
class LoadedPluginsRegistry {
  readonly #byId = new Map<string, LoadedPlugin>();
  readonly #bySlug = new Map<string, LoadedPlugin>();

  set(plugin: LoadedPlugin): void {
    this.#byId.set(plugin.pluginId, plugin);
    this.#bySlug.set(plugin.slug, plugin);
  }

  bySlug(slug: string): LoadedPlugin | undefined {
    return this.#bySlug.get(slug);
  }

  byId(id: string): LoadedPlugin | undefined {
    return this.#byId.get(id);
  }

  unload(slug: string): void {
    const p = this.#bySlug.get(slug);
    if (!p) return;
    this.#byId.delete(p.pluginId);
    this.#bySlug.delete(slug);
  }

  all(): ReadonlyArray<LoadedPlugin> {
    return [...this.#bySlug.values()];
  }

  reset(): void {
    this.#byId.clear();
    this.#bySlug.clear();
  }
}

export interface LoadedPlugin {
  readonly externalApproval?: ExternalApproval;
  readonly pluginId: string;
  readonly slug: string;
  readonly version: string;
  readonly tier: 1 | 2;
  /** #388 — the trust axis. `release-signed` = manifest carried a
   *  verified Ed25519 signature (disk-shipped core plugins; also the
   *  ephemeral-signed test path). `runtime-authored` = submitted at
   *  runtime, validator + Owner-activation gated, never signed.
   *  Provenance caps grantable capabilities; `tier` is its persisted
   *  encoding (derived trust, not a parallel interface). */
  readonly provenance: PluginProvenance;
  readonly definition: PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>;
  /** Per-plugin actor row id — set as caelo.actor_id when the plugin's
   *  operations write through the Query API. */
  readonly pluginActorId: string;
}

export const loadedPlugins = new LoadedPluginsRegistry();

/**
 * Audit fix #2 — soft-disabled set. Disable doesn't unload the plugin's
 * spec from the host (so re-enable is fast), but tools / workers /
 * dispatch all respect this set. The `plugins.disable` op writes the
 * DB row + calls `setPluginDisabled(slug, true)`; `plugins.activate`
 * after disabled clears the flag. No process restart needed.
 */
const disabledSlugs = new Set<string>();

export function setPluginDisabled(slug: string, disabled: boolean): void {
  if (disabled) disabledSlugs.add(slug);
  else disabledSlugs.delete(slug);
}

export function isPluginDisabled(slug: string): boolean {
  return disabledSlugs.has(slug);
}

export function resetDisabledSet(): void {
  disabledSlugs.clear();
}

/** Bag of host machinery passed to the capability factory. Bootstrap
 *  injects these from the host process (apps/admin) so plugin-host stays
 *  free of upward circular imports on @caelo-cms/admin-core. */
export interface PluginHostInfra {
  /** #530 — the original bytes of a site media asset, by storage key. */
  readonly siteMediaBytes?: (storageKey: string) => Promise<Uint8Array>;
  /** Local image processing, with no provider or network access. */
  readonly imageTransform?: (input: {
    bytes: Uint8Array;
    width: number;
    height: number;
    quality: number;
  }) => Promise<{ bytes: Uint8Array; width: number; height: number }>;
  readonly imageProvider?: {
    describe(): Promise<{
      model: string;
      maxCostMicrocents: number;
      imageSizes: readonly string[];
      capabilities: PluginImageCapabilities;
    }>;
    generate(input: {
      model: string;
      prompt: string;
      imageSize: "1K" | "2K" | "4K";
      references: readonly { data: Uint8Array; mediaType: string }[];
      /** #528 — the image to change; references then guide the edit. */
      editSource?: { data: Uint8Array; mediaType: string };
      /** #528 — PNG marking where the edit may change the source. */
      mask?: { data: Uint8Array; mediaType: "image/png" };
    }): Promise<{
      bytes: Uint8Array;
      width: number;
      height: number;
      costMicrocents: number;
      durationMs: number;
    }>;
  };
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** Optional — only required if any active plugin requested `ai_provider`. */
  readonly aiProvider?: AIProvider;
  /** Optional — only required if any active plugin requested `snapshots`.
   *  The host calls this from inside `adapter.withAdminTransaction(...)`,
   *  so the supplied function gets the live tx. Mirrors admin-core's
   *  `emitSnapshot` signature; bootstrap passes that fn here. */
  readonly emitSnapshot?: SnapshotEmitter;
  /** P12 PR1.3 — optional outbound email transport. When omitted,
   *  ctx.email.send falls back to a no-op stderr stub. */
  readonly emailTransport?: EmailTransport;
  /** Takes the chat lock for a plugin row written on a branch. Required
   *  for any chat-origin private-storage write; admin-core supplies it
   *  (it owns chat locks). A branch write without it fails loudly. */
  readonly lockPluginRow?: PluginRowLocker;
}

/** Outbound email transport. Implementations live in the host process
 *  (apps/admin) and may wrap nodemailer / Resend / SES. */
export interface EmailTransport {
  send(args: {
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
  }): Promise<{ messageId: string }>;
}

export interface SnapshotEmitterInput {
  readonly actorId: string;
  readonly opKind: string;
  readonly description: string;
  readonly entities: ReadonlyArray<{
    readonly kind: string;
    readonly id: string;
    readonly payload: unknown;
  }>;
  readonly chatBranchId?: string | null;
  readonly chatTaskId?: string | null;
  readonly revertOf?: string | null;
}

export type SnapshotEmitter = (
  tx: unknown,
  input: SnapshotEmitterInput,
) => Promise<{ siteSnapshotId: string }>;

/** The capability factory is injected to break a circular import between
 *  dispatch + capabilities (capabilities call dispatch.runPluginOperation
 *  for `ctx.cms.call`-style cases). The loader sets this once at boot. */
let makeContext: ((opts: MakeContextOpts) => Promise<PluginContext | PluginContextTier1>) | null =
  null;

interface MakeContextOpts {
  readonly plugin: LoadedPlugin;
  readonly infra: PluginHostInfra;
  /** Who the call acts for and on which branch (CMS_REQUIREMENTS §14.7). */
  readonly invocation: PluginInvocation;
  /** Visitor-facing context if dispatched from the API gateway. */
  readonly visitorContext?: VisitorDispatchContext;
}

/**
 * What the gateway established about the request's captcha before
 * dispatching it (issue #634). A plugin's `ctx.captcha.requireProof` is
 * satisfied when the Owner turned the captcha off (`enforced: false`, the
 * /settings/gateway "Off" setting) or when the gateway verified and
 * consumed a proof for this very request (`proofVerified`). There is no
 * token a visitor can send to the plugin that stands in for either.
 */
export interface VisitorCaptchaVerdict {
  readonly enforced: boolean;
  readonly proofVerified: boolean;
}

/**
 * Per-request visitor context populated by the gateway. Optional
 * `sessionMutation` lets the auth plugin's `setSession()` mark the
 * response so the gateway emits a Set-Cookie. Mutated in-place; the
 * gateway reads it post-dispatch.
 */
export interface VisitorDispatchContext {
  /** The `caelo_visitor_id` cookie's id, or null when the visitor has not
   *  consented to being recognised (#677) — the gateway then sets no
   *  cookie and the plugin sees `ctx.visitor.id === null`. */
  readonly visitorId: string | null;
  readonly sessionToken: string | null;
  /** The gateway's captcha verdict for this request; `ctx.captcha.requireProof` answers from it. */
  readonly captcha: VisitorCaptchaVerdict;
  readonly sessionMutation?: {
    current:
      | { kind: "none" }
      | { kind: "set"; sessionToken: string; expiresAt: string }
      | { kind: "clear" };
  };
}

export function setContextFactory(
  fn: (opts: MakeContextOpts) => Promise<PluginContext | PluginContextTier1>,
): void {
  makeContext = fn;
}

export interface RunPluginOperationOpts {
  /** Host-only: a private preview gets storage reads and no effectful handles. */
  readonly readOnlyPreview?: boolean;
  /** Set only by the host after the matching tool approval has completed. */
  readonly approvedToolName?: string;
  /** The approved tool call, whose binding was recorded before asking the Owner. */
  readonly approvedToolCallId?: string;
  /** The chat the approval card was shown in; its binding is redeemed there only. */
  readonly approvedChatBranchId?: string;
  readonly pluginSlug: string;
  readonly operationName: string;
  readonly args: unknown;
  /** Override the plugin's own actor when needed (e.g. test fixtures).
   *  Production callers omit this — dispatch uses `loadedPlugins.bySlug(...).pluginActorId`. */
  readonly pluginActorId?: string;
  readonly visitorContext?: VisitorDispatchContext;
  /** Required: who the call acts for and on which branch. A call without
   *  it would silently act as "main, nobody" — the defect §14.7 closes. */
  readonly invocation: PluginInvocation;
}

/**
 * Reject an invocation that contradicts itself, loudly: a visitor call
 * without a visitor context (or the reverse), a chat call without the
 * chat's branch, or a branch on a call that cannot have one.
 */
export function assertInvocationConsistent(
  invocation: PluginInvocation,
  visitorContext: VisitorDispatchContext | undefined,
): void {
  if (!invocation || typeof invocation.actorId !== "string" || invocation.actorId.length === 0) {
    throw new Error("PluginInvocationInvalid: an actorId is required");
  }
  if ((invocation.origin === "visitor") !== (visitorContext !== undefined)) {
    throw new Error(
      `PluginInvocationInvalid: origin "${invocation.origin}" ${visitorContext ? "with" : "without"} a visitor context`,
    );
  }
  if (invocation.origin === "chat" && !invocation.chatBranchId) {
    throw new Error("PluginInvocationInvalid: a chat invocation needs the chat's branch");
  }
  // A branch is allowed for a chat, a branch preview render, and an
  // approved action whose approver cannot publish (it stays in the chat).
  if (
    invocation.chatBranchId &&
    invocation.origin !== "chat" &&
    invocation.origin !== "render" &&
    invocation.origin !== "approved"
  ) {
    throw new Error(
      `PluginInvocationInvalid: origin "${invocation.origin}" cannot carry a chat branch`,
    );
  }
}

/** Compiled tool input schemas, keyed by the declared JSON Schema object. */
const toolArgSchemas = new WeakMap<object, z.ZodType>();

/**
 * Why a tool call's arguments do not match the tool's declared input
 * schema, phrased so the AI can correct the call itself, or null when
 * they match.
 */
export function toolArgsProblem(
  tool: { readonly name: string; readonly inputJsonSchema: Record<string, unknown> },
  args: unknown,
): string | null {
  let schema = toolArgSchemas.get(tool.inputJsonSchema);
  if (!schema) {
    schema = z.fromJSONSchema(tool.inputJsonSchema);
    toolArgSchemas.set(tool.inputJsonSchema, schema);
  }
  const parsed = schema.safeParse(args);
  if (parsed.success) return null;
  const properties = (tool.inputJsonSchema.properties ?? {}) as Record<string, unknown>;
  const required = (tool.inputJsonSchema.required ?? []) as string[];
  const accepted = Object.keys(properties)
    .map((k) => (required.includes(k) ? `${k} (required)` : k))
    .join(", ");
  return `InvalidToolInput: "${tool.name}" was called with arguments that do not match its input schema:\n${z.prettifyError(parsed.error)}\nIt accepts: ${accepted || "no arguments"}. Call it again with exactly these field names.`;
}

export type RunPluginOperationResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind:
          | "PluginNotFound"
          | "PluginDisabled"
          | "OperationNotDeclared"
          | "OperationNotPublic"
          | "OperationFailed"
          // #635 — the admin has not published what this call needs into
          // cms_public yet: a loud 503, never an empty or "not found" answer.
          | "ProjectionNotPublished";
        readonly message: string;
      };
    };

/**
 * Dispatch a plugin operation. Returns a Result; never throws.
 *
 * Caller must ensure the host's `bootstrap()` ran first (or, in tests,
 * `setHostInfra(...)` + `setContextFactory(...)` were both invoked).
 */
let cachedInfra: PluginHostInfra | null = null;
export function setHostInfra(infra: PluginHostInfra): void {
  cachedInfra = infra;
}

/** The bootstrapped adapter + registry, for host-internal passes that
 *  need to read core through the Query API (never raw SQL). Throws
 *  rather than returning null — every caller runs inside a render pass
 *  that a booted host is a precondition for. */
export function hostInfra(): PluginHostInfra {
  if (!cachedInfra) throw new Error("plugin host not bootstrapped");
  return cachedInfra;
}

let cachedSystemActorId: string | null = null;
export function setHostSystemActorId(actorId: string): void {
  cachedSystemActorId = actorId;
}

/** Actor the host itself reads core as. Host-internal passes are not
 *  acting for any plugin — attributing their reads to one would put a
 *  plugin's id on rows it never asked for. */
export function hostSystemActorId(): string {
  if (!cachedSystemActorId) throw new Error("plugin host not bootstrapped");
  return cachedSystemActorId;
}

/**
 * Which branch a render pass shows. The admin preview renders the chat's
 * branch; the static generator and live paths render main (`null`).
 * Required at every render call site so none can silently read main in a
 * branch preview (docs/branch-aware-plugin-storage.md §5).
 */
export interface RenderScope {
  readonly chatBranchId: string | null;
  /**
   * #1087 — set by a render that may show a degraded page (the editor
   * preview): a plugin whose call fails is reported here and its
   * contribution left out instead of failing the render. Builds leave it
   * unset and fail loudly. See render-failures.ts.
   */
  readonly onPluginFailure?: (failure: PluginRenderFailure) => void;
  /**
   * Set by the editor preview: the render is for the operator, never a
   * visitor, so plugin output meant only for editors (a module
   * deferral's `editorNotice`) may appear. Builds leave it unset.
   */
  readonly editorPreview?: boolean;
  /**
   * #1213 — one id per render pass, handed to every plugin call of the
   * pass as `invocation.renderId`, so a plugin can read its data once per
   * pass instead of once per composition point. Set it only on a scope
   * that lives for exactly one pass (the editor preview creates one per
   * render); a long-lived scope such as {@link MAIN_RENDER} leaves it
   * out, because a plugin would then reuse reads across passes.
   */
  readonly renderId?: string;
}

/** A render of the deployed site / live state: no branch. */
export const MAIN_RENDER: RenderScope = Object.freeze({ chatBranchId: null });

/** The invocation a render-time plugin call runs under. */
export function renderInvocation(scope: RenderScope): PluginInvocation {
  return {
    origin: "render",
    actorId: hostSystemActorId(),
    ...(scope.chatBranchId ? { chatBranchId: scope.chatBranchId } : {}),
    ...(scope.renderId ? { renderId: scope.renderId } : {}),
  };
}

/**
 * Run one plugin operation. A render-origin call (URL annotations, list
 * sources, public URLs, preview hooks) runs inside whatever transaction its
 * caller holds, and the plugin's storage reads are ops of their own, so it
 * is an allowlisted nested-checkout call site until #1220 hands it the
 * caller's transaction (query-api pool-guard.ts).
 */
export async function runPluginOperation(
  opts: RunPluginOperationOpts,
): Promise<RunPluginOperationResult> {
  if (opts.invocation.origin !== "render") return runPluginOperationNow(opts);
  return allowNestedCheckouts("plugins.render_hook", () => runPluginOperationNow(opts));
}

async function runPluginOperationNow(
  opts: RunPluginOperationOpts,
): Promise<RunPluginOperationResult> {
  if (
    opts.readOnlyPreview &&
    // A preview is an author reading their own plugin data: from the
    // panel (main) or in one of their chats (that chat's branch).
    (!["owner-panel", "chat"].includes(opts.invocation.origin) ||
      opts.visitorContext ||
      opts.operationName !== "preview")
  )
    return { ok: false, error: { kind: "OperationFailed", message: "Invalid preview context" } };
  const plugin = loadedPlugins.bySlug(opts.pluginSlug);
  if (!plugin) {
    const unpublished = unpublishedRegistryError();
    if (unpublished) {
      return { ok: false, error: { kind: "ProjectionNotPublished", message: unpublished.message } };
    }
    return {
      ok: false,
      error: {
        kind: "PluginNotFound",
        message: `no loaded plugin with slug "${opts.pluginSlug}"`,
      },
    };
  }
  if (isPluginDisabled(opts.pluginSlug)) {
    return {
      ok: false,
      error: {
        kind: "PluginDisabled",
        message: `plugin "${opts.pluginSlug}" is disabled — re-enable via /settings/plugins`,
      },
    };
  }
  const handler = plugin.definition.operations[opts.operationName];
  if (!handler) {
    return {
      ok: false,
      error: {
        kind: "OperationNotDeclared",
        message: `plugin "${opts.pluginSlug}" does not declare operation "${opts.operationName}"`,
      },
    };
  }
  // Visitor-facing dispatch is DEFAULT DENY.
  //
  // A plugin's operations mix two audiences with no naming rule to tell
  // them apart — `submit` sits next to `moderate`, `subscribe` next to
  // `send_campaign`, `me` next to `apply_auth_config` — and every one of
  // them runs with whatever capabilities the plugin was granted. The
  // check lives HERE rather than at the gateway route so a second entry
  // point cannot be added later without it.
  if (opts.visitorContext) {
    const allowed = plugin.definition.publicOperations ?? [];
    if (!allowed.includes(opts.operationName)) {
      return {
        ok: false,
        error: {
          kind: "OperationNotPublic",
          message: `operation "${opts.operationName}" of plugin "${opts.pluginSlug}" is not visitor-facing. Add it to the plugin's \`publicOperations\` if it genuinely is.`,
        },
      };
    }
  }
  if (!cachedInfra || !makeContext) {
    return {
      ok: false,
      error: {
        kind: "OperationFailed",
        message: "plugin host not bootstrapped — call bootstrap() before dispatch",
      },
    };
  }
  // A tool's `requiredPermission` binds the chat path to the permission
  // the plugin's owner panel requires: the human a chat call acts for (or
  // who approved a gated one) must hold it. Panel, worker and render calls
  // are authorised where they originate and are not re-checked here.
  const requiredPermission = plugin.definition.tools?.find(
    (t) => t.operationName === opts.operationName && t.requiredPermission,
  )?.requiredPermission;
  if (
    requiredPermission &&
    (opts.invocation.origin === "chat" || opts.invocation.origin === "approved")
  ) {
    const operator =
      opts.invocation.origin === "approved"
        ? opts.invocation.actorId
        : opts.invocation.operatorActorId;
    const allowed =
      operator !== undefined &&
      (await operatorHasPermission(cachedInfra, hostSystemActorId(), operator, requiredPermission));
    if (!allowed) {
      return {
        ok: false,
        error: {
          kind: "OperationFailed",
          message: `permission_denied: "${opts.operationName}" of plugin "${opts.pluginSlug}" needs the ${requiredPermission} permission for the person this chat acts for. Tell the operator an Owner has to do this.`,
        },
      };
    }
  }
  const tool = plugin.definition.tools?.find((t) => t.operationName === opts.operationName);
  // #644 — an AI tool call's arguments are checked against the tool's own
  // input schema before the handler runs, for every plugin. Handlers read
  // their args by cast, so a misnamed field (`pageId` for `variantPageId`)
  // used to reach them as `undefined` and surface far away as a broken SQL
  // statement. Panel, worker and render calls pass host-built args and are
  // not tool calls, so only the chat and approved paths are checked here;
  // an installed plugin's tools are checked on every path below.
  if (
    tool &&
    !plugin.externalApproval &&
    (opts.invocation.origin === "chat" || opts.invocation.origin === "approved")
  ) {
    const problem = toolArgsProblem(tool, opts.args);
    if (problem) return { ok: false, error: { kind: "OperationFailed", message: problem } };
  }
  if (plugin.externalApproval) {
    if (tool) {
      try {
        if (tool.approvalMode && opts.approvedToolName !== tool.name)
          throw new Error("ExternalToolApprovalRequired");
        const problem = toolArgsProblem(tool, opts.args);
        if (problem) throw new Error(problem);
        if (tool.approvalMode)
          await consumeExternalToolApproval({
            plugin,
            infra: cachedInfra,
            invocation: opts.invocation,
            toolName: tool.name,
            operationName: opts.operationName,
            toolCallId: opts.approvedToolCallId,
            chatBranchId: opts.approvedChatBranchId,
            args: opts.args,
          });
      } catch (error) {
        return { ok: false, error: { kind: "OperationFailed", message: (error as Error).message } };
      }
    }
  }
  let ctx: PluginContext | PluginContextTier1;
  try {
    assertInvocationConsistent(opts.invocation, opts.visitorContext);
    ctx = await makeContext({
      plugin,
      infra: cachedInfra,
      visitorContext: opts.visitorContext,
      invocation: opts.invocation,
    });
  } catch (e) {
    if (isProjectionNotPublished(e)) {
      return {
        ok: false,
        error: { kind: "ProjectionNotPublished", message: (e as Error).message },
      };
    }
    return {
      ok: false,
      error: {
        kind: "OperationFailed",
        message: `failed to build plugin context: ${(e as Error).message}`,
      },
    };
  }
  try {
    const value = await handler(
      opts.readOnlyPreview ? previewContext(ctx) : (ctx as PluginContext),
      opts.args,
    );
    if (opts.readOnlyPreview) return { ok: true, value };
    // #1212 — a render call only reads (its storage writes are refused,
    // capabilities.ts), and the preview makes several per view of a page:
    // an audit row each recorded nothing anyone acted on, in a transaction
    // of its own per call. A failing one still lands in the plugin's error
    // log below.
    if (opts.invocation.origin === "render") return { ok: true, value };
    // v0.2.16 — emit an audit_events row so plugin write ops (e.g.
    // `comments.moderate`) show in the operator's audit trail.
    // Best-effort: failure to audit doesn't fail the op.
    try {
      // #635 — on the public side (no cms_admin login) the record lands in
      // cms_public, where the admin reads it back only as untrusted hints.
      if (isPublicSideHost(cachedInfra)) {
        await emitPublicPluginOpEvent(cachedInfra, {
          pluginId: plugin.pluginId,
          actorId: plugin.pluginActorId,
          operation: `${plugin.slug}.${opts.operationName}`,
          inputHash: auditInputDigest(opts.args),
          entityId: extractEntityId(value),
          // #1155 — the page a declared baked-data trigger changed; the
          // admin reads it back as an untrusted hint, never as a fact.
          pageId:
            bakedDataPageIds(
              plugin.definition.bakedData,
              opts.operationName,
              { args: opts.args, result: value },
              { single: true },
            )[0] ?? null,
        });
        return { ok: true, value };
      }
      await emitPluginAuditRow(cachedInfra.adapter, {
        actorId: plugin.pluginActorId,
        operation: `${plugin.slug}.${opts.operationName}`,
        inputArgs: opts.args,
        entityId: extractEntityId(value),
        succeeded: true,
      });
    } catch {
      // Audit failure shouldn't surface to the visitor / caller.
    }
    await markBakedPagesStale(plugin, opts.operationName, opts.args, value);
    return { ok: true, value };
  } catch (e) {
    if (
      !opts.readOnlyPreview &&
      opts.invocation.origin !== "render" &&
      !isPublicSideHost(cachedInfra)
    ) {
      try {
        await emitPluginAuditRow(cachedInfra.adapter, {
          actorId: plugin.pluginActorId,
          operation: `${plugin.slug}.${opts.operationName}`,
          inputArgs: opts.args,
          entityId: null,
          succeeded: false,
        });
      } catch (auditError) {
        // Best-effort: the caller gets the operation's own error either
        // way, but a missing failure row must not go unnoticed.
        console.error(
          `[plugin-host] failure audit row not recorded for ${plugin.slug}.${opts.operationName}: ${(auditError as Error).message}`,
        );
      }
    }
    if (isProjectionNotPublished(e)) {
      return {
        ok: false,
        error: { kind: "ProjectionNotPublished", message: (e as Error).message },
      };
    }
    // #1008 — every throw lands in the plugin's error log, so the Owner
    // and the AI see it under the plugin, not only in this caller's
    // result. The public side has no cms_admin login and only logs.
    if (!isPublicSideHost(cachedInfra)) {
      await recordPluginError({
        infra: cachedInfra,
        systemActorId: hostSystemActorId(),
        slug: plugin.slug,
        pluginId: plugin.pluginId,
        phase:
          opts.invocation.origin === "render"
            ? "render"
            : opts.invocation.origin === "worker"
              ? "worker"
              : "operation",
        error: new Error(`operation "${opts.operationName}" threw`, { cause: e }),
      });
    }
    return {
      ok: false,
      error: {
        kind: "OperationFailed",
        message: `plugin "${opts.pluginSlug}" operation "${opts.operationName}" threw: ${(e as Error).message}`,
      },
    };
  }
}

/** The admin op that records stale bakes (admin-core `ops/plugin-data.ts`). */
const MARK_BAKED_PAGES_OP = "plugin_data.mark_pages";

/**
 * #1155 — after a declared baked-data trigger succeeded in the admin, ask
 * the next plugin-data build to re-bake the pages it names. The operation
 * already happened, so a failure to record this is not the caller's: the
 * item is live through the delta feed either way, and only its bake waits
 * for the next Stage. It is recorded under the plugin (#1008), never
 * swallowed.
 */
async function markBakedPagesStale(
  plugin: LoadedPlugin,
  operationName: string,
  args: unknown,
  result: unknown,
): Promise<void> {
  if (!cachedInfra) return;
  const pageIds = bakedDataPageIds(plugin.definition.bakedData, operationName, {
    args,
    result,
  });
  if (pageIds.length === 0) return;
  const infra = cachedInfra;
  const fail = async (message: string): Promise<void> => {
    await recordPluginError({
      infra,
      systemActorId: hostSystemActorId(),
      slug: plugin.slug,
      pluginId: plugin.pluginId,
      phase: "operation",
      error: new Error(
        `"${operationName}" succeeded, but its pages were not queued for a plugin-data build: ${message}. They get the new data with the next Stage and Publish live.`,
      ),
    });
  };
  if (!infra.registry.has(MARK_BAKED_PAGES_OP)) {
    await fail(`the admin registers no ${MARK_BAKED_PAGES_OP} operation`);
    return;
  }
  const r = await execute(
    infra.registry,
    infra.adapter,
    { actorId: hostSystemActorId(), actorKind: "system", requestId: `baked-data-${plugin.slug}` },
    MARK_BAKED_PAGES_OP,
    { pluginId: plugin.pluginId, pageIds, source: "operation" },
  );
  if (!r.ok) await fail(JSON.stringify(r.error));
}

/** Field names whose values are redacted before the audit digest is taken. */
const SENSITIVE_KEY_RE =
  /pass(word|wd|phrase)?|secret|token|api[-_]?key|credential|private[-_]?key/i;

/**
 * `JSON.stringify` replacer that strips credential-shaped data before it can
 * reach the audit digest: sensitive-named fields are replaced with a fixed
 * placeholder, and prototype-polluting keys are dropped entirely. Using a
 * replacer (rather than a recursive clone) keeps the redaction on the
 * serialization path the digest actually consumes, so no value read from a
 * `*password*`/`*secret*`/token field flows into the hash
 * (CodeQL js/insufficient-password-hash). Deterministic for equal inputs.
 */
function redactingReplacer(key: string, value: unknown): unknown {
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  return SENSITIVE_KEY_RE.test(key) ? "[redacted]" : value;
}

/**
 * Audit integrity digest of a plugin op's input arguments. This is NOT a
 * password hash — it is a one-way fingerprint stored in
 * `audit_events.input_hash` so the operator can correlate and tamper-check
 * op calls. Sensitive-named fields are redacted on the serialization path
 * (see `redactingReplacer`), so the digest can never act as an offline
 * oracle for a secret and its input carries no credential-shaped data.
 * SHA-256 is the correct primitive for a deterministic integrity
 * fingerprint; a slow salted password KDF would be wrong here
 * (non-deterministic, defeats correlation).
 */
export function auditInputDigest(inputArgs: unknown): string {
  const json = JSON.stringify(inputArgs ?? null, redactingReplacer) ?? "null";
  return createHash("sha256").update(json).digest("hex");
}

/**
 * v0.2.16 — write an audit_events row for a plugin op. Mirrors the
 * shape `recordAudit` in admin-core uses, but runs raw SQL because
 * plugin-host is a peer of admin-core (no upward import). The row
 * lets the operator's audit trail see plugin write activity without
 * each plugin author needing to call recordAudit explicitly.
 */
async function emitPluginAuditRow(
  adapter: DatabaseAdapter,
  args: {
    actorId: string;
    operation: string;
    inputArgs: unknown;
    entityId: string | null;
    succeeded: boolean;
  },
): Promise<void> {
  const hash = auditInputDigest(args.inputArgs);
  await adapter.withAdminTransaction(
    {
      actorId: args.actorId,
      actorKind: "plugin",
      requestId: `plugin-op-audit-${args.operation}`,
    },
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO audit_events (actor_id, operation, input_hash, succeeded, entity_id)
        VALUES (
          ${args.actorId}::uuid,
          ${args.operation},
          ${hash},
          ${args.succeeded},
          ${args.entityId === null ? null : sql`${args.entityId}::uuid`}
        )
      `);
    },
  );
}

/**
 * Extract a plausible entity id from a plugin op's return value. The
 * convention: handlers that affect a specific row return an object
 * with a field matching the table's primary key (`commentId`,
 * `ratingId`, `formSubmissionId`, …) OR a generic `id`. The audit
 * row's entity_id then names the row the op touched. Falls back to
 * null when the result doesn't look like one of these shapes.
 */
function extractEntityId(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  // Common per-table conventions first.
  for (const key of ["commentId", "ratingId", "formSubmissionId", "subscriberId", "campaignId"]) {
    const v = r[key];
    if (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)) return v;
  }
  // Generic fallback.
  if (typeof r.id === "string" && /^[0-9a-f-]{36}$/i.test(r.id)) return r.id;
  return null;
}

/**
 * P13 — invoke the plugin's `staticRender(ctx, {pageId})`
 * function via the same context factory used by ordinary ops. Returns
 * `null` when the plugin doesn't declare a staticRender. Used by the
 * static generator's plugin pass to bake plugin-emitted HTML at deploy.
 */
export async function runPluginStaticRender(opts: {
  pluginSlug: string;
  pageId: string;
  pageUrlStyle: PageUrlStyle;
  invocation: PluginInvocation;
}): Promise<string | null> {
  const plugin = loadedPlugins.bySlug(opts.pluginSlug);
  if (!plugin) return null;
  const render = plugin.definition.staticRender;
  if (typeof render !== "function") return null;
  if (!cachedInfra || !makeContext) {
    throw new Error("plugin host not bootstrapped");
  }
  assertInvocationConsistent(opts.invocation, undefined);
  const ctx = await makeContext({ plugin, infra: cachedInfra, invocation: opts.invocation });
  const out = await render(ctx as PluginContext, {
    pageId: opts.pageId,
    pageUrlStyle: opts.pageUrlStyle,
  });
  return typeof out === "string" ? out : "";
}

/**
 * #449 — invoke the plugin's `buildAssets(...)` once for a build.
 *
 * Returns `{}` for a plugin that declares none, so callers can iterate
 * every plugin without branching. A plugin that DOES declare it and
 * throws propagates: see `collectBuildAssets` for why a missing runtime
 * has to stop the build rather than ship a silently inert page.
 */
export async function runPluginBuildAssets(opts: {
  pluginSlug: string;
  pageIds: ReadonlyArray<string>;
  invocation: PluginInvocation;
}): Promise<Record<string, string>> {
  const plugin = loadedPlugins.bySlug(opts.pluginSlug);
  if (!plugin) return {};
  const build = plugin.definition.buildAssets;
  if (typeof build !== "function") return {};
  if (!cachedInfra || !makeContext) {
    throw new Error("plugin host not bootstrapped");
  }
  assertInvocationConsistent(opts.invocation, undefined);
  const ctx = await makeContext({ plugin, infra: cachedInfra, invocation: opts.invocation });
  const out = await build(ctx as PluginContext, { pageIds: opts.pageIds });
  if (out === null || typeof out !== "object" || Array.isArray(out)) {
    throw new Error(
      `plugin "${opts.pluginSlug}" buildAssets returned ${Array.isArray(out) ? "an array" : typeof out} — expected an object of {fileName: contents}`,
    );
  }
  return out;
}

/**
 * P13 perf-pass — invoke the plugin's `metaSignatureBatch(...)` to
 * resolve N page signatures in ONE call. Returns a Map keyed
 * by pageId. Empty Map when the plugin doesn't declare the batch
 * variant — caller falls back to per-page `runPluginMetaSignature`.
 */
export async function runPluginMetaSignatureBatch(opts: {
  pluginSlug: string;
  pageIds: ReadonlyArray<string>;
  invocation: PluginInvocation;
}): Promise<ReadonlyMap<string, string>> {
  const plugin = loadedPlugins.bySlug(opts.pluginSlug);
  if (!plugin) return new Map();
  const sig = (plugin.definition as { metaSignatureBatch?: unknown }).metaSignatureBatch;
  if (typeof sig !== "function") return new Map();
  if (!cachedInfra || !makeContext) {
    throw new Error("plugin host not bootstrapped");
  }
  assertInvocationConsistent(opts.invocation, undefined);
  const ctx = await makeContext({ plugin, infra: cachedInfra, invocation: opts.invocation });
  const out = await (
    sig as (
      c: unknown,
      a: { pageIds: ReadonlyArray<string> },
    ) => Promise<ReadonlyMap<string, string>> | ReadonlyMap<string, string>
  )(ctx, { pageIds: opts.pageIds });
  return out instanceof Map ? out : new Map();
}

/**
 * P13 audit fix #4 — invoke the plugin's `metaSignature(...)` to fold
 * its data-change signal into the static_bakes cache key. Returns the
 * plugin's own signature string (any shape — opaque to the cache).
 * Returns "" when the plugin doesn't declare metaSignature.
 */
export async function runPluginMetaSignature(opts: {
  pluginSlug: string;
  pageId: string;
  invocation: PluginInvocation;
}): Promise<string> {
  const plugin = loadedPlugins.bySlug(opts.pluginSlug);
  if (!plugin) return "";
  const sig = (plugin.definition as { metaSignature?: unknown }).metaSignature;
  if (typeof sig !== "function") return "";
  if (!cachedInfra || !makeContext) {
    throw new Error("plugin host not bootstrapped");
  }
  assertInvocationConsistent(opts.invocation, undefined);
  const ctx = await makeContext({ plugin, infra: cachedInfra, invocation: opts.invocation });
  const out = await (sig as (c: unknown, a: { pageId: string }) => Promise<string> | string)(ctx, {
    pageId: opts.pageId,
  });
  return typeof out === "string" ? out : "";
}
