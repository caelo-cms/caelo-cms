// SPDX-License-Identifier: MPL-2.0

/** The install's upgrade lock (agent/lock.ts) and the agent's settings (agent/config.ts). */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_DB_PORT_DEFAULT, agentConfigFor, agentDbConnection } from "./config.js";
import {
  acquireUpgradeLock,
  UpgradeLockAccessError,
  UpgradeLockHeldError,
  upgradeLockPath,
} from "./lock.js";

describe("acquireUpgradeLock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caelo-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lets one holder in and names it to the next", () => {
    const release = acquireUpgradeLock(dir, "the update agent", { pid: 101, alive: () => true });
    expect(() =>
      acquireUpgradeLock(dir, "`cms-provision upgrade`", { pid: 102, alive: () => true }),
    ).toThrow(/the update agent is running on this install \(pid 101/);
    release();
    release();
    expect(existsSync(upgradeLockPath(dir))).toBe(false);
    acquireUpgradeLock(dir, "`cms-provision upgrade`", { pid: 102, alive: () => true })();
  });

  it("takes over a lock whose process is gone", () => {
    acquireUpgradeLock(dir, "a crashed agent", { pid: 999_999 });
    const release = acquireUpgradeLock(dir, "the update agent", {
      pid: 5,
      alive: (pid) => pid !== 999_999,
    });
    expect(typeof release).toBe("function");
  });

  it("treats an unreadable lock file as held until it is older than any run", () => {
    writeFileSync(upgradeLockPath(dir), "{not json");
    expect(() => acquireUpgradeLock(dir, "the update agent")).toThrow(/unreadable/);
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(upgradeLockPath(dir), old, old);
    expect(() => acquireUpgradeLock(dir, "the update agent")()).not.toThrow();
  });

  it("leaves no temp files behind", () => {
    acquireUpgradeLock(dir, "the update agent")();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("contention is an UpgradeLockHeldError (#804)", () => {
    acquireUpgradeLock(dir, "the update agent", { pid: 101, alive: () => true });
    expect(() => acquireUpgradeLock(dir, "x", { pid: 102, alive: () => true })).toThrow(
      UpgradeLockHeldError,
    );
    writeFileSync(upgradeLockPath(dir), "{not json");
    expect(() => acquireUpgradeLock(dir, "x")).toThrow(UpgradeLockHeldError);
  });

  // Root ignores permission bits, so the EACCES case only runs as a normal user.
  it.skipIf(process.getuid?.() === 0)(
    "a directory it cannot write is an access error naming the lock file, not busy (#804)",
    () => {
      chmodSync(dir, 0o500);
      try {
        let thrown: unknown;
        try {
          acquireUpgradeLock(dir, "the update agent");
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(UpgradeLockAccessError);
        expect((thrown as Error).message).toContain(upgradeLockPath(dir));
        expect((thrown as Error).message).toContain("write access");
        expect((thrown as Error).message).not.toMatch(/running on this install|try again when/i);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it("a missing install directory is an access error, not busy (#804)", () => {
    let thrown: unknown;
    try {
      acquireUpgradeLock(join(dir, "gone"), "the update agent");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UpgradeLockAccessError);
    expect((thrown as Error).message).toContain("does not exist");
  });
});

describe("agentConfigFor", () => {
  const secret = () => "s".repeat(64);

  it("keeps an existing agent's port and password (and re-enables it)", () => {
    const existing = { dbPort: 15433, dbPassword: "p", disabled: true };
    expect(agentConfigFor(existing, { randomSecret: secret, portFree: () => false })).toEqual({
      dbPort: 15433,
      dbPassword: "p",
    });
  });

  it("takes the first free loopback port from the default", () => {
    const busy = new Set([AGENT_DB_PORT_DEFAULT, AGENT_DB_PORT_DEFAULT + 1]);
    expect(
      agentConfigFor(undefined, { randomSecret: secret, portFree: (p) => !busy.has(p) }),
    ).toEqual({ dbPort: AGENT_DB_PORT_DEFAULT + 2, dbPassword: secret() });
  });

  it("checks an explicit port and keeps the password when moving", () => {
    expect(() =>
      agentConfigFor(undefined, { requestedPort: 80, randomSecret: secret, portFree: () => true }),
    ).toThrow(/between 1024 and 65535/);
    expect(() =>
      agentConfigFor(undefined, {
        requestedPort: 20000,
        randomSecret: secret,
        portFree: () => false,
      }),
    ).toThrow(/in use/);
    expect(
      agentConfigFor(
        { dbPort: 15432, dbPassword: "keep" },
        { requestedPort: 20000, randomSecret: secret, portFree: () => true },
      ),
    ).toEqual({ dbPort: 20000, dbPassword: "keep" });
  });

  it("logs in as caelo_agent", () => {
    expect(agentDbConnection({ dbPort: 15432, dbPassword: "pw" })).toEqual({
      user: "caelo_agent",
      password: "pw",
      port: 15432,
    });
  });
});
