// SPDX-License-Identifier: MPL-2.0

/**
 * #914 — "can this email pass the install's identity gate?" per provider.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  currentIdentityGate,
  emailDomain,
  emailsNeedingSignInClient,
  identityGateFromEnv,
  identityGateMessage,
  parseOrganisationDomains,
  setIdentityGateEnvForTests,
} from "./identity-gate.js";

const NO_CLIENT = { signInClientConfigured: false };
const CLIENT = { signInClientConfigured: true };

afterEach(() => setIdentityGateEnvForTests(null));

describe("identityGateFromEnv", () => {
  it("lets every email through where Caelo does not manage the gate", () => {
    for (const provider of [undefined, "self-hosted", "aws", "azure"]) {
      const gate = identityGateFromEnv({ CAELO_PROVIDER: provider });
      expect(gate.kind).toBe("none");
      expect(gate.check("someone@gmail.com", NO_CLIENT)).toEqual({ ok: true });
    }
  });

  it("on Google IAP admits the organisation's accounts without a sign-in client", () => {
    const gate = identityGateFromEnv({
      CAELO_PROVIDER: "gcp",
      CAELO_GOOGLE_ORG_DOMAIN: "acme.com",
    });
    expect(gate.kind).toBe("google-iap");
    expect(gate.check("Anna@ACME.com", NO_CLIENT)).toEqual({ ok: true });
  });

  it("refuses an outside account without a sign-in client, naming the next step", () => {
    const gate = identityGateFromEnv({
      CAELO_PROVIDER: "gcp-firebase",
      CAELO_GOOGLE_ORG_DOMAIN: "acme.com",
    });
    const v = gate.check("katja@gmail.com", NO_CLIENT);
    expect(v).toMatchObject({ ok: false, code: "outside-organisation" });
    if (v.ok) throw new Error("expected a refusal");
    expect(v.reason).toContain("acme.com");
    expect(v.reason).toContain("You don't have access");
    expect(v.nextStep).toContain("/settings/google-sign-in");
    expect(identityGateMessage(v)).toContain("Next step: Set up Google sign-in first");
  });

  it("admits any account once the sign-in client is configured", () => {
    const gate = identityGateFromEnv({
      CAELO_PROVIDER: "gcp",
      CAELO_GOOGLE_ORG_DOMAIN: "acme.com",
    });
    expect(gate.check("katja@gmail.com", CLIENT)).toEqual({ ok: true });
  });

  it("refuses loudly when the organisation is unknown or absent", () => {
    const unknown = identityGateFromEnv({ CAELO_PROVIDER: "gcp" });
    expect(unknown.check("anna@acme.com", NO_CLIENT)).toMatchObject({
      ok: false,
      code: "organisation-unknown",
    });
    const none = identityGateFromEnv({ CAELO_PROVIDER: "gcp", CAELO_GOOGLE_ORG_DOMAIN: "none" });
    expect(none.check("anna@acme.com", NO_CLIENT)).toMatchObject({
      ok: false,
      code: "no-organisation",
    });
    expect(unknown.check("anna@acme.com", CLIENT)).toEqual({ ok: true });
  });
});

describe("helpers", () => {
  it("parses the organisation env", () => {
    expect(parseOrganisationDomains(undefined)).toBe("unknown");
    expect(parseOrganisationDomains(" ")).toBe("unknown");
    expect(parseOrganisationDomains("NONE")).toBe("none");
    expect(parseOrganisationDomains("Acme.com, acme.de")).toEqual(["acme.com", "acme.de"]);
    expect(emailDomain("a@B.com")).toBe("b.com");
    expect(emailDomain("nope")).toBe("");
  });

  it("lists who needs the sign-in client", () => {
    const gate = identityGateFromEnv({
      CAELO_PROVIDER: "gcp",
      CAELO_GOOGLE_ORG_DOMAIN: "acme.com",
    });
    expect(
      emailsNeedingSignInClient(gate, ["anna@acme.com", "katja@gmail.com", "bo@other.org"]),
    ).toEqual(["katja@gmail.com", "bo@other.org"]);
  });

  it("reads the test override, then process env again", () => {
    setIdentityGateEnvForTests({ CAELO_PROVIDER: "gcp", CAELO_GOOGLE_ORG_DOMAIN: "acme.com" });
    expect(currentIdentityGate().kind).toBe("google-iap");
    setIdentityGateEnvForTests({ CAELO_PROVIDER: "aws" });
    expect(currentIdentityGate().kind).toBe("none");
  });
});
