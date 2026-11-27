// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 (docs/dev/external-plugin-brokers.md §4.4, Q10) — the sandbox's
 * slot pools and per-kind budgets, against the real Deno child: background
 * work (a worker, a journal batch) never takes the slots a chat or an
 * editor preview waits on, a full pool makes a caller wait (bounded)
 * instead of failing at once, and every kind runs under the same Deno
 * permissions.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContext, PluginManifest } from "@caelo-cms/plugin-sdk";
import { sandboxKindOf } from "./external-plugin.js";
import { SANDBOX_KIND, type SandboxKind } from "./sandbox-kind.js";
import {
  buildIsolatedBundle,
  runSandbox,
  runSandboxWithBundler,
  SANDBOX_BUDGETS,
  SANDBOX_POOLS,
  sandboxSlotsInUse,
} from "./sandbox-runtime.js";

const manifest: PluginManifest = {
  slug: "pool-probe",
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["run"],
  hasStaticRender: false,
  hasBuildData: false,
  hasDeferrals: false,
  hasContentVariants: false,
  hasLinkResolve: false,
  hasShareImages: false,
  hasListResolve: false,
};
const context: PluginContext = {
  query: {
    insert: async () => ({ id: "1" }),
    list: async () => [],
    update: async () => {},
    updateMany: async () => {},
    delete: async () => {},
    compareAndSwap: async () => true,
  },
  api: { list: async () => [], get: async () => null },
  theme: { tokens: {} },
  visitor: { id: null, publicUserId: null, ipHash: "", sessionToken: null },
  captcha: { requireProof: async () => true },
  invocation: { origin: "worker", actorId: "plugin-actor" },
};

function run(body: string, kind: SandboxKind, timeoutMs?: number) {
  return runSandbox({
    source: `export default {slug:"pool-probe",version:"1.0.0",tier:2,operations:{run:async(ctx,args)=>{${body}}}};`,
    manifest,
    operation: "run",
    args: {},
    context,
    authorize: async () => {},
    kind,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

const sleep = (ms: number) => `await new Promise((r) => setTimeout(r, ${ms})); return "slept";`;

describe("sandbox pools (#1729 Q10)", () => {
  it("has the decided budgets and pools", () => {
    expect(SANDBOX_POOLS).toEqual({
      interactive: { slots: 4, waitMs: 2_000 },
      background: { slots: 2, waitMs: 30_000 },
    });
    expect(SANDBOX_BUDGETS.preview).toMatchObject({ pool: "interactive", timeoutMs: 5_000 });
    expect(SANDBOX_BUDGETS.build).toMatchObject({ pool: "interactive", timeoutMs: 60_000 });
    expect(SANDBOX_BUDGETS.worker).toMatchObject({ pool: "background", timeoutMs: 240_000 });
    expect(SANDBOX_BUDGETS.journal).toMatchObject({ pool: "background", timeoutMs: 60_000 });
    expect(SANDBOX_BUDGETS.rebuild).toMatchObject({ pool: "background", timeoutMs: 120_000 });
  });

  it("a full background pool never delays an interactive call", async () => {
    const workers = [run(sleep(1500), "worker"), run(sleep(1500), "worker")];
    // Both background slots are taken while the chat's call runs.
    await new Promise((r) => setTimeout(r, 200));
    expect(sandboxSlotsInUse().background).toBe(2);
    const started = performance.now();
    expect(await run('return "chat"', "interactive")).toBe("chat");
    expect(performance.now() - started).toBeLessThan(1200);
    expect(await Promise.all(workers)).toEqual(["slept", "slept"]);
    expect(sandboxSlotsInUse()).toEqual({ interactive: 0, background: 0 });
  });

  it("a third background call waits for a slot instead of failing", async () => {
    const results = await Promise.all([
      run(sleep(600), "worker"),
      run(sleep(600), "journal"),
      run('return "waited"', "rebuild"),
    ]);
    expect(results).toEqual(["slept", "slept", "waited"]);
    expect(sandboxSlotsInUse().background).toBe(0);
  });

  it("an interactive caller that finds every slot taken for its wait gets SandboxBusy", async () => {
    const holders = Array.from({ length: 4 }, () => run(sleep(3000), "interactive"));
    await new Promise((r) => setTimeout(r, 200));
    await expect(run('return "late"', "interactive")).rejects.toThrow(
      /SandboxBusy: all 4 interactive sandbox slots stayed taken for 2 s/,
    );
    expect(await Promise.all(holders)).toEqual(["slept", "slept", "slept", "slept"]);
    expect(sandboxSlotsInUse().interactive).toBe(0);
  });

  it("a worker's endless loop ends at its budget and frees its slot", async () => {
    await expect(run("while (true) {}", "worker", 300)).rejects.toThrow("SandboxTimeout");
    expect(sandboxSlotsInUse().background).toBe(0);
  });

  it("every kind runs under the same Deno permissions (adversarial)", async () => {
    // Past the validator (which refuses these spellings): the child's own
    // --deny-* flags must hold for every kind on their own.
    for (const kind of ["worker", "journal", "rebuild", "preview", "batch"] as const) {
      for (const attempt of [
        'try { await globalThis["fetch"]("https://example.com"); return "escaped"; } catch { return "denied"; }',
        'try { return globalThis["De"+"no"].readTextFileSync("/etc/passwd"); } catch { return "denied"; }',
      ]) {
        expect(
          await runSandboxWithBundler(
            {
              source: `export default {slug:"pool-probe",version:"1.0.0",tier:2,operations:{run:async(ctx,args)=>{${attempt}}}};`,
              manifest,
              operation: "run",
              args: {},
              context,
              authorize: async () => {},
              kind,
            },
            buildIsolatedBundle,
          ),
        ).toBe("denied");
      }
    }
  });

  it("a source the validator refuses is refused again, never cached as a bundle", async () => {
    const bad = () =>
      runSandbox({
        source: 'import fs from "node:fs"; export default {};',
        manifest,
        operation: "run",
        args: {},
        context,
        authorize: async () => {},
      });
    await expect(bad()).rejects.toThrow("SandboxSourceRejected");
    await expect(bad()).rejects.toThrow("SandboxSourceRejected");
  });
});

describe("sandboxKindOf", () => {
  const at = (invocation: PluginContext["invocation"], extra = {}) =>
    sandboxKindOf({ ...context, ...extra, invocation });
  it("derives the kind from the origin, and a caller's mark wins", () => {
    expect(at({ origin: "worker", actorId: "a" })).toBe("worker");
    expect(at({ origin: "batch", actorId: "a", batchRunId: "r" })).toBe("batch");
    expect(at({ origin: "render", actorId: "a", renderId: "pass" })).toBe("preview");
    expect(at({ origin: "render", actorId: "a" })).toBe("build");
    expect(at({ origin: "chat", actorId: "a", chatBranchId: "b" })).toBe("interactive");
    expect(at({ origin: "system", actorId: "a" }, { [SANDBOX_KIND]: "journal" })).toBe("journal");
  });
});
