// SPDX-License-Identifier: MPL-2.0

/**
 * #1337 — the confirmation page of a mail link: served only for a declared
 * link, it reflects nothing of the request, runs only its own pinned
 * script, and changes nothing by being opened.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  declaredMailLink,
  isOneClickBody,
  mailLinkOf,
  mailLinkPage,
  parseMailLinkPath,
} from "./mail-link.js";

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
    // The consent decision travels with both requests, like the component kit's.
    expect(script).toContain('"x-caelo-consent"');
    expect(script).toContain("headers:consent()");
    expect(html).not.toContain("<form method=");
  });
});

describe("the unsubscribe link and RFC 8058's body (#1432)", () => {
  const form = "application/x-www-form-urlencoded";
  const bytes = (s: string) => new Response(s).arrayBuffer();

  it("serves the page for a plugin's unsubscribe link as for a template link", () => {
    const mailUnsubscribe = { operation: "unsubscribe", label: "Unsubscribe", done: "Out." };
    expect(mailLinkOf({ mailUnsubscribe }, "unsubscribe")).toEqual(mailUnsubscribe);
    expect(mailLinkOf({ mailTemplates: templates }, "confirm")?.label).toContain("Confirm");
    expect(mailLinkOf({ mailUnsubscribe }, "confirm")).toBeUndefined();
    expect(mailLinkOf(undefined, "unsubscribe")).toBeUndefined();
  });

  it("takes the field in both form encodings", async () => {
    expect(await isOneClickBody(form, await bytes("List-Unsubscribe=One-Click"))).toBe(true);
    expect(
      await isOneClickBody(`${form}; charset=utf-8`, await bytes("List-Unsubscribe=One-Click")),
    ).toBe(true);
    const multipart = new Response(
      (() => {
        const f = new FormData();
        f.set("List-Unsubscribe", "One-Click");
        return f;
      })(),
    );
    expect(
      await isOneClickBody(multipart.headers.get("content-type"), await multipart.arrayBuffer()),
    ).toBe(true);
  });

  it("refuses anything else", async () => {
    expect(await isOneClickBody(form, await bytes("List-Unsubscribe=No"))).toBe(false);
    expect(await isOneClickBody(form, await bytes(""))).toBe(false);
    expect(await isOneClickBody(null, await bytes("List-Unsubscribe=One-Click"))).toBe(false);
    expect(await isOneClickBody("application/json", await bytes("{}"))).toBe(false);
    expect(await isOneClickBody("multipart/form-data", await bytes("not multipart"))).toBe(false);
  });
});
