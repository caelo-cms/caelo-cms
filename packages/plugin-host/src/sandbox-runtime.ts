// SPDX-License-Identifier: MPL-2.0

/** Execute validated external plugin code in a bounded Deno process, never in the host. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSource } from "@caelo-cms/plugin-sandbox";
import type { PluginContext, PluginManifest } from "@caelo-cms/plugin-sdk";
import { z } from "zod";
import { sandboxEntrySource } from "./sandbox-entry.js";
import {
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
  readonly timeoutMs?: number;
}

const table = z
  .string()
  .regex(/^[a-z_][a-z0-9_]*$/)
  .max(120);
const record = z.record(z.string(), z.unknown());
const id = z.string().uuid();

async function broker(ctx: PluginContext, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
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

async function bundle(source: string): Promise<string> {
  const failures = validateSource({ source, filename: "external-plugin.ts" });
  if (failures.length)
    throw new Error(`SandboxSourceRejected: ${failures.map((f) => f.kind).join(", ")}`);
  const built = await Bun.build({
    entrypoints: ["caelo:entry"],
    target: "browser",
    format: "esm",
    minify: false,
    plugins: [
      {
        name: "isolated-plugin",
        setup(build) {
          build.onResolve({ filter: /^caelo:/ }, (args) => ({
            path: args.path,
            namespace: "caelo",
          }));
          build.onLoad({ filter: /.*/, namespace: "caelo" }, (args) => ({
            contents: args.path === "caelo:entry" ? sandboxEntrySource : source,
            loader: "ts",
          }));
          build.onResolve({ filter: /^@caelo-cms\/plugin-(sdk|component-kit)$/ }, (args) => ({
            path: import.meta.resolve(args.path).replace(/^file:\/\//, ""),
          }));
        },
      },
    ],
  });
  const output = built.outputs[0];
  if (!built.success || built.outputs.length !== 1 || !output)
    throw new Error(`SandboxBuildFailed: ${built.logs.join("; ")}`);
  return output.text();
}

let running = 0;
/** Execute one operation with no filesystem, network, environment, subprocess or FFI permissions. */
export async function runSandbox(invocation: SandboxInvocation): Promise<unknown> {
  if (running >= 4) throw new Error("SandboxBusy: retry after another invocation completes");
  running++;
  let directory: string | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let outstanding: Promise<unknown> | undefined;
  try {
    if (Buffer.byteLength(invocation.source) > 800_000) throw new Error("SandboxSourceTooLarge");
    await invocation.authorize();
    const code = await bundle(invocation.source);
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
        "--v8-flags=--max-old-space-size=128",
        entry,
      ],
      {
        cwd: directory,
        env: { DENO_DIR: directory, TMPDIR: directory, NO_COLOR: "1" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const proc = child as Bun.Subprocess<"pipe", "pipe", "ignore">;
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
    }, invocation.timeoutMs ?? 30_000);
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
      theme: context.theme,
      visitor: {
        id: context.visitor.id,
        publicUserId: context.visitor.publicUserId,
        ipHash: context.visitor.ipHash,
        sessionToken: context.visitor.sessionToken,
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
      if (message.id !== nextCall++ || nextCall > SANDBOX_CALL_LIMIT)
        throw new Error("SandboxCallLimitOrSequence");
      await bounded(invocation.authorize());
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
    throw new Error(timedOut ? "SandboxTimeout" : `SandboxExited: code ${await proc.exited}`);
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
        () => {
          running--;
        },
        () => {
          running--;
        },
      );
    else running--;
  }
}
