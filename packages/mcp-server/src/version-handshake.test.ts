// SPDX-License-Identifier: MPL-2.0

/** #764 — the shim matches its release to the admin's instead of the command pinning it. */

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import pkg from "../package.json";
import {
  adminVersionResponse,
  decideHandshake,
  describeVersionFetchFailure,
  ensureAdminRelease,
  type HandshakeIo,
  handshakeUrlProblem,
  ownVersion,
  REEXEC_GUARD_ENV,
  type ReexecChild,
  reexecArgv,
} from "./version-handshake.js";

describe("decideHandshake", () => {
  it("runs as-is when the releases match", () => {
    expect(decideHandshake({ own: "0.10.50", admin: "0.10.50", reexecFrom: undefined })).toEqual({
      kind: "match",
    });
  });

  it("re-execs as the admin's release in either direction", () => {
    expect(decideHandshake({ own: "0.10.50", admin: "0.10.52", reexecFrom: undefined })).toEqual({
      kind: "reexec",
      version: "0.10.52",
    });
    expect(decideHandshake({ own: "0.10.52", admin: "0.10.50", reexecFrom: undefined })).toEqual({
      kind: "reexec",
      version: "0.10.50",
    });
  });

  it("fails instead of looping when the admin changed release during the switch", () => {
    // The parent saw 0.10.51 and started that release; the admin now reports 0.10.52.
    const d = decideHandshake({ own: "0.10.51", admin: "0.10.52", reexecFrom: "0.10.50" });
    expect(d.kind).toBe("error");
    const message = d.kind === "error" ? d.message : "";
    expect(message).toContain("admin now runs 0.10.52");
    expect(message).toContain("Restart the MCP server");
  });

  it("accepts a re-exec'd child that landed on the admin's release", () => {
    expect(decideHandshake({ own: "0.10.52", admin: "0.10.52", reexecFrom: "0.10.50" }).kind).toBe(
      "match",
    );
  });
});

describe("reexecArgv", () => {
  it("re-runs the same bin and args through the running bun", () => {
    expect(
      reexecArgv({
        version: "0.10.52",
        bin: "caelo-mcp-server",
        forwardedArgs: ["export", "--out", "x"],
        bunPath: "/opt/bun",
      }),
    ).toEqual([
      "/opt/bun",
      "x",
      "--package",
      "@caelo-cms/mcp-server@0.10.52",
      "caelo-mcp-server",
      "export",
      "--out",
      "x",
    ]);
  });

  it("uses bunx from PATH when not running under bun", () => {
    expect(
      reexecArgv({
        version: "1.0.0",
        bin: "caelo-admin-mcp",
        forwardedArgs: [],
        bunPath: undefined,
      }),
    ).toEqual(["bunx", "--package", "@caelo-cms/mcp-server@1.0.0", "caelo-admin-mcp"]);
  });
});

describe("describeVersionFetchFailure", () => {
  it("tells the operator how to pin when the admin predates the handshake", () => {
    expect(describeVersionFetchFailure("HTTP 404: Not Found", "caelo-admin-mcp")).toContain(
      "bunx --package @caelo-cms/mcp-server@<admin release> caelo-admin-mcp",
    );
  });

  it("passes other failures (auth, IAP, network) through", () => {
    expect(describeVersionFetchFailure("HTTP 401: auth_error: token revoked", "x")).toContain(
      "token revoked",
    );
  });
});

describe("adminVersionResponse", () => {
  it("accepts exact releases only — never something bunx would resolve to latest", () => {
    for (const version of ["0.10.50", "1.0.0-rc.1"]) {
      expect(adminVersionResponse.safeParse({ version }).success).toBe(true);
    }
    for (const version of ["", "latest", "^0.10.50", "0.10", "0.10.50 caelo-admin-mcp"]) {
      expect(adminVersionResponse.safeParse({ version }).success).toBe(false);
    }
    expect(adminVersionResponse.safeParse({}).success).toBe(false);
  });
});

it("ownVersion reads the shipped package.json", () => {
  expect(ownVersion()).toBe(pkg.version);
});

describe("handshakeUrlProblem", () => {
  it("accepts https and loopback http", () => {
    for (const url of [
      "https://admin.example.com",
      "http://localhost:4173",
      "http://127.0.0.1:5173",
      "http://[::1]:3000",
    ]) {
      expect(handshakeUrlProblem(url)).toBeNull();
    }
  });

  it("refuses plain http to anything else and names the fix", () => {
    const problem = handshakeUrlProblem("http://admin.example.com/");
    expect(problem).toContain("must use https://");
    expect(problem).toContain("https://admin.example.com");
    expect(handshakeUrlProblem("http://localhost.evil.example")).toContain("must use https://");
  });

  it("refuses something that is not a URL", () => {
    expect(handshakeUrlProblem("admin.example.com")).toContain("not a URL");
  });
});

/** Thrown by the fake `exit` so a test can observe the code. */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

class FakeChild extends EventEmitter implements ReexecChild {
  readonly killed: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }
}

interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

