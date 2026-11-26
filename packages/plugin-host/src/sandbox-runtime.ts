// SPDX-License-Identifier: MPL-2.0

/** Execute validated external plugin code in a bounded Deno process, never in the host. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSource } from "@caelo-cms/plugin-sandbox";
import {
  CONFIG_ENTITY_KINDS,
  type PluginContext,
  type PluginContextTier1,
  type PluginManifest,
} from "@caelo-cms/plugin-sdk";
import { z } from "zod";
import { sandboxEntrySource, sandboxPreludeSource } from "./sandbox-entry.js";
import type { SandboxKind } from "./sandbox-kind.js";
import {
  SANDBOX_BACKGROUND_CALL_LIMIT,
  SANDBOX_BATCH_CALL_LIMIT,
  SANDBOX_CALL_LIMIT,
  SANDBOX_MESSAGE_BYTES,
  sandboxLines,
  sandboxMessage,
} from "./sandbox-protocol.js";

/** Per-invocation inputs are host-owned; the child cannot select its identity or context. */
export interface SandboxInvocation {
  readonly source: string;
  readonly manifest: PluginManifest;
  readonly operation: string;
  readonly args: unknown;
  readonly context: PluginContext;
  readonly authorize: () => Promise<void>;
  /** What the call is for: its slot pool, time budget and call limit (default `interactive`). */
  readonly kind?: SandboxKind;
  /** Overrides the kind's time budget (a batch's `maxRunSeconds`, a probe's own limit). */
  readonly timeoutMs?: number;
  readonly denySdkCalls?: boolean;
  /** Overrides the kind's SDK call limit. */
  readonly callLimit?: number;
}

type SandboxPoolName = "interactive" | "background";

interface SandboxBudget {
  readonly pool: SandboxPoolName;
  readonly timeoutMs: number;
  readonly callLimit: number;
}

/**
 * Per kind: the pool, the time one invocation may take and the SDK calls it
 * may make (Q10's table). A background run pages through its data in many
 * calls; its time budget, not the call count, bounds it.
 */
export const SANDBOX_BUDGETS: Readonly<Record<SandboxKind, SandboxBudget>> = Object.freeze({
  /** Chat, Owner panel, approved tool calls, activation, system calls. */
  interactive: { pool: "interactive", timeoutMs: 30_000, callLimit: SANDBOX_CALL_LIMIT },
  /** One composition point (and chunk) of an editor preview pass. */
  preview: { pool: "interactive", timeoutMs: 5_000, callLimit: SANDBOX_CALL_LIMIT },
  /** A render outside a preview pass: a build, a Stage audit, a link migration. */
  build: { pool: "interactive", timeoutMs: 60_000, callLimit: SANDBOX_CALL_LIMIT },
  /** One worker run, inside the tick's 5-minute lease. */
  worker: { pool: "background", timeoutMs: 240_000, callLimit: SANDBOX_BACKGROUND_CALL_LIMIT },
  /** One change-journal batch. */
  journal: { pool: "background", timeoutMs: 60_000, callLimit: SANDBOX_BACKGROUND_CALL_LIMIT },
  /** One resumable rebuild chunk. */
  rebuild: { pool: "background", timeoutMs: 120_000, callLimit: SANDBOX_BACKGROUND_CALL_LIMIT },
  /** A batch operation; the caller sets the budget from its `maxRunSeconds`. */
  batch: { pool: "background", timeoutMs: 240_000, callLimit: SANDBOX_BATCH_CALL_LIMIT },
});

/** An interactive call that may spend the install's AI (`ai_provider`, `image_generation`). */
export const SANDBOX_AI_INTERACTIVE_MS = 240_000;

/**
 * Slots per pool and how long a call waits for one before `SandboxBusy`.
 * Each child is a Deno process with a 256 MB heap, so the pools bound the
 * memory and CPU sandboxed plugins take from the admin at once.
 */
export const SANDBOX_POOLS: Readonly<
  Record<SandboxPoolName, { readonly slots: number; readonly waitMs: number }>
> = Object.freeze({
  interactive: { slots: 4, waitMs: 2_000 },
  background: { slots: 2, waitMs: 30_000 },
});

