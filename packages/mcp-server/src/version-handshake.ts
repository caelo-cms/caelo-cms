// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #764 — the shim pins itself to the admin's release.
 *
 * mcp-server ships in lockstep with the admin. Rather than baking the
 * version into the `claude mcp add` command — which forced the operator
 * to re-add the server after every upgrade — the command runs
 * `@caelo-cms/mcp-server@latest` and each bin asks the admin which
 * release it runs before starting. On a mismatch it re-execs as
 * `bun x --package @caelo-cms/mcp-server@<admin release> <same bin>` with
 * inherited stdio, so the MCP client never notices.
 *
 * Why `@latest` and not a bare package name: bunx reuses a cached
 * unversioned install for up to a day and prefers a same-named binary
 * on PATH, so a bare name could start a shim that predates this
 * handshake and never asks. A dist-tag makes bunx ask the registry on
 * every start; the exact version the handshake re-execs as is then
 * served from bunx's per-version cache.
 *
 * FROZEN PROTOCOL. Every shim released since #764 performs this
 * handshake against whatever admin it is pointed at, and an older shim
 * re-execs into newer releases. So these must never change
 * incompatibly: `POST /api/mcp/version` with the `x-caelo-mcp-token`
 * header, the `{ version }` response body, the re-exec argv shape
 * (`x --package @caelo-cms/mcp-server@<v> <bin> ...args`), the bin names
 * `caelo-mcp-server` / `caelo-admin-mcp`, and the `CAELO_MCP_REEXEC_FROM`
 * guard variable. Extend additively only.
 *
 * No fallbacks (CLAUDE.md §2): when the versions cannot be matched the
 * shim exits with an actionable message instead of running a release
 * that does not belong to the admin.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { postAdmin, resolveTimeoutMs } from "./http.js";

const PACKAGE_NAME = "@caelo-cms/mcp-server";

/**
 * How long the startup handshake waits for the admin. Claude Code gives
 * an MCP server 30s to start (`MCP_TIMEOUT`); a scale-to-zero admin's
 * cold start plus the one-time download of a new release must fit in
 * that, so the handshake gets 20s and fails with its own message rather
 * than being killed silently by the client.
 */
export const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * `/api/mcp/version`'s body (frozen, see the file header). The version
 * must be an exact release: an empty or tag-like value would let bunx
 * resolve `latest`, silently running a shim that does not belong to the
 * admin.
 */
export const adminVersionResponse = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
});

/**
 * Set on the re-exec'd child to the parent's version, so a child that
 * still mismatches fails instead of re-execing forever. Frozen: older
 * parents set it on newer children.
 */
export const REEXEC_GUARD_ENV = "CAELO_MCP_REEXEC_FROM";

/** What the shim does after comparing its own release to the admin's. */
export type HandshakeDecision =
  | { readonly kind: "match" }
  | { readonly kind: "reexec"; readonly version: string }
  | { readonly kind: "error"; readonly message: string };

/** Pure decision: run as-is, re-exec as the admin's release, or fail. */
export function decideHandshake(args: {
  readonly own: string;
  readonly admin: string;
  /** The parent's version when this process is already a re-exec. */
  readonly reexecFrom: string | undefined;
}): HandshakeDecision {
  if (args.own === args.admin) return { kind: "match" };
  if (args.reexecFrom !== undefined) {
    // bunx installs exactly the requested version (or fails, which the
    // parent reports), so a re-exec'd child only lands here when the
    // admin's release changed between the parent's handshake and ours.
    return {
      kind: "error",
      message:
        `caelo mcp: started as ${args.own} (switched from ${args.reexecFrom}) to match the admin, ` +
        `but the admin now runs ${args.admin} — it was most likely upgraded while the MCP server ` +
        "was starting. Restart the MCP server.",
    };
  }
  return { kind: "reexec", version: args.admin };
}

/**
 * argv for re-running `bin` (with the caller's own args) as `version`.
 * Frozen shape: released parents spawn exactly this into newer releases.
 */
export function reexecArgv(args: {
  readonly version: string;
  readonly bin: string;
  readonly forwardedArgs: readonly string[];
  /** Absolute path of the running bun, when there is one. */
  readonly bunPath: string | undefined;
}): string[] {
  const tail = ["--package", `${PACKAGE_NAME}@${args.version}`, args.bin, ...args.forwardedArgs];
  return args.bunPath ? [args.bunPath, "x", ...tail] : ["bunx", ...tail];
}

/**
 * The handshake decides which code runs on this machine, so it is never
 * read over plain http — a network attacker could steer the shim to an
 * older, vulnerable release. Loopback admins (local dev) are exempt.
 * Returns the problem to report, or null when the URL is acceptable.
 */
export function handshakeUrlProblem(adminUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(adminUrl);
  } catch {
    return `CAELO_ADMIN_URL is not a URL (got ${JSON.stringify(adminUrl)}) — set it to your install's https:// address`;
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return null;
  }
  return (
    `CAELO_ADMIN_URL must use https:// (got ${url.protocol}//${url.host}). The MCP server asks ` +
    "the admin which release to run, and that answer is never accepted over plain http. Change " +
    `CAELO_ADMIN_URL to https://${url.host} (plain http is only allowed for localhost, 127.0.0.1 and ::1).`
  );
}

