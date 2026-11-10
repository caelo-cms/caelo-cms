// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — the reporting-job wire format's pure parts: where a job may
 * report (an https origin and nothing else), how a large input is cut into
 * parts (never inside a character), the attempt token and the envelope.
 */

import { describe, expect, it } from "bun:test";
import {
  hashJobToken,
  INLINE_PAYLOAD_CHARS,
  JOB_TIMING,
  jobOrderSchema,
  MAX_REPORT_BODY_BYTES,
  MAX_UPLOAD_CHARS_PER_RUN,
  MAX_UPLOAD_PARTS,
  mintJobToken,
  REPORTING_JOB_KINDS,
  reportEnvelopeSchema,
  reportOrigin,
  reportPath,
  splitIntoParts,
  UPLOAD_PART_CHARS,
} from "../protocol.js";

describe("reportOrigin", () => {
  it("takes a plain https origin, with or without a trailing slash", () => {
    expect(reportOrigin("https://admin.example.com")).toBe("https://admin.example.com");
    expect(reportOrigin("https://admin-abc-ew.a.run.app/")).toBe("https://admin-abc-ew.a.run.app");
  });

  it("refuses anything a credential could be sent to by mistake", () => {
    for (const bad of [
      "http://admin.example.com",
      "https://admin.example.com/api",
      "https://admin.example.com/?x=1",
      "https://user:pw@admin.example.com",
      "https://admin.example.com/#a",
      "ftp://admin.example.com",
      "not a url",
    ]) {
      expect(() => reportOrigin(bad)).toThrow();
    }
  });

  it("allows plain http on loopback only (tests)", () => {
    expect(reportOrigin("http://127.0.0.1:4100")).toBe("http://127.0.0.1:4100");
    expect(() => reportOrigin("http://10.0.0.1:4100")).toThrow();
  });
});

describe("splitIntoParts", () => {
  it("cuts text into parts that join back to it", () => {
    const text = JSON.stringify({ a: "x".repeat(25), b: [1, 2, 3] });
    const parts = splitIntoParts(text, 7);
    expect(parts.join("")).toBe(text);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(7);
  });

  it("never separates the two halves of a surrogate pair", () => {
    // "😀" is one code point, two UTF-16 units; a cut between them would
    // leave lone halves the database cannot store.
    const text = `ab😀cd😀😀e`;
    for (let size = 2; size <= 6; size += 1) {
      const parts = splitIntoParts(text, size);
      expect(parts.join("")).toBe(text);
      for (const p of parts) {
        const last = p.charCodeAt(p.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    }
  });

  it("gives no part for empty text", () => {
    expect(splitIntoParts("", 10)).toEqual([]);
  });

  it("keeps every part's request under the cap, whatever characters the input holds", () => {
    // A part travels as a JSON string: quotes and backslashes double, a
    // unit of U+0800..U+FFFF takes 3 UTF-8 bytes, a surrogate pair 4.
    const envelope = (data: string, part: number) =>
      JSON.stringify({
        subjectId: "00000000-0000-4000-8000-000000001359",
        attempt: 20,
        action: "upload-part",
        payload: { uploadId: "00000000-0000-4000-8000-000000000001", part, data },
      });
    const worst = [
      { label: "three-byte characters", value: "語".repeat(UPLOAD_PART_CHARS + 10) },
      { label: "quotes and backslashes", value: `"\\`.repeat(UPLOAD_PART_CHARS / 2) },
      { label: "emoji", value: "😀".repeat(UPLOAD_PART_CHARS) },
      { label: "escaped control characters", value: "\n\t\u0001".repeat(UPLOAD_PART_CHARS / 4) },
    ];
    for (const { label, value } of worst) {
      const parts = splitIntoParts(JSON.stringify({ value }));
      expect(parts.length, label).toBeGreaterThan(1);
      for (const [i, data] of parts.entries()) {
        const bytes = Buffer.byteLength(envelope(data, i), "utf8");
        expect(bytes, label).toBeLessThanOrEqual(MAX_REPORT_BODY_BYTES);
      }
    }
  });

  it("an upload of the most parts holds what a run may hold", () => {
    expect(MAX_UPLOAD_PARTS * UPLOAD_PART_CHARS).toBeGreaterThanOrEqual(MAX_UPLOAD_CHARS_PER_RUN);
    // An inline input is the envelope's own JSON: at most 3 bytes per unit.
    expect(INLINE_PAYLOAD_CHARS * 3 + 1024).toBeLessThanOrEqual(MAX_REPORT_BODY_BYTES);
  });
});

describe("the attempt token", () => {
  it("is 32 random bytes in base64url, different every time", () => {
    const a = mintJobToken();
    const b = mintJobToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("is stored only as its SHA-256", () => {
    const t = mintJobToken();
    expect(hashJobToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashJobToken(t)).toBe(hashJobToken(t));
    expect(hashJobToken(t)).not.toContain(t);
  });
});

describe("the order and the envelope", () => {
  const order = {
    version: "0.12.0",
    kind: "quality_audit",
    subjectId: "00000000-0000-4000-8000-000000001359",
    attempt: 1,
    token: mintJobToken(),
  } as const;

  it("takes an order with or without the admin's origin", () => {
    expect(jobOrderSchema.safeParse(order).success).toBe(true);
    expect(
      jobOrderSchema.safeParse({ ...order, adminUrl: "https://admin.example.com" }).success,
    ).toBe(true);
  });

  it("refuses an admin URL that is not an origin, a bad token or an unknown kind", () => {
    expect(
      jobOrderSchema.safeParse({ ...order, adminUrl: "https://admin.example.com/elsewhere" })
        .success,
    ).toBe(false);
    expect(jobOrderSchema.safeParse({ ...order, token: "short" }).success).toBe(false);
    expect(jobOrderSchema.safeParse({ ...order, kind: "mystery" }).success).toBe(false);
  });

  it("an input travels inline or in parts, never both", () => {
    const base = { subjectId: order.subjectId, attempt: 1, action: "result" };
    expect(reportEnvelopeSchema.safeParse({ ...base, payload: {} }).success).toBe(true);
    expect(
      reportEnvelopeSchema.safeParse({
        ...base,
        upload: { uploadId: "00000000-0000-4000-8000-0000000000aa", parts: 2 },
      }).success,
    ).toBe(true);
    expect(
      reportEnvelopeSchema.safeParse({
        ...base,
        payload: {},
        upload: { uploadId: "00000000-0000-4000-8000-0000000000aa", parts: 2 },
      }).success,
    ).toBe(false);
  });

  it("every kind has its timing and its path", () => {
    for (const kind of REPORTING_JOB_KINDS) {
      const t = JOB_TIMING[kind];
      // The job renews well inside the lease; the first lease covers a cold start.
      expect(t.renewEverySeconds * 3).toBeLessThanOrEqual(t.leaseSeconds);
      expect(t.firstLeaseSeconds).toBeGreaterThanOrEqual(t.leaseSeconds);
      expect(reportPath(kind)).toBe(`/api/internal/jobs/${kind}/report`);
    }
  });
});
