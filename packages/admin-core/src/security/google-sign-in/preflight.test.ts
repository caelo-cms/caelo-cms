// SPDX-License-Identifier: MPL-2.0

/**
 * #967 — the preflight classifies exactly what Google answered live
 * (`recorded-google-oauth.json`, recorded 2026-10-21 without
 * following redirects), and anything else blocks the switch.
 */

import { describe, expect, it } from "bun:test";
import { iapRedirectUri } from "@caelo-cms/shared";
import {
  classifyAuthorizeResponse,
  classifyTokenResponse,
  decodeAuthError,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  type PreflightDeps,
  preflightFailureSummary,
  runClientPreflight,
} from "./preflight.js";

interface RecordedCase {
  request: { clientId: string; redirectUri?: string };
  response: { status: number; location: string | null; body: string };
}

import recorded from "./recorded-google-oauth.json" with { type: "json" };

const live = (name: string): RecordedCase => {
  const c = (recorded.cases as Record<string, RecordedCase>)[name];
  if (!c) throw new Error(`fixture case ${name} missing`);
  return c;
};
const authorize = (name: string) =>
  classifyAuthorizeResponse(live(name).response.status, live(name).response.location);
const token = (name: string) =>
  classifyTokenResponse(live(name).response.status, live(name).response.body);

describe("classifyAuthorizeResponse (recorded Google answers)", () => {
  it("a registered redirect URI leads to Google's sign-in page", () => {
    expect(authorize("authorize_registered_iap_uri")).toEqual({ kind: "registered" });
    expect(authorize("authorize_registered_playground")).toEqual({ kind: "registered" });
  });

  it("an unregistered redirect URI answers redirect_uri_mismatch — in any language", () => {
    expect(authorize("authorize_unregistered_broker_uri")).toEqual({ kind: "not-registered" });
    expect(authorize("authorize_unregistered_iap_uri_playground")).toEqual({
      kind: "not-registered",
    });
    // Without hl=en Google answered in German from a German IP; the code is the same.
    expect(authorize("authorize_unregistered_de_locale")).toEqual({ kind: "not-registered" });
  });

  it("an unknown client answers invalid_client", () => {
    expect(authorize("authorize_unknown_client")).toEqual({ kind: "unknown-client" });
  });

  it("another OAuth refusal is reported with its code, never as registered", () => {
    const v = authorize("authorize_policy_rejected_uri");
    expect(v.kind).toBe("refused");
    expect(v.kind === "refused" && v.code).toBe("invalid_request");
  });

  it("anything unrecognised is unexpected, never registered (fail closed)", () => {
    expect(classifyAuthorizeResponse(200, null).kind).toBe("unexpected");
    expect(classifyAuthorizeResponse(302, "https://evil.example/").kind).toBe("unexpected");
    expect(
      classifyAuthorizeResponse(302, "https://accounts.google.com/some/new/page?x=1").kind,
    ).toBe("unexpected");
    expect(
      classifyAuthorizeResponse(302, "https://accounts.google.com/signin/oauth/error?authError=%%%")
        .kind,
    ).toBe("unexpected");
  });
});

describe("decodeAuthError", () => {
  it("reads code and message from Google's protobuf", () => {
    const loc = new URL(live("authorize_unknown_client").response.location as string);
    expect(decodeAuthError(loc.searchParams.get("authError") as string)).toEqual({
      code: "invalid_client",
      message: "The OAuth client was not found.",
    });
  });

  it("refuses something that is not that shape", () => {
    expect(decodeAuthError(Buffer.from("hello").toString("base64url"))).toBeNull();
  });
});

describe("classifyTokenResponse", () => {
  it("recorded: an unknown client and a wrong secret", () => {
    expect(token("token_unknown_client")).toEqual({ kind: "unknown-client" });
    expect(token("token_wrong_secret")).toEqual({ kind: "wrong-secret" });
  });

  it("a valid pair gets as far as the dummy code: invalid_grant", () => {
    expect(
      classifyTokenResponse(
        400,
        JSON.stringify({ error: "invalid_grant", error_description: "Malformed auth code." }),
      ),
    ).toEqual({ kind: "valid" });
  });

  it("unauthorized_client and anything else fail", () => {
    expect(classifyTokenResponse(401, JSON.stringify({ error: "unauthorized_client" })).kind).toBe(
      "unauthorized-client",
    );
    expect(classifyTokenResponse(400, JSON.stringify({ error: "invalid_request" })).kind).toBe(
      "unexpected",
    );
    expect(classifyTokenResponse(500, "<html>").kind).toBe("unexpected");
    // invalid_grant only counts with a 400.
    expect(classifyTokenResponse(200, JSON.stringify({ error: "invalid_grant" })).kind).toBe(
      "unexpected",
    );
  });
});