/**
 * A bounded set of sandbox slots. A call waits at most `waitMs` for one;
 * the wait is a timer within the caller's own request, never background
 * work (CLAUDE.md §11.B).
 */
class SlotPool {
  #active = 0;
  readonly #waiting: Array<{ readonly grant: () => void }> = [];
  constructor(
    readonly name: SandboxPoolName,
    readonly slots: number,
    readonly waitMs: number,
  ) {}

  /** Resolves once the caller holds a slot; throws `SandboxBusy` after `waitMs`. */
  acquire(): Promise<void> {
    if (this.#active < this.slots) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const at = this.#waiting.indexOf(entry);
        if (at >= 0) this.#waiting.splice(at, 1);
        reject(
          new Error(
            `SandboxBusy: all ${this.slots} ${this.name} sandbox slots stayed taken for ${this.waitMs / 1000} s; retry once another plugin call has finished`,
          ),
        );
      }, this.waitMs);
      this.#waiting.push(entry);
    });
  }

  /** Hands the slot to the next waiter, or frees it. */
  release(): void {
    const next = this.#waiting.shift();
    if (next) next.grant();
    else this.#active--;
  }

  /** Slots in use now (tests). */
  get active(): number {
    return this.#active;
  }
}

const pools: Readonly<Record<SandboxPoolName, SlotPool>> = {
  interactive: new SlotPool(
    "interactive",
    SANDBOX_POOLS.interactive.slots,
    SANDBOX_POOLS.interactive.waitMs,
  ),
  background: new SlotPool(
    "background",
    SANDBOX_POOLS.background.slots,
    SANDBOX_POOLS.background.waitMs,
  ),
};

/** Slots in use per pool (tests and plugin health). */
export function sandboxSlotsInUse(): Readonly<Record<SandboxPoolName, number>> {
  return { interactive: pools.interactive.active, background: pools.background.active };
}

const table = z
  .string()
  .regex(/^[a-z_][a-z0-9_]*$/)
  .max(120);
const collectionName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/** Every entity kind the SDK's config reader takes (pages, modules, content blocks, page types). */
const entityKind = z.enum(CONFIG_ENTITY_KINDS);
const record = z.record(z.string(), z.unknown());
const id = z.string().uuid();

/**
 * Run one SDK call a sandboxed plugin made, on the host's context for it.
 * Exported for the batch job's remote broker (#1646): a call the plugin
 * makes in a job container is answered by the admin through this same
 * function, on a context the admin built — the job's word grants nothing.
 * Results must be JSON: a Map (config.entities) travels as entry pairs.
 */
export async function brokerSandboxCall(
  ctx: PluginContext,
  method: string,
  args: unknown[],
): Promise<unknown> {
  return broker(ctx, method, args);
}

