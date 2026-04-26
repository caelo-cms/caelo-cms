// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  moduleImpactInput,
  revertModuleInput,
  revertPageInput,
  revertSiteInput,
  revertTemplateInput,
  snapshotGetInput,
  snapshotsListInput,
} from "./snapshots.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";

describe("snapshotsListInput", () => {
  it("defaults limit to 50 when omitted", () => {
    const r = snapshotsListInput.safeParse({});
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.limit).toBe(50);
  });

  it("rejects unknown keys (strict)", () => {
    const r = snapshotsListInput.safeParse({ limit: 10, unexpected: 1 });
    expect(r.success).toBe(false);
  });

  it("clamps limit between 1 and 200", () => {
    expect(snapshotsListInput.safeParse({ limit: 0 }).success).toBe(false);
    expect(snapshotsListInput.safeParse({ limit: 201 }).success).toBe(false);
    expect(snapshotsListInput.safeParse({ limit: 200 }).success).toBe(true);
  });

  it("accepts an ISO timestamp for `before`", () => {
    const r = snapshotsListInput.safeParse({ before: "2026-04-26T10:00:00.000Z" });
    expect(r.success).toBe(true);
  });
});

describe("revert input schemas", () => {
  it("revertSiteInput requires a uuid snapshotId", () => {
    expect(revertSiteInput.safeParse({ snapshotId: UUID }).success).toBe(true);
    expect(revertSiteInput.safeParse({ snapshotId: "not-a-uuid" }).success).toBe(false);
  });

  it("revertModuleInput requires both moduleId and snapshotId", () => {
    expect(revertModuleInput.safeParse({ moduleId: UUID, snapshotId: UUID_2 }).success).toBe(true);
    expect(revertModuleInput.safeParse({ moduleId: UUID }).success).toBe(false);
  });

  it("rejects unknown keys on revertPageInput", () => {
    const r = revertPageInput.safeParse({
      pageId: UUID,
      snapshotId: UUID_2,
      extra: "noop",
    });
    expect(r.success).toBe(false);
  });

  it("revertTemplateInput rejects an unknown key", () => {
    const r = revertTemplateInput.safeParse({
      templateId: UUID,
      snapshotId: UUID_2,
      extra: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe("get / impact inputs", () => {
  it("snapshotGetInput accepts a uuid", () => {
    expect(snapshotGetInput.safeParse({ snapshotId: UUID }).success).toBe(true);
  });
  it("moduleImpactInput accepts a uuid and rejects other keys", () => {
    expect(moduleImpactInput.safeParse({ moduleId: UUID }).success).toBe(true);
    expect(moduleImpactInput.safeParse({ moduleId: UUID, foo: 1 }).success).toBe(false);
  });
});
