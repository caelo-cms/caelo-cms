// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { redirectTargetIssue, redirectTargetPathSchema } from "./redirect-target.js";

describe("redirectTargetIssue (#657)", () => {
  it.each([
    "/",
    "/a/b",
    "/a/b?c=d#e",
    "/blog/2024/hello-world",
    "/de/preise",
    "/files/report.pdf",
    "/caf%C3%A9",
    "/über-uns",
    "/a//b",
    "/wiki/Special:Search",
    "/foo:bar",
    "/a?next=https://example.com",
  ])("accepts the same-site path %p", (path) => {
    expect(redirectTargetIssue(path)).toBeNull();
  });

  it("rejects a path without a leading slash and says external targets are unsupported", () => {
    const issue = redirectTargetIssue("https://example.com/x");
    expect(issue).toContain("must start with '/'");
    expect(issue).toContain("external (other-domain) redirect targets are not supported");
    expect(redirectTargetIssue("pricing")).toContain("must start with '/'");
  });

  it.each(["//evil.example/x", "//evil.example", "///evil.example/x"])(
    "rejects the protocol-relative %p and suggests a single-slash path",
    (path) => {
      const issue = redirectTargetIssue(path);
      expect(issue).toContain("protocol-relative");
      expect(issue).toContain("'/evil.example");
    },
  );

  it("rejects backslashes, which browsers normalise to '/' (\\/\\host == //host)", () => {
    expect(redirectTargetIssue("/\\evil.example/x")).toContain("backslash");
  });

  it.each(["/\t/evil.example", "/x\ny", "/a b", "/a\u0000b"])(
    "rejects whitespace/control characters in %p",
    (path) => {
      expect(redirectTargetIssue(path)).toContain("whitespace or control characters");
    },
  );

  it.each([
    ["/https://example.com/x", "/x"],
    ["/http://example.com/a/b?c=d#e", "/a/b?c=d#e"],
    ["/HTTPS://Example.com/", "/"],
  ])("rejects the embedded URL %p and suggests its path %p", (path, suggested) => {
    const issue = redirectTargetIssue(path);
    expect(issue).toContain("embeds a full URL");
    expect(issue).toContain(`use its path '${suggested}'`);
    expect(issue).toContain("external (other-domain) redirect targets are not supported");
  });

  it.each(["/https:/example.com/x", "/https:example.com", "/http:"])(
    "rejects a mangled web-scheme first segment %p without a misleading suggestion",
    (path) => {
      const issue = redirectTargetIssue(path);
      expect(issue).toContain("embeds a full URL");
      expect(issue).not.toContain("use its path");
    },
  );

  it.each(["/ftp://files.example/x", "/javascript://x", "/custom+scheme://x"])(
    "rejects any scheme followed by '//' (%p)",
    (path) => {
      expect(redirectTargetIssue(path)).toContain("embeds a full URL");
    },
  );
});

describe("redirectTargetPathSchema", () => {
  it("parses a valid target and carries the actionable message on failure", () => {
    expect(redirectTargetPathSchema.parse("/a/b?c=d#e")).toBe("/a/b?c=d#e");
    const r = redirectTargetPathSchema.safeParse("/https://example.com/x");
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain("use its path '/x'");
  });

  it("keeps the length bounds", () => {
    expect(redirectTargetPathSchema.safeParse("").success).toBe(false);
    expect(redirectTargetPathSchema.safeParse(`/${"a".repeat(500)}`).success).toBe(false);
  });
});
