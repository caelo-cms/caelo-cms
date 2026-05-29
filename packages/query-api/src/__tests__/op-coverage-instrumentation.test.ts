// SPDX-License-Identifier: MPL-2.0

/**
 * Tests for the env-gated op-coverage instrumentation in `defineOperation`
 * (issue #14). Verifies it is a true no-op when `CAELO_OP_COVERAGE` is unset and
 * records exercised op names (transparently, without altering results/errors)
 * when set. Runs in-process / single-file, so the `--isolate` cross-file
 * accumulation is out of scope here — the gate script's union/de-dupe covers
 * that, and `scripts/coverage-check.test.ts` covers the reader.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";
import { defineOperation } from "../operation.js";

const SINK = join(tmpdir(), "caelo-op-coverage-test.jsonl");

function makeDef(name: string) {
  return {
    name,
    actorScope: ["system"] as const,
    database: "cms_admin" as const,
    input: z.object({}),
    output: z.object({}),
    handler: async () => ok({}),
  };
}

const FAKE_TX = {} as never;
const FAKE_CTX = { actorId: "t", actorKind: "system" } as never;

beforeEach(() => {
  process.env.CAELO_OP_COVERAGE_FILE = SINK;
  rmSync(SINK, { force: true });
});

afterEach(() => {
  delete process.env.CAELO_OP_COVERAGE;
  delete process.env.CAELO_OP_COVERAGE_FILE;
  rmSync(SINK, { force: true });
});

describe("defineOperation op-coverage instrumentation", () => {
  it("IU1: returns the definition unchanged when the flag is unset", () => {
    delete process.env.CAELO_OP_COVERAGE;
    const def = makeDef("test.identity_unset");
    const wrapped = defineOperation(def);
    // Identity: same object, same handler reference — zero overhead.
    expect(wrapped).toBe(def);
    expect(wrapped.handler).toBe(def.handler);
  });

  it("IU1b: returns the definition unchanged when the flag is '0'", () => {
    process.env.CAELO_OP_COVERAGE = "0";
    const def = makeDef("test.identity_zero");
    expect(defineOperation(def)).toBe(def);
  });

  it("IU2: under the flag, records the op name and passes the result through", async () => {
    process.env.CAELO_OP_COVERAGE = "1";
    const def = makeDef("test.records_alpha");
    const wrapped = defineOperation(def);
    expect(wrapped).not.toBe(def); // handler is now wrapped

    const result = await wrapped.handler(FAKE_CTX, {}, FAKE_TX);
    expect(result.ok).toBe(true); // return value untouched

    const lines = readFileSync(SINK, "utf8").trim().split("\n");
    expect(lines).toContain("test.records_alpha");
  });

  it("IU3: a handler that throws still records the attempt and the throw propagates", async () => {
    process.env.CAELO_OP_COVERAGE = "1";
    const def = {
      ...makeDef("test.records_thrower"),
      handler: async () => {
        throw new Error("boom");
      },
    };
    const wrapped = defineOperation(def);
    await expect(wrapped.handler(FAKE_CTX, {}, FAKE_TX)).rejects.toThrow("boom");

    const recorded = readFileSync(SINK, "utf8");
    expect(recorded).toContain("test.records_thrower");
  });

  it("IU4: the flag is read at defineOperation call time (hermetic per test)", () => {
    // Not set here (afterEach cleared it) -> identity, proving no leak from
    // the prior flag-on tests.
    const def = makeDef("test.flag_read_at_call");
    expect(defineOperation(def)).toBe(def);
  });
});
