// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for `resolvePoolMax` (adapter.ts).
 *
 * This is the regression guard for the unset no-op contract: the
 * `DatabaseAdapter` constructor only passes a pool `max` when this resolver
 * returns a number. When neither the explicit `poolMax` option nor the
 * `CAELO_DB_POOL_MAX` env is set — a local dev server; provisioned services set it from their budget (#1254) — it must return
 * `undefined` so the constructor passes no `max`
 * (Bun default 10). A present-but-malformed value fails loud (CLAUDE.md §2)
 * rather than silently re-pooling.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolvePoolMax, resolvePublicPoolMax } from "../adapter.js";

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

  it("returns undefined when no option and no env is set", () => {
    // The load-bearing assertion: undefined => constructor uses the unchanged
    // 1-arg new SQL(url) path => Bun default 10 => unset behaviour unchanged.
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

/** #1254 — the cms_public pool sizes on its own, so the admin's can stay small. */
describe("resolvePublicPoolMax", () => {
  const PUBLIC_KEY = "CAELO_DB_PUBLIC_POOL_MAX";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [ENV_KEY, PUBLIC_KEY]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of [ENV_KEY, PUBLIC_KEY]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("prefers its own option, then its own env, then the all-pools resolution", () => {
    process.env[PUBLIC_KEY] = "4";
    process.env[ENV_KEY] = "9";
    expect(resolvePublicPoolMax(3, 8)).toBe(3);
    expect(resolvePublicPoolMax(undefined, 8)).toBe(4);
    delete process.env[PUBLIC_KEY];
    expect(resolvePublicPoolMax(undefined, 8)).toBe(8);
    expect(resolvePublicPoolMax(undefined, undefined)).toBe(9);
  });

  it("returns undefined when nothing is set (Bun default)", () => {
    expect(resolvePublicPoolMax(undefined, undefined)).toBeUndefined();
  });

  it("throws on a malformed public env instead of using the all-pools value", () => {
    process.env[PUBLIC_KEY] = "1";
    process.env[ENV_KEY] = "9";
    expect(() => resolvePublicPoolMax(undefined, undefined)).toThrow(/CAELO_DB_PUBLIC_POOL_MAX/);
  });
});
