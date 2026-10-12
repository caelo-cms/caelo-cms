// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #634 — `ctx.captcha.requireProof` answers from the gateway's verdict,
 * never from a token the plugin (or the visitor, through the plugin) passes,
 * and behaves the same in every NODE_ENV.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { makePluginCaptcha, type VisitorContext } from "./capabilities.js";

function visitor(captcha: VisitorContext["captcha"]): VisitorContext {
  return { visitorId: "11111111-1111-4111-8111-111111111111", sessionToken: null, captcha };
}

const savedEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = savedEnv;
});

describe("makePluginCaptcha (#634)", () => {
  for (const env of ["production", "development", "test"]) {
    it(`[${env}] passes a proof the gateway verified`, async () => {
      process.env.NODE_ENV = env;
      const c = makePluginCaptcha(visitor({ enforced: true, proofVerified: true }));
      expect(await c.requireProof(null)).toBe(true);
    });

    it(`[${env}] refuses an unverified visitor whatever token is passed`, async () => {
      process.env.NODE_ENV = env;
      const c = makePluginCaptcha(visitor({ enforced: true, proofVerified: false }));
      for (const token of [null, "dev", "", "true", "valid"]) {
        expect(await c.requireProof(token)).toBe(false);
      }
    });
  }

  it("passes when the Owner turned the captcha off", async () => {
    const c = makePluginCaptcha(visitor({ enforced: false, proofVerified: false }));
    expect(await c.requireProof(null)).toBe(true);
  });

  it("passes a call that did not come from a visitor (Owner panel, AI, workers)", async () => {
    expect(await makePluginCaptcha().requireProof(null)).toBe(true);
  });
});
