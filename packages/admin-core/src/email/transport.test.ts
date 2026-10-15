// SPDX-License-Identifier: MPL-2.0

/**
 * #769 — `/forgot` only promises a mail when the transport can actually send
 * one; SMTP/SES build a transport that throws on every send.
 */

import { describe, expect, it } from "bun:test";
import { emailDeliveryProblem } from "./transport.js";

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
