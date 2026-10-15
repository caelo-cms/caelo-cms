// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #764 — the shim pins itself to the admin's release.
 *
 * mcp-server ships in lockstep with the admin, and bunx caches an
 * unversioned package indefinitely (#552). Rather than baking the version
 * into the `claude mcp add` command — which forced the operator to re-add
 * the server after every upgrade — each bin asks the admin which release
 * it runs before starting. On a mismatch it re-execs as
 * `bunx --package @caelo-cms/mcp-server@<admin release> <same bin>` with
 * inherited stdio, so the MCP client never notices. bunx caches exact
 * versions correctly, so the next start lands on the right one directly.
 *
 * No fallbacks (CLAUDE.md §2): when the versions cannot be matched the
 * shim exits with an actionable message instead of running a release
 * that does not belong to the admin.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { postAdmin, resolveTimeoutMs } from "./http.js";

const PACKAGE_NAME = "@caelo-cms/mcp-server";

/**
 * `/api/mcp/version`'s body. The version must be an exact release: an
 * empty or tag-like value would let bunx resolve `latest`, silently
 * running a shim that does not belong to the admin.
 */
export const adminVersionResponse = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
});

/**
 * Set on the re-exec'd child to the parent's version, so a child that
 * still mismatches fails instead of re-execing forever.
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
    return {
      kind: "error",
      message:
        `re-exec'd from ${args.reexecFrom} to match the admin's ${args.admin}, but this process ` +
        `is ${args.own}. bunx did not resolve ${PACKAGE_NAME}@${args.admin} — check that the ` +
        "release is published and reachable from this machine, then restart the MCP server.",
    };
  }
  return { kind: "reexec", version: args.admin };
}

/** argv for re-running `bin` (with the caller's own args) as `version`. */
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

/**
 * Returns when this process already is the admin's release. Otherwise it
 * runs the matching release as a child and exits with the child's code,
 * or exits 2 with an actionable message — it never returns in those cases.
 */
export async function ensureAdminRelease(opts: {
  readonly adminUrl: string;
  readonly token: string;
  /** The bin to re-run: `caelo-mcp-server` or `caelo-admin-mcp`. */
  readonly bin: string;
}): Promise<void> {
  let body: unknown;
  try {
    body = await postAdmin<unknown>({
      adminUrl: opts.adminUrl,
      token: opts.token,
      path: "/api/mcp/version",
      body: {},
      timeoutMs: resolveTimeoutMs(30_000),
    });
  } catch (e) {
    console.error(
      describeVersionFetchFailure(e instanceof Error ? e.message : String(e), opts.bin),
    );
    process.exit(2);
  }
  const parsed = adminVersionResponse.safeParse(body);
  if (!parsed.success) {
    console.error(
      `/api/mcp/version did not return an exact release (got ${JSON.stringify(body)}) — ` +
        "check that CAELO_ADMIN_URL points at a Caelo admin",
    );
    process.exit(2);
  }
  const admin = parsed.data.version;

  const own = ownVersion();
  const decision = decideHandshake({ own, admin, reexecFrom: process.env[REEXEC_GUARD_ENV] });
  if (decision.kind === "match") return;
  if (decision.kind === "error") {
    console.error(decision.message);
    process.exit(2);
  }

  console.error(`caelo mcp: admin runs ${decision.version}, this shim is ${own} — switching`);
  const [command, ...args] = reexecArgv({
    version: decision.version,
    bin: opts.bin,
    forwardedArgs: process.argv.slice(2),
    bunPath: process.versions.bun ? process.execPath : undefined,
  });
  const child = spawn(command as string, args, {
    stdio: "inherit",
    env: { ...process.env, [REEXEC_GUARD_ENV]: own },
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  const code = await new Promise<number>((resolve) => {
    child.on("error", (e) => {
      console.error(`could not start ${PACKAGE_NAME}@${decision.version}: ${e.message}`);
      resolve(2);
    });
    child.on("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  process.exit(code);
}