async function broker(ctx: PluginContext, method: string, args: unknown[]): Promise<unknown> {
  if (method.startsWith("config.")) {
    const config = ctx.config;
    if (!config) throw new Error("SandboxCapabilityDenied: config (the plugin declares none)");
    switch (method) {
      case "config.get":
        if (args.length !== 0) throw new Error("SandboxArgumentsInvalid");
        return config.get();
      case "config.entity": {
        const [kind, entityId] = z.tuple([entityKind, z.string().min(1).max(64)]).parse(args);
        return config.entity(kind, entityId);
      }
      case "config.entities": {
        const [kind, ids] = z
          .tuple([entityKind, z.array(z.string().min(1).max(64)).max(1000)])
          .parse(args);
        return [...(await config.entities(kind, ids)).entries()];
      }
      case "config.configured":
        return config.configured(z.tuple([entityKind]).parse(args)[0]);
    }
  }
  if (method === "chatTools.run") {
    const chatTools = ctx.chatTools;
    if (!chatTools) throw new Error("SandboxCapabilityDenied: chatTools");
    const [conversation, tool, input, opts] = z
      .tuple([
        z.string().max(120),
        z.object({ plugin: z.string().max(55), operation: z.string().max(120) }).strict(),
        z.record(z.string().max(40), z.string().max(2000)),
        z
          .object({
            lang: z.string().max(35),
            runId: z.string().uuid().optional(),
            at: z.enum(["staged", "live"]).optional(),
          })
          .strict(),
      ])
      .parse(args);
    // The host handle checks the conversation, the tool and its plugin.
    return chatTools.run(conversation, tool, input, opts);
  }
  if (method.startsWith("collections.")) {
    const collections = ctx.collections;
    if (!collections) throw new Error("SandboxCapabilityDenied: collections");
    const name = collectionName.parse(args[0]);
    const handle = Object.hasOwn(collections, name) ? collections[name] : undefined;
    if (!handle) throw new Error(`SandboxCollectionNotDeclared: ${name}`);
    if (method === "collections.replace") {
      const [, field, values, docs] = z
        .tuple([
          z.string(),
          z.string().max(40),
          z.array(z.string().max(500)).max(10_000),
          z.array(record).max(500),
        ])
        .parse(args);
      return handle.replace(field, values, docs as never);
    }
    if (method === "collections.getMany") {
      const [, ids] = z
        .tuple([z.string(), z.array(z.string().min(1).max(500)).max(1000)])
        .parse(args);
      const r = await handle.getMany(ids);
      return { docs: [...r.docs.values()], pending: r.pending };
    }
    if (method === "collections.query") {
      const [, operation, params, opts] = z
        .tuple([
          z.string(),
          z.string().max(120),
          z.record(
            z.string().max(40),
            z.union([z.string().max(500), z.array(z.string().max(500)).max(20)]),
          ),
          z
            .object({
              runId: z.string().uuid().optional(),
              at: z.enum(["staged", "live"]).optional(),
              explain: z.boolean().optional(),
            })
            .strict(),
        ])
        .parse(args);
      return handle.query(operation, params, opts);
    }
    if (args.length !== 2) throw new Error("SandboxArgumentsInvalid");
    // The host handle validates documents, ids and the profile in full.
    switch (method) {
      case "collections.upsert":
        return handle.upsert(z.array(record).max(500).parse(args[1]) as never);
      case "collections.delete":
        return handle.delete(z.array(z.string().max(500)).max(1000).parse(args[1]));
      case "collections.get":
        return handle.get(z.string().min(1).max(500).parse(args[1]));
      case "collections.setProfile":
        return handle.setProfile(record.parse(args[1]) as never);
    }
  }
  if (method.startsWith("images.")) {
    const images = (ctx as PluginContextTier1).images;
    if (!images) throw new Error("SandboxCapabilityDenied: image_generation");
    switch (method) {
      case "images.transform":
        return images.transform(args[0] as Parameters<typeof images.transform>[0]);
      case "images.describe":
        return images.describe();
      case "images.get":
        return images.get(args[0] as Parameters<typeof images.get>[0]);
      case "images.generate":
        return images.generate(args[0] as Parameters<typeof images.generate>[0]);
      case "images.edit":
        return images.edit(args[0] as Parameters<typeof images.edit>[0]);
    }
  }
  if (method.startsWith("siteMedia.")) {
    const siteMedia = (ctx as PluginContextTier1).siteMedia;
    if (!siteMedia) throw new Error("SandboxCapabilityDenied: site_media_read");
    if (args.length !== 1) throw new Error("SandboxArgumentsInvalid");
    switch (method) {
      case "siteMedia.find":
        return siteMedia.find(args[0] as Parameters<typeof siteMedia.find>[0]);
      case "siteMedia.inspect":
        return siteMedia.inspect(args[0] as Parameters<typeof siteMedia.inspect>[0]);
      case "siteMedia.readChunk":
        return siteMedia.readChunk(args[0] as Parameters<typeof siteMedia.readChunk>[0]);
    }
  }
  if (method.startsWith("fonts.")) {
    const fonts = (ctx as PluginContextTier1).fonts;
    if (!fonts) throw new Error("SandboxCapabilityDenied: font_assets");
    if (args.length !== 1) throw new Error("SandboxArgumentsInvalid");
    switch (method) {
      case "fonts.find":
        return fonts.find(args[0] as Parameters<typeof fonts.find>[0]);
      case "fonts.inspect":
        return fonts.inspect(args[0] as Parameters<typeof fonts.inspect>[0]);
      case "fonts.resolve":
        return fonts.resolve(args[0] as Parameters<typeof fonts.resolve>[0]);
      case "fonts.readChunk":
        return fonts.readChunk(args[0] as Parameters<typeof fonts.readChunk>[0]);
    }
  }
  if (method.startsWith("privateFiles.")) {
    const files = (ctx as PluginContextTier1).privateFiles;
    if (!files) throw new Error("SandboxCapabilityDenied: private_files");
    const input = z.tuple([record]).parse(args)[0];
    // Each host handle validates its entire input before touching storage.
    switch (method) {
      case "privateFiles.begin":
        return files.begin(input as Parameters<typeof files.begin>[0]);
      case "privateFiles.writeChunk":
        return files.writeChunk(input as Parameters<typeof files.writeChunk>[0]);
      case "privateFiles.commit":
        return files.commit(input as Parameters<typeof files.commit>[0]);
      case "privateFiles.stat":
        return files.stat(input as Parameters<typeof files.stat>[0]);
      case "privateFiles.readChunk":
        return files.readChunk(input as Parameters<typeof files.readChunk>[0]);
      case "privateFiles.remove":
        return files.remove(input as Parameters<typeof files.remove>[0]);
      default:
        throw new Error("SandboxMethodDenied");
    }
  }
  if (method === "consentPurposes.list") {
    const purposes = (ctx as PluginContextTier1).consentPurposes;
    if (!purposes) throw new Error("SandboxCapabilityDenied: consent_provider");
    // Takes nothing: the list is the host's view of the loaded plugins,
    // and no argument the child sends may filter, extend or rename it.
    if (args.length !== 0) throw new Error("SandboxArgumentsInvalid");
    return purposes.list();
  }
  if (method.startsWith("adminQuery.")) {
    const adminQuery = (ctx as PluginContextTier1).adminQuery;
    if (!adminQuery) throw new Error("SandboxCapabilityDenied: cms_admin_schema");
    if (method === "adminQuery.upsert") {
      // #1659 — private storage only, so it never reaches the `query.` switch.
      const [t, key, values, options] = z
        .tuple([
          table,
          z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
          record,
          z
            .object({ ifExists: z.enum(["update", "keep"]).optional() })
            .strict()
            .optional(),
        ])
        .parse([args[0], args[1], args[2], args[3]]);
      if (args.length > 4) throw new Error("InvalidArguments");
      return adminQuery.upsert(t, key, values, options);
    }
    return broker({ ...ctx, query: adminQuery }, method.replace("adminQuery.", "query."), args);
  }
  switch (method) {
    case "query.compareAndSwap": {
      const a = z.tuple([table, id, record, record]).parse(args);
      return ctx.query.compareAndSwap(...a);
    }
    case "query.insert": {
      const a = z.tuple([table, record]).parse(args);
      return ctx.query.insert(...a);
    }
    case "query.list": {
      const a = z.tuple([table, record.optional()]).parse([args[0], args[1]]);
      if (args.length > 2) throw new Error("InvalidArguments");
      return ctx.query.list(...a);
    }
    case "query.update": {
      const a = z.tuple([table, id, record]).parse(args);
      return ctx.query.update(...a);
    }
    case "query.updateMany": {
      // The op caps the list at UPDATE_MANY_MAX; the bridge only checks the shape.
      const a = z.tuple([table, z.array(id), record]).parse(args);
      return ctx.query.updateMany(...a);
    }
    case "query.delete": {
      const a = z.tuple([table, id]).parse(args);
      return ctx.query.delete(...a);
    }
    case "api.list":
      return ctx.api.list(z.tuple([record]).parse(args)[0]);
    case "api.get":
      return ctx.api.get(z.tuple([record]).parse(args)[0]);
    case "captcha.requireProof":
      return ctx.captcha.requireProof(z.tuple([z.string().nullable()]).parse(args)[0]);
    default:
      throw new Error("SandboxMethodDenied");
  }
}

