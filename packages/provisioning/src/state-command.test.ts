// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import { adcNote } from "./state-command.js";

const result = (ok: boolean): GcloudResult => ({
  ok,
  stdout: ok ? "ya29.token" : "",
  stderr: ok ? "" : "ERROR: Could not automatically determine credentials.",
  exitCode: ok ? 0 : 1,
});

describe("adcNote (#816)", () => {
  it("says nothing when this machine has working ADC", () => {
    const calls: string[] = [];
    expect(
      adcNote((args) => {
        calls.push(args.join(" "));
        return result(true);
      }),
    ).toBeNull();
    expect(calls).toEqual(["auth application-default print-access-token"]);
  });

  it("without ADC, says which commands need it and that upgrade does not", () => {
    const note = adcNote(() => result(false));
    expect(note).toContain("gcloud auth application-default login");
    expect(note).toContain("upgrade, status and backup don't need them");
  });
});
