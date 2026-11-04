// SPDX-License-Identifier: MPL-2.0

/**
 * #1337 — the confirmation page of a mail link: served only for a declared
 * link, it reflects nothing of the request, runs only its own pinned
 * script, and changes nothing by being opened.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { declaredMailLink, mailLinkPage, parseMailLinkPath } from "./mail-link.js";

const templates = {
  confirm_subscription: {
    subject: "Confirm",
    body: ["Please confirm."],
    link: { operation: "confirm", label: "Confirm <subscription>", done: 'Done "now"' },
  },
  password_reset: {
    subject: "Reset",
    body: ["Reset."],
    link: {
      operation: "reset_password",
      label: "Set a new password",
      done: "Changed.",
      fields: [{ name: "newPassword", label: "New password", type: "password" as const }],
    },
  },
};

describe("mail-link path and declaration", () => {
  it("parses only well-formed paths", () => {
    expect(parseMailLinkPath("/api/_caelo/mail-link/newsletter/confirm")).toEqual({
      slug: "newsletter",
      operation: "confirm",
    });
    for (const bad of [
      "/api/_caelo/mail-link/newsletter",
      "/api/_caelo/mail-link/News/confirm",
      "/api/_caelo/mail-link/newsletter/confirm/x",
      "/api/_caelo/mail-link/../confirm",
    ]) {
      expect(parseMailLinkPath(bad)).toBeNull();
    }
  });

  it("finds a link only for an operation a template declares", () => {
    expect(declaredMailLink(templates, "confirm")?.label).toBe("Confirm <subscription>");
    expect(declaredMailLink(templates, "unsubscribe")).toBeUndefined();
    expect(declaredMailLink(undefined, "confirm")).toBeUndefined();
  });
});

describe("the page", () => {
  const link = templates.password_reset.link;

  it("escapes the manifest's text and is built without the request", async () => {
    const res = mailLinkPage(
      { slug: "newsletter", operation: "confirm" },
      templates.confirm_subscription.link,
      "req-1",
    );
    const html = await res.text();
    expect(html).toContain("Confirm &lt;subscription&gt;");
    expect(html).toContain('data-done="Done &quot;now&quot;"');
    // The page is built from the route and the manifest only: the request
    // (and so its token) never reaches it.
    expect(mailLinkPage.length).toBe(3);
  });

  it("asks for the declared password fields", async () => {
    const html = await mailLinkPage(
      { slug: "auth", operation: "reset_password" },
      link,
      "r",
    ).text();
    expect(html).toContain('name="newPassword" type="password"');
  });

  it("pins its script and style by hash and leaks no referrer", async () => {
    const res = mailLinkPage({ slug: "auth", operation: "reset_password" }, link, "r");
    const csp = res.headers.get("content-security-policy") ?? "";
    const html = await res.text();
    // The page's own fixed elements, cut out by position (not a tag filter).
    const between = (open: string, close: string) =>
      html.slice(html.indexOf(open) + open.length, html.indexOf(close));
    const script = between("<script>", "</script>");
    const style = between("<style>", "</style>");
    const hash = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
    expect(csp).toContain(`script-src ${hash(script)}`);
    expect(csp).toContain(`style-src ${hash(style)}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // The click calls the ordinary plugin endpoint with JSON; no form POST.
    expect(script).toContain('"/api/plugin/"+slug+"/"+op');
    expect(script).toContain('"Content-Type":"application/json"');
    expect(html).not.toContain("<form method=");
  });
});