/** The modules `caelo:entry` imports; nothing else may resolve into the namespace. */
const BOOTSTRAP_IMPORTS: ReadonlySet<string> = new Set(["caelo:prelude", "caelo:plugin"]);

/**
 * Bundles by the SHA-256 of their source (#1729 §4.4). Validation and
 * bundling are pure functions of the source, so a cached bundle is exactly
 * what a fresh build would produce; the child is still new per call. Kept
 * small: an installed plugin's source can be megabytes.
 */
const BUNDLE_CACHE_ENTRIES = 16;
const bundles = new Map<string, Promise<string>>();

async function bundle(source: string): Promise<string> {
  const key = new Bun.CryptoHasher("sha256").update(source).digest("hex");
  const cached = bundles.get(key);
  if (cached) {
    // Most recently used last, so the oldest is evicted first.
    bundles.delete(key);
    bundles.set(key, cached);
    return cached;
  }
  const built = validateAndBundle(source);
  bundles.set(key, built);
  // A failed build is not kept: the next call reports its own reason.
  built.catch(() => {
    if (bundles.get(key) === built) bundles.delete(key);
  });
  while (bundles.size > BUNDLE_CACHE_ENTRIES) {
    const oldest = bundles.keys().next().value;
    if (oldest === undefined) break;
    bundles.delete(oldest);
  }
  return built;
}

