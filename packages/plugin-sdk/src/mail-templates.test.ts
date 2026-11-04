// SPDX-License-Identifier: MPL-2.0

/**
 * #1337 — the manifest checks of mail templates and the shapes an outbox
 * row may carry.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { manifestFromDefinition } from "./index.js";
import { MAIL_RECIPIENT_RE, MAIL_TOKEN_RE, mailLinkPath } from "./mail-templates.js";

const base = {
  slug: "mailer",
  version: "1.0.0",
  tier: 1 as const,
  schema: {},
  operations: { confirm: async () => ({}), other: async () => ({}) },
};

const confirmOp = {
  name: "confirm",
  kind: "write" as const,
  input: z.object({ token: z.string().min(16).max(128) }).strict(),
};

describe("mail templates in the manifest", () => {
  it("accepts a template linking to a public write operation that takes the token", () => {
    const m = manifestFromDefinition({
      ...base,
      requires: ["email"],
      requestedCapabilities: ["email"],
      publicOperations: [confirmOp],
      mailTemplates: {
        confirm_it: {
          subject: "Confirm",
          body: ["Please confirm."],
          link: { operation: "confirm", label: "Confirm", done: "Done." },
        },
      },
    });
    expect(m.mailTemplates?.confirm_it?.link?.operation).toBe("confirm");
  });

  it("refuses templates without requires: [email] and the email capability", () => {
    expect(() =>
      manifestFromDefinition({
        ...base,
        mailTemplates: { note: { subject: "S", body: ["B"] } },
      }),
    ).toThrow(/must declare requires[\s\S]*must request the/);
  });

  it("refuses a link to an operation that is not public, or that does not take the token or a field", () => {
    const def = {
      ...base,
      requires: ["email" as const],
      requestedCapabilities: ["email" as const],
      publicOperations: [confirmOp],
    };
    expect(() =>
      manifestFromDefinition({
        ...def,
        mailTemplates: {
          t: { subject: "S", body: ["B"], link: { operation: "other", label: "L", done: "D" } },
        },
      }),
    ).toThrow(/must target a public write operation/);
    expect(() =>
      manifestFromDefinition({
        ...def,
        mailTemplates: {
          t: {
            subject: "S",
            body: ["B"],
            link: {
              operation: "confirm",
              label: "L",
              done: "D",
              fields: [{ name: "newPassword", label: "New", type: "password" }],
            },
          },
        },
      }),
    ).toThrow(/does not require[\s\S]*newPassword/);
    // A token the operation only accepts is not enough: it must require it.
    expect(() =>
      manifestFromDefinition({
        ...def,
        publicOperations: [
          {
            name: "confirm",
            kind: "write",
            input: z.object({ token: z.string().optional() }).strict(),
          },
        ],
        mailTemplates: {
          t: { subject: "S", body: ["B"], link: { operation: "confirm", label: "L", done: "D" } },
        },
      }),
    ).toThrow(/does not require[\s\S]*token/);
    // A field may not overwrite the token, nor appear twice.
    for (const fields of [
      [{ name: "token", label: "T", type: "password" as const }],
      [
        { name: "p", label: "P", type: "password" as const },
        { name: "p", label: "P", type: "password" as const },
      ],
    ]) {
      expect(() =>
        manifestFromDefinition({
          ...def,
          mailTemplates: {
            t: {
              subject: "S",
              body: ["B"],
              link: { operation: "confirm", label: "L", done: "D", fields },
            },
          },
        }),
      ).toThrow();
    }
  });

  it("allows only plain text: no extra keys, bounded lengths", () => {
    expect(() =>
      manifestFromDefinition({
        ...base,
        requires: ["email"],
        requestedCapabilities: ["email"],
        mailTemplates: {
          t: { subject: "S", body: ["B"], html: "<b>x</b>" } as unknown as {
            subject: string;
            body: string[];
          },
        },
      }),
    ).toThrow();
  });
});

describe("outbox row shapes", () => {
  it("a token cannot carry markup, a host or whitespace", () => {
    expect(MAIL_TOKEN_RE.test("0123456789abcdef0123")).toBe(true);
    expect(MAIL_TOKEN_RE.test("11111111-2222-3333-4444-555555555555")).toBe(true);
    for (const bad of [
      "short",
      "a".repeat(129),
      "abc def ghijklmnopq",
      "//evil.test/aaaaaaaa",
      "<b>aaaaaaaaaaaaaaa</b>",
    ]) {
      expect(MAIL_TOKEN_RE.test(bad)).toBe(false);
    }
  });

  it("a recipient is one address, no header injection", () => {
    expect(MAIL_RECIPIENT_RE.test("a.b+c@example.com")).toBe(true);
    for (const bad of [
      "a@b",
      "a b@c.d",
      "a@b.c\r\nBcc: x@y.z",
      "a@b.c, d@e.f",
      "<a@b.c>",
      "a@b.c;d@e.f",
    ]) {
      expect(MAIL_RECIPIENT_RE.test(bad)).toBe(false);
    }
  });

  it("links go to the gateway's confirmation page", () => {
    expect(mailLinkPath("newsletter", "confirm")).toBe("/api/_caelo/mail-link/newsletter/confirm");
  });
});
