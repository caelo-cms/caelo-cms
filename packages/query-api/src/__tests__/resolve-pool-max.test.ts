// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for `resolvePoolMax` (adapter.ts).
 *
 * This is the regression guard for the production no-op contract: the
 * `DatabaseAdapter` constructor only passes a pool `{ max }` when this resolver
 * returns a number. When neither the explicit `poolMax` option nor the
 * `CAELO_DB_POOL_MAX` env is set — the production case — it must return
 * `undefined` so the constructor keeps the original 1-arg `new SQL(url)` path
 * (Bun default 10). A present-but-malformed value fails loud (CLAUDE.md §2)
 * rather than silently re-pooling.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolvePoolMax } from "../adapter.js";

const ENV_KEY = "CAELO_DB_POOL_MAX";

describe("resolvePoolMax", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("returns undefined in the production case (no option, no env)", () => {
    // The load-bearing assertion: undefined => constructor uses the unchanged
    // 1-arg new SQL(url) path => Bun default 10 => prod behaviour unchanged.
    expect(resolvePoolMax(undefined)).toBeUndefined();
  });

  it("returns undefined when the env is empty string", () => {
    process.env[ENV_KEY] = "";
    expect(resolvePoolMax(undefined)).toBeUndefined();
  });

  it("passes through a valid explicit option", () => {
    expect(resolvePoolMax(3)).toBe(3);
    expect(resolvePoolMax(10)).toBe(10);
  });

  it("passes through a valid env value", () => {
    process.env[ENV_KEY] = "4";
    expect(resolvePoolMax(undefined)).toBe(4);
  });

  it("prefers the explicit option over the env", () => {
    process.env[ENV_KEY] = "7";
    expect(resolvePoolMax(5)).toBe(5);
  });

  it("throws on max=1 (self-deadlock floor) from either source", () => {
    expect(() => resolvePoolMax(1)).toThrow(/>= 2/);
    process.env[ENV_KEY] = "1";
    expect(() => resolvePoolMax(undefined)).toThrow(/>= 2/);
  });

  it("throws on a malformed env value rather than silently defaulting", () => {
    process.env[ENV_KEY] = "abc";
    expect(() => resolvePoolMax(undefined)).toThrow(/CAELO_DB_POOL_MAX/);
  });

  it("throws on a non-integer value", () => {
    expect(() => resolvePoolMax(2.5)).toThrow(/integer/);
    process.env[ENV_KEY] = "3.5";
    expect(() => resolvePoolMax(undefined)).toThrow(/integer/);
  });
});