async function validateAndBundle(source: string): Promise<string> {
  const failures = validateSource({ source, filename: "external-plugin.ts" });
  if (failures.length)
    throw new Error(`SandboxSourceRejected: ${failures.map((f) => f.kind).join(", ")}`);
  return buildIsolatedBundle(source);
}

/**
 * Bundle already-validated plugin source for the Deno child. Runs in the
 * HOST process, so it must itself refuse every resolution outside the
 * entry and the two SDK packages — exported so that second line can be
 * tested without the validator in front of it.
 *
 * @throws `SandboxResolveDenied` for any other import/require target.
 */
export async function buildIsolatedBundle(source: string): Promise<string> {
  // Bun rejects a failed build with a generic "Bundle failed"
  // AggregateError; surface the plugin-resolution reason inside it.
  const built = await Bun.build({
    entrypoints: ["caelo:entry"],
    target: "browser",
    format: "esm",
    minify: false,
    plugins: [
      {
        name: "isolated-plugin",
        setup(build) {
          // Only the trusted entry may name the bootstrap modules. Plugin
          // code importing "caelo:prelude" would get the captured stdout
          // writer; importing "caelo:entry" would re-run the protocol loop.
          build.onResolve({ filter: /^caelo:/ }, (args) => {
            const fromEntry = args.importer === "caelo:entry";
            const isEntrypoint = args.path === "caelo:entry" && args.kind === "entry-point-build";
            if (!isEntrypoint && !(fromEntry && BOOTSTRAP_IMPORTS.has(args.path))) {
              throw new Error(
                `SandboxResolveDenied: plugin code may import only "@caelo-cms/plugin-sdk" (asked for "${args.path}")`,
              );
            }
            return { path: args.path, namespace: "caelo" };
          });
          build.onLoad({ filter: /.*/, namespace: "caelo" }, (args) => ({
            contents:
              args.path === "caelo:entry"
                ? sandboxEntrySource
                : args.path === "caelo:prelude"
                  ? sandboxPreludeSource
                  : source,
            loader: args.path === "caelo:plugin" ? "ts" : "js",
          }));
          build.onResolve({ filter: /^@caelo-cms\/plugin-(sdk|component-kit)$/ }, (args) => ({
            path: import.meta.resolve(args.path).replace(/^file:\/\//, ""),
          }));
          // Defense in depth behind validateSource: this build runs in
          // the HOST, with host filesystem access, before the Deno
          // sandbox exists. Anything the plugin's own code asks for
          // beyond the entry and the two SDK packages — a relative
          // path, an absolute host path, a require() the validator
          // missed — would be inlined from the host disk. Registered
          // last, so the two allowed resolutions above win.
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.namespace === "caelo" || args.importer.startsWith("caelo:")) {
              throw new Error(
                `SandboxResolveDenied: plugin code may import only "@caelo-cms/plugin-sdk" (asked for "${args.path}")`,
              );
            }
            return undefined;
          });
        },
      },
    ],
  }).catch((e: unknown) => {
    const inner =
      e instanceof AggregateError ? e.errors.map((x) => String((x as Error)?.message ?? x)) : [];
    throw new Error(
      `SandboxBuildFailed: ${inner.length > 0 ? inner.join("; ") : e instanceof Error ? e.message : String(e)}`,
    );
  });
  const output = built.outputs[0];
  if (!built.success || built.outputs.length !== 1 || !output)
    throw new Error(`SandboxBuildFailed: ${built.logs.join("; ")}`);
  return output.text();
}

