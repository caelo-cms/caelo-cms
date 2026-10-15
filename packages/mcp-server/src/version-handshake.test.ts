// SPDX-License-Identifier: MPL-2.0

/** #764 — the shim matches its release to the admin's instead of the command pinning it. */

import { describe, expect, it } from "bun:test";
import pkg from "../package.json";
import {
  adminVersionResponse,
  decideHandshake,
  describeVersionFetchFailure,
  ownVersion,
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

  it("fails instead of looping when a re-exec still mismatches", () => {
    const d = decideHandshake({ own: "0.10.50", admin: "0.10.52", reexecFrom: "0.10.50" });
    expect(d.kind).toBe("error");
    expect(d.kind === "error" && d.message).toContain("@caelo-cms/mcp-server@0.10.52");
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
