// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  classifyPluginError,
  inPhase,
  PluginLoadError,
  phaseOf,
  pluginErrorFingerprint,
} from "./runtime-health.js";

const pg = (errno: string, message = "boom") => Object.assign(new Error(message), { errno });

describe("classifyPluginError", () => {
  it("treats infrastructure hiccups as transient in any phase", () => {
    for (const errno of ["08006", "40001", "40P01", "55P03", "57P01", "53300"]) {
      expect(classifyPluginError("provision", new Error("x", { cause: pg(errno) }))).toBe(
        "transient",
      );
      expect(classifyPluginError("activate", pg(errno))).toBe("transient");
    }
    expect(
      classifyPluginError(
        "provision",
        pg("23505", 'duplicate key value violates unique constraint "pg_namespace_nspname_index"'),
      ),
    ).toBe("transient");
    expect(
      classifyPluginError(
        "register",
        Object.assign(new Error("closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" }),
      ),
    ).toBe("transient");
  });

  it("blames the plugin for its own code and Caelo for verify / provision", () => {
    expect(classifyPluginError("activate", new Error("onActivate threw"))).toBe("plugin");
    expect(classifyPluginError("operation", new Error("x"))).toBe("plugin");
    expect(classifyPluginError("render", new Error("x"))).toBe("plugin");
    expect(classifyPluginError("worker", new Error("x"))).toBe("plugin");
    expect(classifyPluginError("register", new Error("tools without capability"))).toBe("plugin");
    expect(classifyPluginError("verify", new Error("signature verification failed"))).toBe("core");
    expect(classifyPluginError("provision", pg("42601", "syntax error"))).toBe("core");
    // A duplicate key on a user table is a real defect, not the catalog race.
    expect(classifyPluginError("provision", pg("23505", 'violates "plugins_slug_key"'))).toBe(
      "core",
    );
  });
});

describe("pluginErrorFingerprint", () => {
  it("folds occurrences that differ only in ids and numbers", () => {
    const a = pluginErrorFingerprint(
      "forms",
      "operation",
      "plugin",
      "row 3f2b1c4d-1111-4222-8333-444455556666 not found after 12 ms",
    );
    const b = pluginErrorFingerprint(
      "forms",
      "operation",
      "plugin",
      "row 9e8d7c6b-aaaa-4bbb-8ccc-ddddeeeeffff not found after 340 ms",
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates plugins, phases, classes and different messages", () => {
    const base = pluginErrorFingerprint("forms", "operation", "plugin", "boom");
    expect(pluginErrorFingerprint("ratings", "operation", "plugin", "boom")).not.toBe(base);
    expect(pluginErrorFingerprint("forms", "render", "plugin", "boom")).not.toBe(base);
    expect(pluginErrorFingerprint("forms", "operation", "transient", "boom")).not.toBe(base);
    expect(pluginErrorFingerprint("forms", "operation", "plugin", "bang")).not.toBe(base);
  });

  it("keeps the SQLSTATE as part of the identity", () => {
    const dup = pluginErrorFingerprint("x", "provision", "core", "[23505] duplicate key");
    const syntax = pluginErrorFingerprint("x", "provision", "core", "[42601] duplicate key");
    expect(dup).not.toBe(syntax);
  });
});

describe("inPhase / phaseOf", () => {
  it("tags a failure with its phase and keeps the innermost tag", async () => {
    const outer = await inPhase("register", () =>
      inPhase("provision", () => {
        throw new Error("ddl failed");
      }),
    ).catch((e) => e);
    expect(outer).toBeInstanceOf(PluginLoadError);
    expect(phaseOf(outer)).toBe("provision");
    expect((outer as Error).message).toBe("ddl failed");
  });

  it("treats an untagged failure as host registration code", () => {
    expect(phaseOf(new Error("x"))).toBe("register");
  });

  it("passes a value through", async () => {
    expect(await inPhase("verify", () => 42)).toBe(42);
  });
});