/** Execute one operation with no filesystem, network, environment, subprocess or FFI permissions. */
export function runSandbox(invocation: SandboxInvocation): Promise<unknown> {
  return runSandboxWithBundler(invocation, bundle);
}

/**
 * `runSandbox` with the bundling step supplied by the caller. Production
 * code calls `runSandbox`, whose bundler runs `validateSource` first; the
 * runtime-layer tests pass `buildIsolatedBundle` directly so source the
 * validator would refuse still reaches Deno, proving the second layer
 * (permissions, prelude, code-generation ban) holds on its own.
 */
/** Bytes of a crashed child's stderr kept to say why it exited. */
const STDERR_HEAD_BYTES = 2048;

/**
 * The first `limit` bytes of a stream, reading it to its end (the rest is
 * dropped), so a child writing more can never block on a full pipe.
 * Exported for its unit test.
 */
export async function streamHead(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const head = new Uint8Array(limit);
  let kept = 0;
  try {
    for await (const chunk of stream) {
      if (kept >= limit) continue;
      const take = Math.min(limit - kept, chunk.byteLength);
      head.set(chunk.subarray(0, take), kept);
      kept += take;
    }
  } catch {
    // The child was killed mid-write: what arrived is enough.
  }
  return head.subarray(0, kept);
}

/**
 * Why a child exited, from the start of its stderr (Deno's "error: …" for an
 * uncaught exception): one line, control characters dropped, at most 300
 * characters. It is the plugin's own text, as a thrown error's message is.
 */
export function exitReason(stderr: Uint8Array): string {
  const text = new TextDecoder().decode(stderr);
  let line = "";
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed !== "") {
      line = trimmed;
      break;
    }
  }
  let out = "";
  for (const ch of line) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 32 || c === 127 ? " " : ch;
    if (out.length >= 300) break;
  }
  return out.trim();
}