/**
 * Turns a failed `/api/mcp/version` call into the next step to take. A
 * 404 means the admin predates the handshake, so the version must ride
 * in the command once more.
 */
export function describeVersionFetchFailure(message: string, bin: string): string {
  if (message.startsWith("HTTP 404")) {
    return (
      "this admin predates the MCP version handshake (#764). Upgrade the admin, or pin the " +
      `shim to the admin's release in your MCP config: bunx --package ${PACKAGE_NAME}@<admin release> ${bin}`
    );
  }
  return `could not read the admin's release from /api/mcp/version: ${message}`;
}

/** Reported when the re-exec'd release exits non-zero. */
export function describeChildExit(version: string, code: number): string {
  return (
    `caelo mcp: could not run ${PACKAGE_NAME}@${version} (exit ${code}) — check the release is ` +
    "published and the npm registry is reachable. (If the server printed its own error above, " +
    "that error is the cause.)"
  );
}

/** This package's own release, read from the package.json shipped next to dist/ (and src/). */
export function ownVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string") {
    throw new Error(`${PACKAGE_NAME} package.json has no version`);
  }
  return pkg.version;
}

/** The slice of a spawned child the re-exec relies on. */
export interface ReexecChild {
  on(event: "error", listener: (e: Error) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal: NodeJS.Signals): unknown;
}

/** Process I/O behind `ensureAdminRelease`, injectable for tests. */
export interface HandshakeIo {
  readonly fetchAdminVersion: (adminUrl: string, token: string) => Promise<unknown>;
  readonly spawn: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => ReexecChild;
  readonly ownVersion: () => string;
  readonly env: NodeJS.ProcessEnv;
  /** The caller's own args, forwarded to the re-exec. */
  readonly forwardedArgs: readonly string[];
  readonly bunPath: string | undefined;
  readonly onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  readonly log: (line: string) => void;
  readonly exit: (code: number) => never;
}

const processIo: HandshakeIo = {
  fetchAdminVersion: (adminUrl, token) =>
    postAdmin<unknown>({
      adminUrl,
      token,
      path: "/api/mcp/version",
      body: {},
      timeoutMs: resolveTimeoutMs(HANDSHAKE_TIMEOUT_MS),
    }),
  spawn: (command, args, env) => nodeSpawn(command, args, { stdio: "inherit", env }),
  ownVersion,
  env: process.env,
  forwardedArgs: process.argv.slice(2),
  bunPath: process.versions.bun ? process.execPath : undefined,
  onSignal: (signal, handler) => process.on(signal, handler),
  log: (line) => console.error(line),
  exit: (code) => process.exit(code),
};

/**
 * Returns when this process already is the admin's release. Otherwise it
 * runs the matching release as a child and exits with the child's code,
 * or exits 2 with an actionable message — it never returns in those cases.
 */
export async function ensureAdminRelease(
  opts: {
    readonly adminUrl: string;
    readonly token: string;
    /** The bin to re-run: `caelo-mcp-server` or `caelo-admin-mcp`. */
    readonly bin: string;
  },
  io: HandshakeIo = processIo,
): Promise<void> {
  const urlProblem = handshakeUrlProblem(opts.adminUrl);
  if (urlProblem) {
    io.log(urlProblem);
    io.exit(2);
  }

  let body: unknown;
  try {
    body = await io.fetchAdminVersion(opts.adminUrl, opts.token);
  } catch (e) {
    io.log(describeVersionFetchFailure(e instanceof Error ? e.message : String(e), opts.bin));
    io.exit(2);
  }
  const parsed = adminVersionResponse.safeParse(body);
  if (!parsed.success) {
    io.log(
      `/api/mcp/version did not return an exact release (got ${JSON.stringify(body)}) — ` +
        "check that CAELO_ADMIN_URL points at a Caelo admin",
    );
    io.exit(2);
  }

  const own = io.ownVersion();
  const decision = decideHandshake({
    own,
    admin: parsed.data.version,
    reexecFrom: io.env[REEXEC_GUARD_ENV],
  });
  if (decision.kind === "match") return;
  if (decision.kind === "error") {
    io.log(decision.message);
    io.exit(2);
  }

  io.log(`caelo mcp: admin runs ${decision.version}, this shim is ${own} — switching`);
  const [command, ...args] = reexecArgv({
    version: decision.version,
    bin: opts.bin,
    forwardedArgs: io.forwardedArgs,
    bunPath: io.bunPath,
  });
  const child = io.spawn(command as string, args, { ...io.env, [REEXEC_GUARD_ENV]: own });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    io.onSignal(signal, () => child.kill(signal));
  }
  const code = await new Promise<number>((resolve) => {
    child.on("error", (e) => {
      io.log(`caelo mcp: could not start ${PACKAGE_NAME}@${decision.version}: ${e.message}`);
      resolve(2);
    });
    child.on("exit", (exitCode) => {
      // null: killed by a signal we forwarded (the client shut us down) — not a failure to report.
      if (exitCode === null) return resolve(1);
      if (exitCode !== 0) io.log(describeChildExit(decision.version, exitCode));
      resolve(exitCode);
    });
  });
  io.exit(code);
}
