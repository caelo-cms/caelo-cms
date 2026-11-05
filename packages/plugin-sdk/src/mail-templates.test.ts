// SPDX-License-Identifier: MPL-2.0

/**
 * #1337 — the manifest checks of mail templates and the shapes an outbox
 * row may carry.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { manifestFromDefinition } from "./index.js";
import {
  MAIL_RECIPIENT_RE,
  MAIL_TOKEN_RE,
  mailLinkPath,
  mailUnsubscribeRecipient,
} from "./mail-templates.js";

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

describe("the unsubscribe link in the manifest (#1432)", () => {
  const link = { operation: "confirm", label: "Unsubscribe", done: "Out." };
  const mailer = {
    ...base,
    requires: ["email" as const],
    requestedCapabilities: ["email" as const],
    publicOperations: [confirmOp],
    mailUnsubscribe: link,
  };

  it("keeps a link whose operation requires only the token", () => {
    expect(manifestFromDefinition(mailer).mailUnsubscribe).toEqual(link);
  });

  it("needs the mail transport like a template", () => {
    expect(() => manifestFromDefinition({ ...mailer, requires: [] })).toThrow("requires");
    expect(() => manifestFromDefinition({ ...mailer, requestedCapabilities: [] })).toThrow(
      "capability",
    );
  });

  it("must target a public write operation", () => {
    expect(() =>
      manifestFromDefinition({ ...mailer, mailUnsubscribe: { ...link, operation: "other" } }),
    ).toThrow("public write operation");
  });

  it("refuses an operation one-click could not call: a second required field", () => {
    const op = {
      ...confirmOp,
      input: z.object({ token: z.string(), reason: z.string() }).strict(),
    };
    expect(() => manifestFromDefinition({ ...mailer, publicOperations: [op] })).toThrow(
      "nothing else",
    );
  });

  it("refuses an operation that does not require the token", () => {
    const op = { ...confirmOp, input: z.object({ token: z.string().optional() }).strict() };
    expect(() => manifestFromDefinition({ ...mailer, publicOperations: [op] })).toThrow(
      "nothing else",
    );
  });
});

describe("mailUnsubscribeRecipient (#1432)", () => {
  const uuid = "12345678-1234-4234-8234-123456789abc";

  it("reads the recipient of a token of the signed shape, which fits the mail link charset", () => {
    const token = `${uuid}_${"a".repeat(43)}`;
    expect(mailUnsubscribeRecipient(token)).toBe(uuid);
    expect(MAIL_TOKEN_RE.test(token)).toBe(true);
  });

  it("is null for anything else", () => {
    for (const bad of [uuid, `${uuid}_short`, `${uuid}_${"a".repeat(44)}`, ""]) {
      expect(mailUnsubscribeRecipient(bad)).toBeNull();
    }
  });
});
