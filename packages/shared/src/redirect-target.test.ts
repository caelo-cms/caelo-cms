// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  externalRedirectHostIssue,
  externalRedirectProviderIssue,
  externalRedirectTargetIssue,
  isExternalRedirectTarget,
  redirectTargetIssue,
  redirectTargetPathSchema,
  servableRedirectTargetIssue,
} from "./redirect-target.js";

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

  it("rejects a path without a leading slash and points at the approved route", () => {
    const issue = redirectTargetIssue("https://example.com/x");
    expect(issue).toContain("must start with '/'");
    expect(issue).toContain("propose_external_redirect");
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
    expect(issue).toContain("propose_external_redirect");
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

describe("externalRedirectTargetIssue (#1358)", () => {
  it.each([
    "https://calendar.example/",
    "https://calendar.example",
    "https://calendar.example/book/ab12",
    "https://a.b.example/x?gv=true&y=1#top",
    "https://xn--bcher-kva.example/x",
    "https://example.com/caf%C3%A9",
  ])("accepts %p", (url) => {
    expect(externalRedirectTargetIssue(url)).toBeNull();
  });

  it.each([
    ["http://calendar.example/", "https"],
    ["HTTPS://calendar.example/", "https"],
    ["javascript:alert(1)", "https"],
    ["//calendar.example/", "https"],
    ["https:/calendar.example/", "https"],
    ["https://site.example@evil.example/", "credentials"],
    ["https://user:pw@evil.example/", "credentials"],
    ["https://calendar.example:8443/", "port"],
    ["https://127.0.0.1/", "public host"],
    ["https://2130706433/", "public host"],
    ["https://[::1]/", "public host"],
    ["https://localhost/", "public host"],
    ["https://intranet/", "public host"],
    ["https://db.internal/", "public host"],
    ["https://calendar.example/a/../b", "plain form"],
    ["https://calendar.example/a/%2e%2e/b", "plain form"],
    ["https://CALENDAR.example/", "plain form"],
    ["https://cal%65ndar.example/", "plain form"],
    ["https://bücher.example/", "plain form"],
    ["https://calendar.example/a b", "space"],
    ["https://calendar.example/\\evil", "space"],
    ["https://calendar.example/{x}", "space"],
    ["https://calendar.example/\tx", "space"],
    ["https://calendar.example/\nLocation: https://evil.example", "space"],
  ])("refuses %p", (url, why) => {
    expect(externalRedirectTargetIssue(url)).toContain(why);
  });

  it("refuses an address longer than a URL map can hold", () => {
    expect(externalRedirectTargetIssue(`https://a.example/${"x".repeat(1000)}`)).toContain(
      "longer",
    );
  });
});

describe("externalRedirectHostIssue (#1358)", () => {
  const hosts = new Map([
    ["site.example", "this site"],
    ["admin.site.example", "the Caelo admin"],
  ]);

  it("refuses the install's hosts, says which, and passes every other", () => {
    expect(externalRedirectHostIssue("https://site.example/x", hosts)).toContain("is this site");
    expect(externalRedirectHostIssue("https://admin.site.example/", hosts)).toContain("admin");
    expect(externalRedirectHostIssue("https://www.site.example/", hosts)).toBeNull();
  });
});

describe("externalRedirectProviderIssue (#1358)", () => {
  it("serves it on self-hosted and Firebase, query included", () => {
    for (const provider of [undefined, "", "self-hosted", "gcp-firebase"]) {
      expect(externalRedirectProviderIssue("https://a.example/x?y=1#z", provider)).toBeNull();
    }
  });

  it("serves a plain address on gcp and refuses a query or fragment there", () => {
    expect(externalRedirectProviderIssue("https://a.example/x", "gcp")).toBeNull();
    expect(externalRedirectProviderIssue("https://a.example/x?y=1", "gcp")).toContain("query");
    expect(externalRedirectProviderIssue("https://a.example/x#y", "gcp")).toContain("fragment");
    expect(externalRedirectProviderIssue("https://a.example/x?", "gcp")).toContain("query");
    expect(externalRedirectProviderIssue("https://a.example/x#", "gcp")).toContain("fragment");
  });

  it("refuses on aws and azure with the issue, and throws on an unknown provider", () => {
    expect(externalRedirectProviderIssue("https://a.example/", "aws")).toContain("/749");
    expect(externalRedirectProviderIssue("https://a.example/", "azure")).toContain("/750");
    expect(() => externalRedirectProviderIssue("https://a.example/", "x")).toThrow("unknown");
  });
});

describe("the two doors (#1358)", () => {
  it("routine writes refuse an external target, serving accepts the approved form only", () => {
    const url = "https://calendar.example/book";
    expect(isExternalRedirectTarget(url)).toBe(true);
    expect(redirectTargetPathSchema.safeParse(url).success).toBe(false);
    expect(redirectTargetIssue(url)).toContain("propose_external_redirect");
    expect(servableRedirectTargetIssue(url)).toBeNull();
    expect(servableRedirectTargetIssue("/a")).toBeNull();
    expect(servableRedirectTargetIssue("http://calendar.example/")).not.toBeNull();
    expect(servableRedirectTargetIssue("https://a@b.example/")).not.toBeNull();
    expect(servableRedirectTargetIssue("//evil.example/")).not.toBeNull();
  });
});
