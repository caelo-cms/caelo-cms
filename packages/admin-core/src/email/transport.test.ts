// SPDX-License-Identifier: MPL-2.0

/**
 * #769 — `/forgot` only promises a mail when the transport can actually send
 * one; SMTP/SES build a transport that throws on every send.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { buildEmailTransport, emailDeliveryProblem } from "./transport.js";

describe("emailDeliveryProblem", () => {
  it("names why no mail can go out", () => {
    expect(emailDeliveryProblem({ transport: "none", fromAddress: "", config: {} })).toContain(
      "no email transport",
    );
    expect(emailDeliveryProblem({ transport: "smtp", fromAddress: "a@b.c", config: {} })).toContain(
      "not implemented",
    );
    expect(
      emailDeliveryProblem({ transport: "resend", fromAddress: "a@b.c", config: {} }),
    ).toContain("no API key");
  });

  it("accepts a Resend transport with an API key", () => {
    expect(
      emailDeliveryProblem({
        transport: "resend",
        fromAddress: "a@b.c",
        config: { apiKey: "re_x" },
      }),
    ).toBeNull();
  });
});

describe("the Resend transport", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("passes a mail's headers on (#1432: List-Unsubscribe)", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return Response.json({ id: "m1" });
    }) as unknown as typeof fetch;
    const transport = buildEmailTransport({
      transport: "resend",
      fromAddress: "a@b.c",
      config: { apiKey: "k" },
    });
    await transport?.send({
      to: "r@b.c",
      subject: "s",
      html: "h",
      headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    expect(body.headers).toEqual({ "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });
});
