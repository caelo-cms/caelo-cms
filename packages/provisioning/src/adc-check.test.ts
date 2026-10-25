// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { adcProbeFromResult } from "./adc-check.js";
import type { GcloudResult } from "./gcloud.js";

const failed = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

describe("adcProbeFromResult (#1078)", () => {
  it("a printed token is working ADC", () => {
    expect(adcProbeFromResult({ ok: true, stdout: "ya29.x\n", stderr: "", exitCode: 0 })).toEqual({
      ok: true,
    });
  });

  it("no ADC file reads as missing and names the login", () => {
    const r = adcProbeFromResult(
      failed(
        "ERROR: (gcloud.auth.application-default.print-access-token) Your default credentials were not found. To set up Application Default Credentials, see https://cloud.google.com/docs/authentication/external/set-up-adc for more information.",
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("missing");
    expect(r.error).toContain("No Application Default Credentials");
    expect(r.error).toContain("`gcloud auth application-default login`");
    expect(r.error).not.toContain("\n");
  });

  for (const stderr of [
    "ERROR: (gcloud.auth.application-default.print-access-token) There was a problem refreshing your current auth tokens: ('invalid_grant: reauth related error (invalid_rapt)', {'error': 'invalid_grant', 'error_subtype': 'invalid_rapt'})",
    "ERROR: (gcloud.auth.application-default.print-access-token) Reauthentication failed. cannot prompt during non-interactive execution.",
    "ERROR: (gcloud.auth.application-default.print-access-token) ('invalid_grant: Bad Request', {'error': 'invalid_grant', 'error_description': 'Bad Request'})",
  ]) {
    it(`reads as expired: ${stderr.slice(62, 110)}`, () => {
      const r = adcProbeFromResult(failed(stderr));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("expired");
      expect(r.error).toContain("have expired");
      expect(r.error).toContain("`gcloud auth application-default login`");
      expect(r.error).not.toContain("\n");
    });
  }

  it("any other failure still names the login, with gcloud's line", () => {
    const r = adcProbeFromResult(failed("ERROR: network unreachable"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("error");
    expect(r.error).toContain("network unreachable");
    expect(r.error).toContain("gcloud auth application-default login");
  });
});