const PROJECT = "acme-site";
const BROKER = "https://caelo-production-gateway-bbb-ew.a.run.app/api/mcp/oauth/google-callback";
const CLIENT = "369001918367-t5qrahnqdaasaifvk6akpqkpjk9vli58.apps.googleusercontent.com";

/** A Google that answers with the recorded responses: `registered` decides per URI. */
function google(opts: {
  registered: (uri: string) => boolean;
  token?: { status: number; body: string };
}): PreflightDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.redirect).toBe("manual");
      if (`${url.origin}${url.pathname}` === GOOGLE_AUTHORIZE_URL) {
        const uri = url.searchParams.get("redirect_uri") as string;
        calls.push(`authorize ${uri}`);
        const r = opts.registered(uri)
          ? live("authorize_registered_iap_uri").response
          : live("authorize_unregistered_broker_uri").response;
        return new Response(null, { status: r.status, headers: { location: r.location ?? "" } });
      }
      expect(String(input)).toBe(GOOGLE_TOKEN_URL);
      calls.push("token");
      const t = opts.token ?? {
        status: 400,
        body: JSON.stringify({ error: "invalid_grant", error_description: "Malformed auth code." }),
      };
      return new Response(t.body, { status: t.status });
    }) as typeof fetch,
  };
}

const input = {
  projectId: PROJECT,
  clientId: CLIENT,
  clientSecret: "GOCSPX-not-a-real-secret-123",
  brokerRedirectUri: BROKER,
  consentConfirmed: true,
};

describe("runClientPreflight", () => {
  it("passes a complete client", async () => {
    const r = await runClientPreflight(google({ registered: () => true }), input);
    expect(r.ok).toBe(true);
    expect(r.lines.map((l) => l.id)).toEqual([
      "redirect-uri-broker",
      "redirect-uri-iap",
      "client-secret",
      "consent-screen",
    ]);
  });

  it("#967: refuses a client missing redirect URI 2, naming the URI and where to add it", async () => {
    const g = google({ registered: (uri) => uri === BROKER });
    const r = await runClientPreflight(g, input);
    expect(r.ok).toBe(false);
    const iap = r.lines.find((l) => l.id === "redirect-uri-iap");
    expect(iap?.ok).toBe(false);
    expect(iap?.detail).toContain("IAP error code 9");
    expect(iap?.nextStep).toContain(iapRedirectUri(CLIENT));
    expect(iap?.nextStep).toContain(
      `https://console.cloud.google.com/auth/clients/${encodeURIComponent(CLIENT)}?project=${PROJECT}`,
    );
    // The secret is not probed against an unregistered IAP URI.
    expect(g.calls).not.toContain("token");
    const summary = preflightFailureSummary(r);
    expect(summary.error).toContain("Nothing was stored and Google IAP was not touched.");
    expect(summary.error).not.toContain(input.clientSecret);
  });

  it("#967: refuses a wrong secret", async () => {
    const r = await runClientPreflight(
      google({ registered: () => true, token: live("token_wrong_secret").response }),
      input,
    );
    expect(r.ok).toBe(false);
    const secret = r.lines.find((l) => l.id === "client-secret");
    expect(secret?.ok).toBe(false);
    expect(secret?.nextStep).toContain("Client secrets");
  });

  it("requires the consent-screen confirmation, saying it cannot be checked", async () => {
    const r = await runClientPreflight(google({ registered: () => true }), {
      ...input,
      consentConfirmed: false,
    });
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.id === "consent-screen")?.detail).toContain(
      "no way to check this",
    );
  });

  it("a network failure blocks, never passes", async () => {
    const r = await runClientPreflight(
      {
        fetch: (async () => {
          throw new Error("getaddrinfo ENOTFOUND accounts.google.com");
        }) as unknown as typeof fetch,
      },
      input,
    );
    expect(r.ok).toBe(false);
    expect(r.lines[1]?.detail).toContain("ENOTFOUND");
  });
});