function harness(over: Partial<HandshakeIo> = {}) {
  const logs: string[] = [];
  const spawned: Spawned[] = [];
  const signals = new Map<NodeJS.Signals, () => void>();
  const child = new FakeChild();
  const io: HandshakeIo = {
    fetchAdminVersion: async () => ({ version: "0.10.52" }),
    spawn: (command, args, env) => {
      spawned.push({ command, args, env });
      return child;
    },
    ownVersion: () => "0.10.50",
    env: { HOME: "/home/op" },
    forwardedArgs: ["export"],
    bunPath: "/opt/bun",
    onSignal: (signal, handler) => {
      signals.set(signal, handler);
    },
    log: (line) => {
      logs.push(line);
    },
    exit: (code) => {
      throw new Exited(code);
    },
    ...over,
  };
  const run = (adminUrl = "https://admin.example.com") =>
    ensureAdminRelease({ adminUrl, token: "tok", bin: "caelo-mcp-server" }, io);
  /** Runs the handshake and resolves with the code it exited with. */
  const exitCode = async (adminUrl?: string): Promise<number> => {
    try {
      await run(adminUrl);
    } catch (e) {
      if (e instanceof Exited) return e.code;
      throw e;
    }
    throw new Error("ensureAdminRelease returned instead of exiting");
  };
  /** Waits until the re-exec child has been spawned and its listeners are attached. */
  const spawnedChild = async (): Promise<FakeChild> => {
    for (let i = 0; i < 50 && child.listenerCount("exit") === 0; i++) await Promise.resolve();
    expect(child.listenerCount("exit")).toBe(1);
    return child;
  };
  return { logs, spawned, signals, exitCode, run, spawnedChild };
}

describe("ensureAdminRelease", () => {
  it("returns without spawning when the releases match", async () => {
    const h = harness({ ownVersion: () => "0.10.52" });
    await h.run();
    expect(h.spawned).toHaveLength(0);
  });

  it("exits 2 with the fix when CAELO_ADMIN_URL is plain http to a remote host", async () => {
    let fetched = false;
    const h = harness({
      fetchAdminVersion: async () => {
        fetched = true;
        return { version: "0.10.52" };
      },
    });
    expect(await h.exitCode("http://admin.example.com")).toBe(2);
    expect(fetched).toBe(false);
    expect(h.logs.join("\n")).toContain("must use https://");
  });

  it("exits 2 when the admin cannot be reached", async () => {
    const h = harness({
      fetchAdminVersion: async () => {
        throw new Error("timeout after 20s (override with CAELO_MCP_TIMEOUT_MS)");
      },
    });
    expect(await h.exitCode()).toBe(2);
    expect(h.logs.join("\n")).toContain("could not read the admin's release");
    expect(h.spawned).toHaveLength(0);
  });

  it("exits 2 when the admin answers with something that is not an exact release", async () => {
    const h = harness({ fetchAdminVersion: async () => ({ version: "latest" }) });
    expect(await h.exitCode()).toBe(2);
    expect(h.logs.join("\n")).toContain("did not return an exact release");
    expect(h.spawned).toHaveLength(0);
  });

  it("re-execs as the admin's release with the loop guard and the forwarded args", async () => {
    const h = harness();
    const done = h.exitCode();
    (await h.spawnedChild()).emit("exit", 0, null);
    expect(await done).toBe(0);
    expect(h.spawned).toHaveLength(1);
    const { command, args, env } = h.spawned[0] as Spawned;
    expect([command, ...args]).toEqual([
      "/opt/bun",
      "x",
      "--package",
      "@caelo-cms/mcp-server@0.10.52",
      "caelo-mcp-server",
      "export",
    ]);
    expect(env[REEXEC_GUARD_ENV]).toBe("0.10.50");
    expect(env.HOME).toBe("/home/op");
    expect(h.logs.join("\n")).not.toContain("could not run");
  });

  it("propagates a non-zero child exit with an actionable message", async () => {
    const h = harness();
    const done = h.exitCode();
    (await h.spawnedChild()).emit("exit", 1, null);
    expect(await done).toBe(1);
    expect(h.logs.join("\n")).toContain(
      "could not run @caelo-cms/mcp-server@0.10.52 (exit 1) — check the release is published and the npm registry is reachable",
    );
  });

  it("exits 2 when bun cannot be spawned at all", async () => {
    const h = harness();
    const done = h.exitCode();
    (await h.spawnedChild()).emit("error", new Error("spawn bunx ENOENT"));
    expect(await done).toBe(2);
    expect(h.logs.join("\n")).toContain("could not start @caelo-cms/mcp-server@0.10.52");
  });

  it("forwards shutdown signals to the child without reporting them as failures", async () => {
    const h = harness();
    const done = h.exitCode();
    const child = await h.spawnedChild();
    h.signals.get("SIGTERM")?.();
    expect(child.killed).toEqual(["SIGTERM"]);
    child.emit("exit", null, "SIGTERM");
    expect(await done).toBe(1);
    expect(h.logs.join("\n")).not.toContain("could not run");
  });

  it("fails instead of re-execing again inside a re-exec'd child", async () => {
    const h = harness({ env: { [REEXEC_GUARD_ENV]: "0.10.49" } });
    expect(await h.exitCode()).toBe(2);
    expect(h.spawned).toHaveLength(0);
    expect(h.logs.join("\n")).toContain("Restart the MCP server");
  });
});
