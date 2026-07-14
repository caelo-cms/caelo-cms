// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the pure entity-lease decision logic (issue #264).
 *
 * `evaluateLease` is the clock-injectable core the DB wrapper applies
 * after serializing concurrent callers with `FOR UPDATE`; testing it
 * pure covers the acquire / refresh / expiry-takeover / refuse branches
 * without a Postgres. The concurrent-writer race itself is covered by
 * entity-leases-concurrent-writers.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ENTITY_LEASE_TTL_MS,
  entityLeaseTtlMs,
  evaluateLease,
  siblingLeaseError,
} from "./entity-leases.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");
const TTL = 120_000;

describe("evaluateLease", () => {
  it("acquires when no lease exists", () => {
    const d = evaluateLease({ existing: null, holderKey: "task-a", now: NOW, ttlMs: TTL });
    expect(d.kind).toBe("acquire");
    if (d.kind === "acquire") {
      expect(d.expiresAt.getTime()).toBe(NOW.getTime() + TTL);
    }
  });

  it("refreshes (no-op) when the same holder re-acquires", () => {
    // Parent orchestrator making a sequential second edit, or a subagent
    // re-touching its own entity — extends the TTL, never refused.
    const existing = { holderKey: "task-a", expiresAt: new Date(NOW.getTime() + 30_000) };
    const d = evaluateLease({ existing, holderKey: "task-a", now: NOW, ttlMs: TTL });
    expect(d.kind).toBe("refresh");
    if (d.kind === "refresh") {
      expect(d.expiresAt.getTime()).toBe(NOW.getTime() + TTL);
    }
  });

  it("refuses when a DIFFERENT holder's lease is still live", () => {
    // The core guard: a sibling subagent on the same branch is refused.
    const expiresAt = new Date(NOW.getTime() + 30_000);
    const existing = { holderKey: "task-a", expiresAt };
    const d = evaluateLease({ existing, holderKey: "task-b", now: NOW, ttlMs: TTL });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") {
      expect(d.holder.holderKey).toBe("task-a");
      expect(d.holder.expiresAt).toBe(expiresAt.toISOString());
    }
  });

  it("takes over a DIFFERENT holder's EXPIRED lease (died subagent)", () => {
    // TTL auto-release: a timed-out / crashed subagent never wedges the
    // entity — its lapsed lease is free for the taking.
    const existing = { holderKey: "task-a", expiresAt: new Date(NOW.getTime() - 1) };
    const d = evaluateLease({ existing, holderKey: "task-b", now: NOW, ttlMs: TTL });
    expect(d.kind).toBe("acquire");
    if (d.kind === "acquire") {
      expect(d.expiresAt.getTime()).toBe(NOW.getTime() + TTL);
    }
  });

  it("treats an exactly-at-now expiry as expired (boundary)", () => {
    const existing = { holderKey: "task-a", expiresAt: new Date(NOW.getTime()) };
    const d = evaluateLease({ existing, holderKey: "task-b", now: NOW, ttlMs: TTL });
    expect(d.kind).toBe("acquire");
  });

  it("same holder refreshes even past its own expiry", () => {
    const existing = { holderKey: "task-a", expiresAt: new Date(NOW.getTime() - 5000) };
    const d = evaluateLease({ existing, holderKey: "task-a", now: NOW, ttlMs: TTL });
    expect(d.kind).toBe("refresh");
  });
});

describe("entityLeaseTtlMs", () => {
  it("defaults when the env var is unset", () => {
    expect(entityLeaseTtlMs({})).toBe(DEFAULT_ENTITY_LEASE_TTL_MS);
  });

  it("reads a positive integer override", () => {
    expect(entityLeaseTtlMs({ CAELO_ENTITY_LEASE_TTL_MS: "5000" })).toBe(5000);
  });

  it("falls back to the default for non-numeric / non-positive values", () => {
    expect(entityLeaseTtlMs({ CAELO_ENTITY_LEASE_TTL_MS: "nope" })).toBe(
      DEFAULT_ENTITY_LEASE_TTL_MS,
    );
    expect(entityLeaseTtlMs({ CAELO_ENTITY_LEASE_TTL_MS: "0" })).toBe(DEFAULT_ENTITY_LEASE_TTL_MS);
    expect(entityLeaseTtlMs({ CAELO_ENTITY_LEASE_TTL_MS: "-1" })).toBe(DEFAULT_ENTITY_LEASE_TTL_MS);
  });
});

describe("siblingLeaseError", () => {
  it("builds the structured disjointness-violation payload", () => {
    const holder = { holderKey: "task-a", expiresAt: NOW.toISOString() };
    const e = siblingLeaseError("modules.update", "module", "mod-1", holder);
    expect(e.kind).toBe("SiblingLeaseConflict");
    expect(e.operation).toBe("modules.update");
    expect(e.entityKind).toBe("module");
    expect(e.entityId).toBe("mod-1");
    expect(e.holder).toEqual(holder);
    expect(e.message).toContain("sibling task");
    expect(e.message).toContain("disjointness violation");
  });
});