export async function runSandboxWithBundler(
  invocation: SandboxInvocation,
  build: (source: string) => Promise<string>,
): Promise<unknown> {
  const budget = SANDBOX_BUDGETS[invocation.kind ?? "interactive"];
  const callLimit = invocation.callLimit ?? budget.callLimit;
  const pool = pools[budget.pool];
  await pool.acquire();
  let directory: string | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let outstanding: Promise<unknown> | undefined;
  try {
    if (Buffer.byteLength(invocation.source) > 16_000_000) throw new Error("SandboxSourceTooLarge");
    await invocation.authorize();
    const code = await build(invocation.source);
    directory = await mkdtemp(join(tmpdir(), "caelo-plugin-"));
    const entry = join(directory, "entry.mjs");
    await writeFile(entry, code, { mode: 0o600 });
    const executable = process.env.CAELO_DENO_BINARY ?? Bun.which("deno");
    if (!executable)
      throw new Error("SandboxRuntimeMissing: install Deno or configure CAELO_DENO_BINARY");
    child = Bun.spawn(
      [
        executable,
        "run",
        "--no-config",
        "--no-lock",
        "--no-npm",
        "--no-remote",
        "--no-prompt",
        "--deny-read",
        "--deny-write",
        "--deny-net",
        "--deny-env",
        "--deny-run",
        "--deny-ffi",
        "--deny-sys",
        // eval / Function / the constructor-of-a-function trick all die
        // here at runtime, whatever spelling slipped past the validator.
        "--v8-flags=--max-old-space-size=256,--disallow-code-generation-from-strings",
        entry,
      ],
      {
        cwd: directory,
        env: { DENO_DIR: directory, TMPDIR: directory, NO_COLOR: "1" },
        stdin: "pipe",
        stdout: "pipe",
        // Read for its first bytes only (why a crashed child exited), and
        // drained to the end so a chatty plugin can never block on a full pipe.
        stderr: "pipe",
      },
    );
    const proc = child as Bun.Subprocess<"pipe", "pipe", "pipe">;
    const stderrHead = streamHead(proc.stderr, STDERR_HEAD_BYTES);
    let rejectTimeout: (error: Error) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    // Attach a rejection handler while the protocol is waiting for stdout.
    void deadline.catch(() => {});
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
      rejectTimeout(new Error("SandboxTimeout"));
    }, invocation.timeoutMs ?? budget.timeoutMs);
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
      outstanding = work;
      try {
        return await Promise.race([work, deadline]);
      } finally {
        if (!timedOut) outstanding = undefined;
      }
    };
    const send = (message: unknown) => {
      const line = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(line) > SANDBOX_MESSAGE_BYTES)
        throw new Error("SandboxMessageTooLarge");
      proc.stdin.write(line);
      proc.stdin.flush();
    };
    const { context, manifest } = invocation;
    send({
      slug: manifest.slug,
      version: manifest.version,
      operation: invocation.operation,
      args: invocation.args,
      // Read-only for the plugin (SDK contract, #509): who acts and on
      // which branch. Enforcement stays host-side — the broker below runs
      // every SDK call through `context`, which carries the same values.
      invocation: context.invocation,
      theme: context.theme,
      // The child builds `ctx.adminQuery` only when the host attached one.
      hasAdminQuery: Boolean((context as PluginContextTier1).adminQuery),
      hasImages: Boolean((context as PluginContextTier1).images),
      hasFonts: Boolean((context as PluginContextTier1).fonts),
      hasPrivateFiles: Boolean((context as PluginContextTier1).privateFiles),
      hasSiteMedia: Boolean((context as PluginContextTier1).siteMedia),
      hasConsentPurposes: Boolean((context as PluginContextTier1).consentPurposes),
      callLimit,
      hasConfig: Boolean(context.config),
      collections: Object.keys(context.collections ?? {}),
      hasChatTools: Boolean(context.chatTools),
      // No sessionToken: it is the visitor's login bearer credential (the
      // `login` entry of the HttpOnly `__session` cookie). Handing it to
      // runtime-authored code would let a plugin collect tokens in its own
      // schema and replay them to take over logged-in visitors' sessions.
      // The opaque id is enough to key per-visitor state.
      visitor: {
        id: context.visitor.id,
        publicUserId: context.visitor.publicUserId,
        ipHash: context.visitor.ipHash,
        sessionToken: null,
      },
    });
    let nextCall = 0;
    for await (const line of sandboxLines(proc.stdout)) {
      if (timedOut) throw new Error("SandboxTimeout");
      const message = sandboxMessage.parse(JSON.parse(line));
      if (message.kind === "error") throw new Error(`SandboxOperationFailed: ${message.message}`);
      if (message.kind === "result") {
        await bounded(invocation.authorize());
        return message.value;
      }
      if (message.id !== nextCall++ || nextCall > callLimit)
        throw new Error("SandboxCallLimitOrSequence");
      await bounded(invocation.authorize());
      if (invocation.denySdkCalls) throw new Error("SandboxInstallationCannotCallSdk");
      try {
        const value = await bounded(broker(context, message.method, message.args));
        send({ id: message.id, ok: true, value: value ?? null });
      } catch (error) {
        if (timedOut) throw new Error("SandboxTimeout");
        send({
          id: message.id,
          ok: false,
          message: error instanceof Error ? error.message : "SDK call failed",
        });
      }
    }
    if (timedOut) throw new Error("SandboxTimeout");
    const exitCode = await proc.exited;
    const why = exitReason(await stderrHead);
    throw new Error(`SandboxExited: code ${exitCode}${why ? ` (${why})` : ""}`);
  } finally {
    if (timer) clearTimeout(timer);
    if (child) {
      child.kill("SIGKILL");
      await child.exited;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    // A timed-out SDK call may still be settling. Keep its concurrency slot
    // reserved so repeatedly timing out cannot accumulate unbounded host work.
    if (outstanding)
      void outstanding.then(
        () => pool.release(),
        () => pool.release(),
      );
    else pool.release();
  }
}
