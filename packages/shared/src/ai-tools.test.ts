// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { chatPublishInput, chatSendMessageInput, siteMemoryProposeToolInput } from "./ai-tools.js";
import { moduleUpdateSchema } from "./content.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";

// The per-item shape of update_modules_many (the module-edit tool extends it).
describe("moduleUpdateSchema (update_modules_many item)", () => {
  it("accepts a minimal valid edit", () => {
    const r = moduleUpdateSchema.safeParse({ moduleId: UUID, html: "<p>x</p>" });
    expect(r.success).toBe(true);
  });

  it("rejects unknown keys (.strict)", () => {
    const r = moduleUpdateSchema.safeParse({
      moduleId: UUID,
      html: "<p>x</p>",
      pageId: UUID_2,
    });
    expect(r.success).toBe(false);
  });

  it("rejects oversized html", () => {
    const r = moduleUpdateSchema.safeParse({
      moduleId: UUID,
      html: "x".repeat(300_000),
    });
    expect(r.success).toBe(false);
  });
});

describe("siteMemoryProposeToolInput", () => {
  it("accepts a valid proposal", () => {
    const r = siteMemoryProposeToolInput.safeParse({
      slot: "brand-voice",
      body: "terse",
      rationale: "user repeatedly asks for brevity",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown slot", () => {
    const r = siteMemoryProposeToolInput.safeParse({
      slot: "made-up-slot",
      body: "x",
      rationale: "y",
    });
    expect(r.success).toBe(false);
  });
});

describe("chatSendMessageInput", () => {
  it("accepts a message with chips", () => {
    const r = chatSendMessageInput.safeParse({
      chatSessionId: UUID,
      content: "make these green",
      chips: [{ moduleId: UUID_2, selector: "#hero h1", label: "Hero headline" }],
    });
    expect(r.success).toBe(true);
  });

  it("defaults chips to empty array when omitted", () => {
    const r = chatSendMessageInput.safeParse({ chatSessionId: UUID, content: "hi" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.chips).toEqual([]);
  });
});

describe("chatPublishInput", () => {
  it("requires uuid", () => {
    expect(chatPublishInput.safeParse({ chatSessionId: UUID }).success).toBe(true);
    expect(chatPublishInput.safeParse({ chatSessionId: "not-uuid" }).success).toBe(false);
  });
});
