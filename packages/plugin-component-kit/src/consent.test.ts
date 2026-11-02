// SPDX-License-Identifier: MPL-2.0

/**
 * #1343 — every gateway call the kit makes carries the visitor's consent
 * decision in the header the gateway reads: behind Firebase Hosting no
 * consent cookie reaches it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { VISITOR_CONSENT_HEADER } from "@caelo-cms/plugin-sdk";
import { attachCaptchaProof, CONSENT_HEADER, consentHeaders, postPluginJson } from "./index.js";

const g = globalThis as { caeloConsent?: unknown; fetch: typeof fetch };
const realFetch = g.fetch;

afterEach(() => {
  delete g.caeloConsent;
  g.fetch = realFetch;
});

/** Capture the headers of every fetch the kit makes; captcha answers "disabled". */
function captureFetch(): Headers[] {
  const seen: Headers[] = [];
  g.fetch = (async (url: string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return url === "/api/captcha/challenge"
      ? new Response(null, { status: 204 })
      : Response.json({ ok: true });
  }) as typeof fetch;
  return seen;
}

describe("consent header", () => {
  it("is the header the gateway reads", () => {
    expect(CONSENT_HEADER).toBe(VISITOR_CONSENT_HEADER);
  });

  it("carries what the consent provider states, and nothing without one", () => {
    expect(consentHeaders()).toEqual({});
    g.caeloConsent = { decisionHeader: () => null };
    expect(consentHeaders()).toEqual({});
    g.caeloConsent = { decisionHeader: () => "v=2; granted=necessary,functional" };
    expect(consentHeaders()).toEqual({ [CONSENT_HEADER]: "v=2; granted=necessary,functional" });
  });

  it("rides on plugin posts and on the captcha challenge", async () => {
    g.caeloConsent = { decisionHeader: () => "v=2; granted=functional" };
    const seen = captureFetch();
    expect(await attachCaptchaProof()).toBeNull();
    await postPluginJson("ratings", "submit", {});
    expect(seen.map((h) => h.get(CONSENT_HEADER))).toEqual([
      "v=2; granted=functional",
      "v=2; granted=functional",
    ]);
    expect(seen[1]?.get("content-type")).toBe("application/json");
  });
});
