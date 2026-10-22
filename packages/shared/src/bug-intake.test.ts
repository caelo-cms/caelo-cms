// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 — the install↔intake contract. The fingerprint must merge the
 * same defect across installs and versions while keeping different defects
 * apart; redaction must strip everything personal or secret before a report
 * is queued, without destroying what makes it triageable.
 */

import { describe, expect, it } from "bun:test";
import {
  bugIntakeReport,
  bugIntakeSigningString,
  computeBugFingerprint,
  normalizeBugText,
  redactBugReportFields,
  redactBugText,
} from "./bug-intake.js";

describe("computeBugFingerprint", () => {
  const auto = (whatHappened: string, suspectedTool = "build_page") =>
    computeBugFingerprint({ source: "auto", suspectedTool, title: "x", whatHappened });

  it("merges the same auto-captured error with different ids and values", async () => {
    const a = await auto(
      'Page 7f3c2b9e-1d4a-4e8b-9c0f-2a1b3c4d5e6f not found (slug "pricing", 3 modules)',
    );
    const b = await auto(
      'Page 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d not found (slug "about-us", 12 modules)',
    );
    expect(a).toBe(b);
  });

  it("keeps different tools and different quoted field names apart", async () => {
    expect(await auto("boom", "build_page")).not.toBe(await auto("boom", "edit_module"));
    expect(await auto('Invalid input at "page.slug"')).not.toBe(
      await auto('Invalid input at "page.title"'),
    );
  });

  it("separates AI-filed from auto-captured reports and keys AI reports on the title", async () => {
    const ai = (title: string) =>
      computeBugFingerprint({
        source: "ai",
        suspectedTool: "screenshot_page",
        title,
        whatHappened: "prose",
      });
    expect(await ai("Selector crop ignored")).toBe(await ai("selector crop ignored"));
    expect(await ai("Selector crop ignored")).not.toBe(
      await computeBugFingerprint({
        source: "auto",
        suspectedTool: "screenshot_page",
        title: "Selector crop ignored",
        whatHappened: "Selector crop ignored",
      }),
    );
  });

  it("is a 64-char hex digest the report schema accepts", async () => {
    expect(await auto("boom")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("normalizeBugText", () => {
  it("strips urls, emails, numbers and paths", () => {
    expect(
      normalizeBugText(
        "GET https://acme.com/a?b=1 for jo@acme.com failed after 1500ms at /srv/app/x.ts",
      ),
    ).toBe("get <url> for <email> failed after <n>ms at <path>");
  });
});

describe("redactBugText", () => {
  it("removes contact data, credentials and links", () => {
    const out = redactBugText(
      [
        "Mail max.mustermann@example.de or call +49 30 1234567 / 030 1234567.",
        "Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz0123.",
        "Authorization: Bearer abc.def.ghi-123456",
        'config {"password": "hunter2", "api_key": "k-123"}',
        "Fetched https://kunde.example.de/preise?id=4 from 10.0.0.12",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
      ].join("\n"),
    );
    for (const leaked of [
      "max.mustermann",
      "1234567",
      "sk-ant",
      "ghp_",
      "abc.def.ghi",
      "hunter2",
      "k-123",
      "kunde.example.de",
      "10.0.0.12",
      "eyJhbGci",
    ]) {
      expect(out).not.toContain(leaked);
    }
  });

  it("keeps what makes a report triageable", () => {
    const text =
      "build_page failed in packages/admin-core/src/ai/tools/build-page-handler.ts on 2026-10-20 " +
      "with set_page_module_content_many (version 0.10.55, 42 rows)";
    expect(redactBugText(text)).toBe(text);
  });
});

describe("redactBugReportFields", () => {
  it("redacts every free-text field and caps evidence", () => {
    const out = redactBugReportFields({
      title: "Fails for a@b.de",
      whatHappened: "see https://x.y/z",
      expected: "ok",
      evidence: "y".repeat(9000),
    });
    expect(out.title).toBe("Fails for [email]");
    expect(out.whatHappened).toBe("see [url]");
    expect(out.evidence?.length).toBe(4000);
  });
});

describe("bugIntakeSigningString", () => {
  it("binds method, path, timestamp and body", async () => {
    const base = { method: "post", path: "/v1/reports", timestamp: "1", body: "{}" };
    const s = await bugIntakeSigningString(base);
    expect(s.startsWith("POST\n/v1/reports\n1\n")).toBe(true);
    expect(await bugIntakeSigningString({ ...base, body: "{ }" })).not.toBe(s);
    expect(await bugIntakeSigningString({ ...base, path: "/v1/installs" })).not.toBe(s);
  });
});

describe("bugIntakeReport", () => {
  it("rejects unknown fields so nothing unreviewed rides along", () => {
    const parsed = bugIntakeReport.safeParse({
      protocolVersion: 1,
      reportId: "7f3c2b9e-1d4a-4e8b-9c0f-2a1b3c4d5e6f",
      caeloVersion: "0.10.55",
      fingerprint: "a".repeat(64),
      source: "ai",
      severity: "degraded",
      blockedTask: false,
      suspectedTool: null,
      title: "t",
      whatHappened: "w",
      expected: "e",
      evidence: null,
      siteUrl: "https://leak.example",
    });
    expect(parsed.success).toBe(false);
  });
});
